/**
 * 手机同步协议：字段定义、校验、时间归一化、出入站序列化。
 *
 * ## 为什么单独一层
 *
 * 两端（Android / Electron）对同一份凭据的字段命名和单位都不一样：
 *
 * | 概念 | fewards（a） | 本工具（b） |
 * | --- | --- | --- |
 * | access token | `token` | `access_token` |
 * | refresh token | `refreshToken` | `refresh_token` |
 * | 过期时间 | **秒**（`currentTimeMillis()/1000+expiresIn`） | **毫秒**（`Date.now()+expiresIn*1000`） |
 *
 * 秒 / 毫秒差 1000 倍，写错不会报错，只会让账号"刚同步完就显示已过期"。所以所有进出
 * 同步通道的时间戳都必须过一遍 {@link toMs}，协议对外统一用毫秒。
 *
 * ## 红线
 *
 * - 任何日志、错误信息、界面字段都不得包含完整 token（本模块只做转换，不打印）。
 * - 不做网络 IO、不读盘，纯函数，便于时序测试。
 */

import { randomInt } from 'node:crypto';

/** 协议版本：字段不兼容变更时递增，两端按此拒绝处理 */
export const PROTOCOL_VERSION = 1;

/**
 * 秒 / 毫秒判定阈值。
 *
 * 当前秒级约 1.8e9、毫秒级约 1.8e12。取 1e11 作为分界：
 * - 小于它只可能是秒（1e11 秒 ≈ 公元 5138 年）
 * - 大于它只可能是毫秒（1e11 毫秒 ≈ 1973 年，早于任何真实凭据）
 */
const SEC_THRESHOLD = 1e11;

/** 单次推送最多携带的账号数：防止误把整个库刷过来，也让请求体可控 */
export const MAX_ACCOUNTS = 200;

/** 请求体大小上限（字节）：200 个账号 × 约 1KB 足够，超出即拒绝 */
export const MAX_BODY_BYTES = 512 * 1024;

/**
 * 时间戳归一化为**毫秒**。
 *
 * 无法判断（0 / 负数 / 非数字）时返回 0，表示"未知"——调用方必须把 0 当作
 * "判断不了"而不是"已过期"，否则会把老数据当死账号处理。
 */
export function toMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < SEC_THRESHOLD ? Math.round(n * 1000) : Math.round(n);
}

/** 毫秒时间戳 → 秒（回传给 a 时用，a 的字段是秒） */
export function toSec(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n / 1000);
}

/** 档位归一化：只认国内版 / 国际版，缺失按国内版处理（a 目前只有国内版） */
export function normalizeVariant(value) {
  const raw = String(value || '').toLowerCase();
  if (raw === 'ai' || raw === 'workbuddy-ai' || raw === 'intl') return 'ai';
  return 'cn';
}

/** 是否为 WorkBuddy 5.6 加密信封（无法取出明文，不能参与同步） */
export function isEnvelope(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value) && '$wbEncrypted' in value);
}

/**
 * 入站账号归一化（a → b）。
 *
 * 兼容 a 的两种历史形态：
 * - 扫码所得：有 uid，access/refresh 都齐；
 * - 手动粘贴：只有 `token`（access），没有 uid / refreshToken。
 *
 * 返回统一结构，字段缺失一律给空串 / 0，调用方无需判空。
 */
export function normalizeIncoming(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const accessToken = String(o.accessToken ?? o.token ?? '').trim();
  const refreshToken = String(o.refreshToken ?? o.refresh_token ?? '').trim();
  return {
    uid: String(o.uid ?? '').trim(),
    label: String(o.label ?? o.nickname ?? '').trim(),
    enterpriseId: String(o.enterpriseId ?? '').trim(),
    variant: normalizeVariant(o.variant),
    accessToken,
    refreshToken,
    /** 毫秒 */
    expiresAt: toMs(o.expiresAt ?? o.expires_at),
    /** a 没有这个字段；缺失为 0 = 未知，b 侧不据此判定过期 */
    refreshExpiresAt: toMs(o.refreshExpiresAt ?? o.refresh_expires_at),
    /** a 扫码 / 导入的时刻（毫秒），用于与 b 的 refreshedAt 比较新旧 */
    obtainedAt: toMs(o.obtainedAt ?? o.obtained_at),
    /** 单调递增的同步版本，缺失按 0（老客户端） */
    version: Number.isFinite(Number(o.version)) ? Math.max(0, Math.trunc(Number(o.version))) : 0,
    device: String(o.device ?? '').trim(),
  };
}

/**
 * 出站序列化（b → a）。
 *
 * 字段名用 a 的命名（`token` / `refreshToken`），时间用**秒**，并在附带的
 * `expiresAtMs` 里保留毫秒原值——a 若改用毫秒可以平滑迁移，不必再改协议。
 *
 * `isCurrent` 告诉 a"这个账号是电脑端正在登录的"，a 的 UI 据此默认不勾选刷新，
 * 否则用户一刷，电脑上的 WorkBuddy 客户端立刻掉登录。
 */
export function serializeAccount(record, { isCurrent = false, version = 0 } = {}) {
  const expiresAtMs = toMs(record?.expiresAt);
  const refreshExpiresAtMs = toMs(record?.refreshExpiresAt);
  return {
    uid: String(record?.uid || record?.id || ''),
    label: String(record?.label || record?.note || record?.nickname || ''),
    enterpriseId: String(record?.enterpriseId || ''),
    variant: normalizeVariant(record?.variant),
    token: typeof record?.access_token === 'string' ? record.access_token : '',
    refreshToken: typeof record?.refresh_token === 'string' ? record.refresh_token : '',
    expiresAt: toSec(expiresAtMs),
    refreshExpiresAt: toSec(refreshExpiresAtMs),
    expiresAtMs,
    refreshExpiresAtMs,
    /** b 侧最近一次刷新时刻，a 可用于展示"凭据新鲜度" */
    refreshedAt: toMs(record?.refreshedAt),
    isCurrent: !!isCurrent,
    version: Math.max(0, Math.trunc(Number(version) || 0)),
  };
}

/**
 * 校验推送请求。
 *
 * 只做结构校验，不做业务裁决（那是 merge 的职责）。返回 `{ ok, error }`，
 * `error` 是**可直接展示给用户**的中文文案（手机端会原样显示）。
 */
export function validatePushRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '请求体不是合法的 JSON 对象' };
  }
  const version = Number(body.version);
  if (Number.isFinite(version) && version > PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `协议版本 ${version} 高于本机支持的 ${PROTOCOL_VERSION}，请升级电脑端控制台后再试`,
    };
  }
  const list = body.accounts;
  if (!Array.isArray(list)) {
    return { ok: false, error: '缺少 accounts 数组' };
  }
  if (list.length === 0) {
    return { ok: false, error: 'accounts 为空，没有可同步的账号' };
  }
  if (list.length > MAX_ACCOUNTS) {
    return { ok: false, error: `一次最多同步 ${MAX_ACCOUNTS} 个账号，本次 ${list.length} 个` };
  }
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a || typeof a !== 'object') {
      return { ok: false, error: `第 ${i + 1} 个账号格式不合法` };
    }
    const hasAccess = String(a.accessToken ?? a.token ?? '').trim();
    const hasRefresh = String(a.refreshToken ?? a.refresh_token ?? '').trim();
    if (!hasAccess && !hasRefresh) {
      return { ok: false, error: `第 ${i + 1} 个账号既没有 accessToken 也没有 refreshToken` };
    }
  }
  return { ok: true, error: '' };
}

/**
 * 配对码比较：长度不同直接失败，长度相同再逐字节异或。
 *
 * 用 `===` 比较会让攻击者按响应时间逐字符猜配对码（局域网内延迟低，完全可行）。
 * 这里没有引入 crypto 依赖，纯 JS 实现足够——配对码只防"同网段误连"，不是长期密钥。
 */
export function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** 生成 8 位数字配对码（纯数字，手机端小键盘输入最省事） */
export function generatePairCode() {
  // 用 crypto 而不是 Math.random：后者在同一进程内可预测，配对码被猜到等于账号库裸奔
  let out = '';
  for (let i = 0; i < 8; i++) out += String(randomInt(0, 10));
  return out;
}
