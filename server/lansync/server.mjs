/**
 * 手机同步的局域网服务（独立端口，默认 57900）。
 *
 * ## 为什么不复用主服务的 57891
 *
 * 主服务上有 `/api/accounts/switch`（能改写 WorkBuddy 登录态文件）、`/v1` 反向代理
 * （能直接消耗账号积分）、整套控制台 UI，而且**全程无鉴权**——它假设只有本机能访问。
 * 把它绑到 0.0.0.0 等于把电脑交给同网段所有人。
 *
 * 所以这里单起一个最小实例：只有 4 个端点，全部围绕"收发凭据"，别的一概没有。
 *
 * ## 端点
 *
 * | 方法 | 路径 | 鉴权 | 用途 |
 * | --- | --- | --- | --- |
 * | GET  | /api/lansync/ping    | 否 | 手机端探测"是否在线 / 是否需要配对" |
 * | POST | /api/lansync/push    | 是 | 手机把账号凭据推过来，回传电脑端最新凭据 |
 * | GET  | /api/lansync/pending | 是 | 手机拉取"电脑刷新过、还没通知手机"的凭据 |
 * | POST | /api/lansync/ack     | 是 | 手机确认收到，出队 |
 *
 * ## 防护
 *
 * - 配对码（Bearer）用常量时间比较，长度不同直接拒；
 * - 每 IP 每分钟 60 次；请求体上限 512KB；单批最多 200 个账号；
 * - 只监听 IPv4 0.0.0.0（IPv6 先不开，减少一处暴露面）。
 */
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadAccounts, saveAccounts, ACCOUNTS_FILE, BACKUP_DIR } from '../workbuddy/accounts.mjs';
import { detectCurrentAccount } from '../workbuddy/auth.mjs';
import { refreshAccessToken } from '../proxy/wb.mjs';
import {
  PROTOCOL_VERSION,
  MAX_BODY_BYTES,
  normalizeIncoming,
  validatePushRequest,
  serializeAccount,
  safeEqual,
  toSec,
} from './protocol.mjs';
import { planMerge, materialize, WRITE_ACTIONS, ACTIONS } from './merge.mjs';
import { listPending, ackPending } from './state.mjs';

/** 单次 push 里允许花在刷新上的时间预算：超过就留给下一次，避免手机端等超时 */
const REFRESH_BUDGET_MS = 25_000;

/** 每 IP 每分钟请求上限 */
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

let running = null;

/** 本机所有可用的局域网 IPv4 地址（给设置页展示"手机该填哪个"） */
export function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const item of list || []) {
      if (item.family !== 'IPv4' || item.internal) continue;
      out.push({ iface: name, address: item.address, cidr: item.cidr || '' });
    }
  }
  return out;
}

/** 当前登录账号的 uid（读不到登录态文件时为 null，不影响同步） */
function currentUidSafe() {
  try {
    const c = detectCurrentAccount();
    return c?.account?.uid || c?.uid || null;
  } catch {
    return null;
  }
}

/** 写账号库前备份一份：手机推来的数据有问题时还能人工回滚 */
function backupAccounts(tag) {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `accounts.${tag || 'lansync'}-${stamp}.json`);
    fs.copyFileSync(ACCOUNTS_FILE, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * 启动同步服务。
 *
 * @param {object}   opts
 * @param {number}   opts.port
 * @param {() => string} opts.getPairCode  动态读配对码（改配对码后无需重启）
 * @param {() => boolean} opts.getRefreshOnPush
 * @param {(msg: string) => void} [opts.onLog]
 * @returns {Promise<{port:number, close:()=>Promise<void>}>}
 */
export async function startLanSync({ port, getPairCode, getRefreshOnPush, onLog = () => {} } = {}) {
  await stopLanSync();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // body 解析失败要给 JSON，而不是 express 默认的 HTML 错误页（手机端解析不了）
  app.use((req, res, next) => {
    express.json({ limit: MAX_BODY_BYTES })(req, res, (err) => {
      if (!err) return next();
      if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: `请求体超过 ${Math.round(MAX_BODY_BYTES / 1024)}KB 上限` });
      }
      return res.status(400).json({ error: '请求体不是合法 JSON' });
    });
  });

  /** 简单滑动窗口限流：手机端正常使用远低于这个频率，超了基本是有人在扫 */
  const hits = new Map();
  app.use((req, res, next) => {
    const ip = String(req.ip || req.socket?.remoteAddress || '');
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || now > rec.reset) {
      hits.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
      return next();
    }
    rec.count += 1;
    if (rec.count > RATE_LIMIT) {
      res.set('Retry-After', String(Math.ceil((rec.reset - now) / 1000)));
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
  });

  const auth = (req, res, next) => {
    const expected = String(getPairCode?.() || '');
    if (!expected) {
      return res.status(503).json({ error: '电脑端尚未设置配对码，请先在设置页生成' });
    }
    const got = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!safeEqual(got, expected)) {
      return res.status(401).json({ error: '配对码不正确' });
    }
    next();
  };

  /* ---------------- 探测（无需配对码） ---------------- */

  app.get('/api/lansync/ping', (req, res) => {
    res.json({
      ok: true,
      app: 'workbuddy-console',
      protocol: PROTOCOL_VERSION,
      // 只回"是否已配对"，绝不回配对码本身
      paired: !!String(getPairCode?.() || ''),
      host: os.hostname(),
      serverTime: Date.now(),
    });
  });

  /* ---------------- 推送 ---------------- */

  app.post('/api/lansync/push', auth, async (req, res) => {
    const checked = validatePushRequest(req.body);
    if (!checked.ok) return res.status(400).json({ error: checked.error });

    const mode = req.body?.mode === 'force' ? 'force' : 'merge';
    const device = String(req.body?.device?.name || 'android').slice(0, 40);
    const remotes = req.body.accounts.map(normalizeIncoming);
    const currentUid = currentUidSafe();
    const locals = loadAccounts();

    const { plans, summary } = planMerge({ remoteAccounts: remotes, localAccounts: locals, currentUid, mode });

    /* 1) 落库（只有 create / adopt 会真正写） */
    const next = locals.slice();
    const touched = [];
    for (const plan of plans) {
      const rec = materialize(plan, { deviceName: device });
      if (!rec) continue;
      const idx = next.findIndex((a) => a?.id === rec.id || (rec.uid && a?.uid === rec.uid));
      if (idx >= 0) next[idx] = rec;
      else next.push(rec);
      touched.push(rec.uid || rec.id);
    }
    if (touched.length) {
      backupAccounts('lansync-push');
      saveAccounts(next);
      onLog(`收到 ${remotes.length} 个账号，写入 ${touched.length} 个（${plans.map((p) => p.action).join(',')}）`);
    }

    /* 2) 按需刷新（可选）。刷新成功后由 proxy/wb.mjs 统一入队回推，这里不重复入队 */
    const wantRefresh = !!getRefreshOnPush?.();
    const deadline = Date.now() + REFRESH_BUDGET_MS;
    const refreshNotes = new Map();

    if (wantRefresh) {
      for (const plan of plans) {
        if (!WRITE_ACTIONS.has(plan.action)) continue;
        const uid = String(plan.remote.uid || plan.localId || '');
        const record = loadAccounts().find((a) => (uid && (a?.uid === uid || a?.id === uid)) || a?.id === plan.localId);
        if (!record) continue;
        if (record.uid && currentUid && String(record.uid) === String(currentUid)) {
          refreshNotes.set(uid, '电脑端正在使用该账号，已跳过刷新');
          continue;
        }
        if (typeof record.refresh_token !== 'string' || !record.refresh_token.trim()) {
          refreshNotes.set(uid, '没有 refresh_token，无法刷新');
          continue;
        }
        if (Date.now() > deadline) {
          refreshNotes.set(uid, '刷新排队中，请稍后再同步一次');
          continue;
        }
        try {
          await refreshAccessToken(record);
        } catch (e) {
          refreshNotes.set(uid, e?.message || '刷新失败');
        }
      }
    }

    /* 3) 回传电脑端最终凭据 —— 这是"一次往返完成双向对齐"的关键 */
    const finalAccounts = loadAccounts();
    const results = plans.map((plan) => {
      const uid = String(plan.remote.uid || plan.localId || '');
      const record =
        finalAccounts.find((a) => uid && (a?.uid === uid || a?.id === uid)) ||
        finalAccounts.find((a) => plan.localId && a?.id === plan.localId) ||
        null;
      return {
        uid,
        action: plan.action,
        reason: plan.reason,
        message: refreshNotes.get(uid) || '',
        risk: plan.risk || '',
        // 找不到记录（例如被 skipped-dead 丢掉）时 account 为 null，手机端跳过即可
        account: record
          ? serializeAccount(record, {
              isCurrent: !!(currentUid && record.uid && String(currentUid) === String(record.uid)),
              version: Number(record.syncVersion) || 0,
            })
          : null,
      };
    });

    res.json({
      ok: true,
      protocol: PROTOCOL_VERSION,
      serverTime: Date.now(),
      mode,
      device,
      summary,
      results,
    });
  });

  /* ---------------- 拉取 / 确认 ---------------- */

  app.get('/api/lansync/pending', auth, (req, res) => {
    const items = listPending();
    res.json({
      ok: true,
      serverTime: Date.now(),
      count: items.length,
      items: items.map((x) => ({
        id: x.id,
        uid: x.uid,
        token: x.accessToken,
        refreshToken: x.refreshToken,
        expiresAt: toSec(x.expiresAt),
        refreshExpiresAt: toSec(x.refreshExpiresAt),
        expiresAtMs: x.expiresAt,
        refreshExpiresAtMs: x.refreshExpiresAt,
        version: x.version,
        at: x.at,
      })),
    });
  });

  app.post('/api/lansync/ack', auth, (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const r = ackPending(ids);
    res.json({ ok: true, ...r });
  });

  /* ---------------- 兜底错误 ---------------- */

  app.use((err, req, res, _next) => {
    console.error('[lansync] 未捕获错误:', err?.message || err);
    res.status(500).json({ error: err?.message || '同步服务内部错误' });
  });

  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // 只绑 IPv4：IPv6 在家庭网络里大多没通，多开一处就多一处风险
    server.listen(Number(port) || 0, '0.0.0.0');
  });

  running = {
    port: server.address()?.port || Number(port),
    server,
  };
  onLog(`手机同步已启动：0.0.0.0:${running.port}`);

  return {
    port: running.port,
    close: () => stopLanSync(),
  };
}

/** 停止同步服务（幂等） */
export async function stopLanSync() {
  if (!running) return;
  const { server } = running;
  running = null;
  await new Promise((resolve) => {
    server.close(() => resolve());
    // 有长连接时 close 会一直等，5 秒后强制断开
    setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch {
        /* 老版本 Node 没有这个方法 */
      }
      resolve();
    }, 5000).unref?.();
  });
}

/** 当前状态（管理接口用） */
export function lanSyncStatus() {
  return {
    running: !!running,
    port: running?.port || null,
    addresses: lanAddresses(),
  };
}

/** 未使用的动作常量导出，避免打包器把 merge 的枚举摇掉后测试对不上 */
export const LAN_SYNC_ACTIONS = ACTIONS;
