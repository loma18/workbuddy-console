/**
 * WorkBuddy 官方上游客户端（反向代理用）。
 *
 * 形态参考 workbuddy2api（Go 实现）逆向出的官方桌面端出站协议：
 * 同一套 chat / models / refresh 端点，靠一组「客户端指纹头」通过网关风控校验。
 * 本模块只做三件事：造头、发请求、刷新 token；不含任何账号调度逻辑。
 *
 * 安全红线：
 * - refresh_token 只出现在 refresh 请求头（X-Refresh-Token），绝不进 chat 请求；
 * - 绝不跨档位请求：国内版只打 copilot.tencent.com，国际版只打 www.workbuddy.ai。
 */
import crypto from 'node:crypto';
import { loadAccounts, saveAccounts, secretValue } from '../workbuddy/accounts.mjs';
import { variantOf } from '../workbuddy/variant.mjs';
import { syncTokensToAuthFile } from '../workbuddy/auth.mjs';
import { notifyTokenRefreshed } from '../lansync/notify.mjs';

/** 出站客户端版本段（对齐官方桌面端分发包，可调） */
const CLIENT_VERSION = '5.5.4';
const CLI_VERSION = '2.137.1';

/**
 * chat 域按档位分流：国内版走 copilot.tencent.com（官网域 www.codebuddy.cn 不放行 /v2/chat），
 * 国际版走 www.workbuddy.ai。
 */
const CHAT_BASE = {
  cn: 'https://copilot.tencent.com',
  ai: 'https://www.workbuddy.ai',
};

const CHAT_PATH = '/v2/chat/completions';
const MODELS_PATH = '/console/enterprises/personal/models';
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';

/** 官网域（Origin / Referer / X-Domain 用） */
const ORIGIN = {
  cn: 'https://www.codebuddy.cn',
  ai: 'https://www.workbuddy.ai',
};

function chatBase(variant) {
  return CHAT_BASE[variant === 'ai' ? 'ai' : 'cn'];
}

function originFor(variant) {
  return ORIGIN[variant === 'ai' ? 'ai' : 'cn'];
}

/** 32 位随机 hex，对齐官方客户端的请求/消息 ID 形状 */
function newId() {
  return crypto.randomBytes(16).toString('hex');
}

/** 按 uid 稳定派生设备/会话标识（跨重启恒定，避免多号被风控按设备漂移关联） */
function stableId(uid, purpose) {
  return crypto.createHash('sha256').update(`wb2a:${purpose}:${uid || ''}`).digest('hex').slice(0, 36);
}

function userAgent(variant) {
  const platform = variant === 'ai' ? 'WorkBuddy AI' : 'WorkBuddy';
  return `WorkBuddy/${CLIENT_VERSION} ${platform}/${CLIENT_VERSION} CLI/${CLI_VERSION}`;
}

/**
 * 组装 chat 出站头。uid/enterpriseId/domain 全部来自账号库，不额外存储副本。
 * isStream 时 Accept 要声明 event-stream，否则上游可能直接返回非流式。
 */
export function chatHeaders(account, { isStream = false } = {}) {
  const variant = variantOf(account).id;
  const token = typeof secretValue(account, 'access_token') === 'string' ? secretValue(account, 'access_token') : '';
  const uid = String(account?.uid || '');
  const origin = originFor(variant);
  const h = {
    'Content-Type': 'application/json',
    Accept: isStream ? 'application/json, text/event-stream' : 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': userAgent(variant),
    'X-CodeBuddy-Request': '1',
    'Accept-Language': variant === 'ai' ? 'en-US' : 'zh-CN',
  };
  if (token) h.Authorization = `Bearer ${token}`;
  else h['X-No-Authorization'] = '1';
  if (uid) {
    h['X-User-Id'] = uid;
    h['X-Machine-ID'] = stableId(uid, 'machine');
    h['X-Session-ID'] = stableId(uid, 'session');
  } else {
    h['X-No-User-Id'] = '1';
  }
  const enterpriseId = String(account?.enterpriseId || '');
  if (variant === 'ai') {
    // 国际版：无企业 ID，显式声明国际域（与 Origin 同域）
    h['X-No-Enterprise-Id'] = '1';
    h['X-Domain'] = 'www.workbuddy.ai';
  } else {
    if (enterpriseId) h['X-Enterprise-Id'] = enterpriseId;
    else h['X-No-Enterprise-Id'] = '1';
    if (account?.domain) h['X-Domain'] = String(account.domain);
    else h['X-No-Department-Info'] = '1';
  }
  // 用量归属：伪装官方桌面端指纹（缺这些头时上游用量归因会显示"网关特征"）
  h['X-Agent-Purpose'] = 'conversation';
  h['X-IDE-Name'] = 'WorkBuddy';
  h['X-IDE-Type'] = 'WorkBuddy';
  h['X-IDE-Version'] = CLIENT_VERSION;
  h['X-Product'] = 'WorkBuddy';
  // 会话头族：一次请求内所有重试复用同一 conversationRequestId
  const reqId = newId();
  h['X-Conversation-Request-ID'] = reqId;
  h['X-Root-Request-ID'] = reqId;
  h['X-Trace-ID'] = reqId;
  h['X-Request-ID'] = newId();
  h['X-Conversation-Message-ID'] = newId();
  h['X-B3-TraceId'] = reqId;
  h['X-B3-SpanId'] = newId().slice(0, 16);
  h['X-B3-Sampled'] = '1';
  return h;
}

/** 刷新 access token（X-Refresh-Token 只允许出现在 refresh 端点） */
function refreshHeaders(account) {
  const variant = variantOf(account).id;
  const origin = originFor(variant);
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: origin,
    Referer: `${origin}/`,
    'User-Agent': userAgent(variant),
    'X-CodeBuddy-Request': '1',
    'X-Refresh-Token': String(secretValue(account, 'refresh_token') || ''),
    'X-Auth-Refresh-Source': 'plugin',
    ...(account?.uid ? { 'X-User-Id': String(account.uid) } : {}),
  };
}

/**
 * 用 refresh_token 换新的 access_token，成功后原子写回账号库。
 * 返回新的 access_token；失败抛错（调用方决定是否换下一个账号）。
 */
export async function refreshAccessToken(account, { timeoutMs = 30_000 } = {}) {
  const refreshToken = secretValue(account, 'refresh_token');
  if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
    throw new Error('该账号没有可用的 refresh_token，需重新扫码登录');
  }
  const variant = variantOf(account).id;
  const res = await fetch(chatBase(variant) + REFRESH_PATH, {
    method: 'POST',
    headers: refreshHeaders(account),
    body: '{}',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* 非 JSON：按状态码处理 */
  }
  if (!res.ok) {
    /**
     * 「refresh token is invalid」是官方最常见的凭据失效态：官方刷新是**轮换式**的，
     * 一次刷新成功后旧 refresh_token 立即作废。账号无论被官方客户端还是本工具刷新过，
     * 另一份副本里的旧值再拿来刷就是这个错。直接把原文抛给用户没有可操作性，这里翻成
     * 「怎么回事 + 怎么办」（2026-10-18 用户反馈：登录莫名失效后点刷新凭据只见这句英文）。
     */
    if (/invalid[_\s-]*(refresh|token)|refresh[_\s-]*token[_\s-]*is[_\s-]*invalid|invalid_grant/i.test(text)) {
      throw new Error(
        'refresh_token 已失效：官方刷新会轮换 token，账号被刷新过一次后旧值就作废了。' +
          '请在 WorkBuddy 里重新登录该账号（或先切到别的账号再切回，让客户端自行续期），然后重新导入到控制台'
      );
    }
    throw new Error(`刷新失败：HTTP ${res.status} ${text.slice(0, 120)}`);
  }
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const access = data?.accessToken || data?.access_token;
  if (!access) throw new Error('刷新失败：响应里没有 accessToken，需重新扫码登录');

  const accounts = loadAccounts();
  const idx = accounts.findIndex((a) => a?.id === account.id || (account.uid && a?.uid === account.uid));
  if (idx >= 0) {
    const target = accounts[idx];
    target.access_token = access;
    if (data?.refreshToken || data?.refresh_token) target.refresh_token = data.refreshToken || data.refresh_token;
    const now = Date.now();
    target.refreshedAt = now;
    const expiresIn = Number(data?.expiresIn ?? data?.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn > 0) target.expiresAt = now + expiresIn * 1000;
    const refreshExpiresIn = Number(data?.refreshExpiresIn ?? data?.refresh_expires_in);
    if (Number.isFinite(refreshExpiresIn) && refreshExpiresIn > 0) target.refreshExpiresAt = now + refreshExpiresIn * 1000;
    saveAccounts(accounts);
    // 官方刷新是轮换式的：旧 refresh_token 已在服务端作废。如果刷新的正是**当前登录账号**，
    // 必须把新凭据写回登录态文件，否则 WorkBuddy 还攥着作废的旧 token，
    // 它下一次自己刷新就会失败 → 用户看到「登录状态莫名失效」（2026-10-18 用户反馈）。
    // 不是当前账号时该函数自己返回 synced:false，什么也不做；同步失败不影响刷新结果。
    try {
      syncTokensToAuthFile(target);
    } catch {
      /* 同步是尽力而为：账号库已更新，登录态文件下次切号时会重写 */
    }
    /**
     * 手机同步：把刚刷出来的新凭据放进待回推队列。
     *
     * 这里是 b 侧**所有**刷新路径的唯一出口（代理临期、定时巡检、手动刷新、切号兜底），
     * 所以挂在这一处就够，不必逐处打补丁。
     *
     * 失败不能影响刷新本身：凭据已经写盘，回推只是"顺便通知手机"，
     * 手机下次主动同步时也能拿到最新值。
     */
    try {
      notifyTokenRefreshed(target, { source: 'refresh' });
    } catch {
      /* 队列写失败不影响刷新结果 */
    }
  }
  return access;
}

/**
 * 拉取某账号可用的模型清单。
 * 官方端点：{chatBase}/console/enterprises/personal/models
 * 返回 `[{ id, name?, ... }]`，失败返回 null（界面按"未知"处理，不阻塞代理）。
 */
export async function fetchUpstreamModels(account, { timeoutMs = 20_000 } = {}) {
  const variant = variantOf(account).id;
  const res = await fetch(chatBase(variant) + MODELS_PATH, {
    method: 'GET',
    headers: chatHeaders(account),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`模型列表获取失败：HTTP ${res.status}`);
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const models = data?.models;
  if (!Array.isArray(models)) return null;
  return models
    .map((m) => (typeof m === 'string' ? { id: m } : { id: String(m?.id || m?.name || '') }))
    .filter((m) => m.id);
}

/**
 * 把一段 SSE 文本聚合成 OpenAI 非流式响应。
 *
 * 官方 chat 端点**只接受流式**（非流式直接 400 `Non-stream chat request is currently
 * not supported`），所以代理对上游恒用 stream=true：调用方要流式就原样透传，
 * 要非流式就在这里把 SSE 流拼回一条完整的 chat.completion。
 */
function aggregateSse(raw, model) {
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let usage = null;
  let id = null;
  let respModel = model;
  /** 上游可能把业务错误塞在 SSE 的某一帧里（code != 0），这类帧必须识别成失败而不是"空回复" */
  let upstreamError = null;
  /** index -> { id, type, function: { name, arguments } } */
  const toolCalls = new Map();

  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      continue;
    }
    if (json.code && Number(json.code) !== 0) {
      upstreamError = `上游 code ${json.code}: ${json.msg || json.message || '未知错误'}`;
    }
    if (json.id) id = json.id;
    if (json.model) respModel = json.model;
    if (json.usage) usage = json.usage;
    for (const c of json.choices || []) {
      const d = c?.delta || {};
      if (typeof d.content === 'string') content += d.content;
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
      if (c?.finish_reason) finishReason = c.finish_reason;
      for (const tc of d.tool_calls || []) {
        const idx = tc?.index ?? 0;
        const cur = toolCalls.get(idx) || { id: tc?.id || '', type: tc?.type || 'function', function: { name: '', arguments: '' } };
        if (tc?.id) cur.id = tc.id;
        if (tc?.function?.name) cur.function.name += tc.function.name;
        if (typeof tc?.function?.arguments === 'string') cur.function.arguments += tc.function.arguments;
        toolCalls.set(idx, cur);
      }
    }
  }

  const calls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (calls.length) message.tool_calls = calls;

  return {
    error: upstreamError,
    text: JSON.stringify({
      id: id || `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: respModel,
      choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason || 'stop' }],
      ...(usage ? { usage } : {}),
    }),
  };
}

/** 上游调用失败（带 HTTP 状态，调用方据此决定刷新 token 还是换号） */
export class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

/** 把一行 SSE 文本解析成语义事件；非数据行返回 null */
function parseSseDataLine(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload) return null;
  if (payload === '[DONE]') return { type: 'done' };
  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    return null;
  }
  // 上游会把业务错误塞进某一帧（code != 0），必须抬成错误事件让调用方换号
  if (json.code && Number(json.code) !== 0) {
    return { type: 'error', message: `上游 code ${json.code}: ${json.msg || json.message || '未知错误'}` };
  }
  const choice = json.choices?.[0];
  const delta = choice?.delta || {};
  return {
    type: 'delta',
    id: json.id || null,
    model: json.model || null,
    content: typeof delta.content === 'string' ? delta.content : '',
    reasoning: typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '',
    toolCalls: Array.isArray(delta.tool_calls) ? delta.tool_calls : [],
    finishReason: choice?.finish_reason || null,
    usage: json.usage || null,
  };
}

/** 逐行消费上游 SSE 字节流，产出语义事件 */
async function* parseSseStream(webStream) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        const ev = parseSseDataLine(line);
        if (ev) yield ev;
      }
    }
    const tail = parseSseDataLine(buf.trim());
    if (tail) yield tail;
  } finally {
    reader.cancel().catch(() => {});
  }
}

/**
 * 打开上游流，返回**逐帧语义事件**的异步迭代器。
 *
 * 与 chatComplete 的分工：chatComplete 面向"整体要一份结果"（OpenAI 端点用，
 * 非流式在本地聚合）；本函数面向"要边收边转"——Anthropic / Responses 两个
 * 协议必须把上游 delta 实时翻译成各自的事件序列，不能等收完再拼。
 *
 * 上游恒以 stream:true 出站（官方 chat 端点不接受非流式）。
 * `signal` 传入客户端请求的中断信号：客户端断开时立刻掐掉上游连接。
 */
export async function openUpstreamStream(account, body, { headerTimeoutMs = 60_000, signal } = {}) {
  const variant = variantOf(account).id;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(new UpstreamError('客户端已断开', 499));
  if (signal) {
    if (signal.aborted) throw new UpstreamError('客户端已断开', 499);
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const headerTimer = setTimeout(
    () => ctrl.abort(new UpstreamError('上游 60 秒未返回响应头', 504)),
    headerTimeoutMs
  );
  let res;
  try {
    res = await fetch(chatBase(variant) + CHAT_PATH, {
      method: 'POST',
      headers: chatHeaders(account, { isStream: true }),
      body: JSON.stringify({ ...body, stream: true }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (signal) signal.removeEventListener('abort', onAbort);
    throw err instanceof UpstreamError ? err : new UpstreamError(err?.message || '上游请求失败', 502);
  } finally {
    clearTimeout(headerTimer);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (signal) signal.removeEventListener('abort', onAbort);
    throw new UpstreamError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  const frames = (async function* run() {
    try {
      yield* parseSseStream(res.body);
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  })();
  return { status: res.status, frames };
}

/**
 * 发一次 chat 请求（上游恒流式；非流式由 aggregateSse 在本地拼回）。
 *
 * 超时分两段，避免"长对话被硬掐"：
 * - `headerTimeoutMs`：只覆盖到**拿到响应头**（默认 60s），上游迟迟不给首字节才算失败；
 * - `totalTimeoutMs`：覆盖整段读取。流式会跑很久（长思考 / 长回答），所以流式默认放宽到
 *   10 分钟；非流式用调用方给的值（默认 120s）。
 * 之前只用一个总超时，流式长响应会在中途被 AbortSignal 掐断，客户端拿到半截 SSE。
 */
export async function chatComplete(account, body, { timeoutMs = 120_000, headerTimeoutMs = 60_000 } = {}) {
  const variant = variantOf(account).id;
  const wantStream = !!body?.stream;
  const upstreamBody = { ...body, stream: true };

  const ctrl = new AbortController();
  const headerTimer = setTimeout(() => ctrl.abort(new Error('上游 60 秒未返回响应头')), headerTimeoutMs);
  let res;
  try {
    res = await fetch(chatBase(variant) + CHAT_PATH, {
      method: 'POST',
      headers: chatHeaders(account, { isStream: true }),
      body: JSON.stringify(upstreamBody),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(headerTimer);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, text, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  if (wantStream) {
    return { ok: true, status: res.status, stream: res.body, headers: res.headers };
  }

  // 非流式：读完整个流再聚合；整段受 timeoutMs 约束（超时就取消上游流）
  const bodyTimer = setTimeout(() => res.body?.cancel?.().catch(() => {}), timeoutMs);
  let raw;
  try {
    raw = await res.text();
  } finally {
    clearTimeout(bodyTimer);
  }

  // 上游在流式模式下也可能直接回一段错误 JSON（非 SSE），这时把错误抬出去
  if (!/^\s*data:|[\r\n]data:/.test(raw)) {
    try {
      const j = JSON.parse(raw);
      if (j?.code && Number(j.code) !== 0) {
        return { ok: false, status: res.status, text: raw, error: `上游 code ${j.code}: ${j.msg || j.message || ''}` };
      }
    } catch {
      /* 非 JSON：按 SSE 聚合处理 */
    }
  }

  const agg = aggregateSse(raw, body.model);
  // SSE 某一帧里带业务错误（code != 0）→ 判为失败，让调用方换号重试而不是返回空回复
  if (agg.error) return { ok: false, status: res.status, text: agg.text, error: agg.error };
  return { ok: true, status: res.status, text: agg.text };
}
