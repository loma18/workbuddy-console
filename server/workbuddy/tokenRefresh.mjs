/**
 * 账号凭据自动刷新（防止"很久没切换的账号"静默失效）。
 *
 * ## 为什么需要
 *
 * 账号库里的 `access_token` / `refresh_token` 都是有有效期的，而**唯一**会去刷新它们的地方是
 * 反向代理处理请求时（`server/proxy/index.mjs`）——而且只在"到期前 60 秒"那个极窄窗口里触发。
 * 于是「既没被切换过、也没走过代理」的账号会一路静默过期，等到想用时只能重新扫码登录。
 *
 * ## 刷新判据（保守优先：宁可少刷，也不把官方服务端当轮换试验田）
 *
 * | 情况 | 动作 |
 * | --- | --- |
 * | access_token 剩余 < 24h | 刷 |
 * | refresh_token 剩余 < 72h | 刷（兜底：refresh 一过期就再也救不回来） |
 * | 两个有效期字段都缺失 | **不刷**（判断不了，别瞎猜） |
 * | refresh_token 已过期 | 不刷，标记 `dead`，界面提示重新登录 |
 * | 没有明文 refresh_token | 不刷，标记需重新扫码 |
 *
 * 只在这三种"已经临期"的时机动手，是为了把**轮换风险**压到最低：如果官方在刷新时轮换
 * refresh_token，我们持有的旧值会失效，而 WorkBuddy 自己的登录态文件里还存着它自己那一份。
 * 频次越高，两方互相踩到的概率越大；临期才刷，实质上只在"反正也要死了"的时刻出手。
 *
 * ## 与其他模块的边界
 *
 * - 刷新动作复用 `server/proxy/wb.mjs` 的 `refreshAccessToken`（它已负责端点、请求头、
 *   原子写回账号库），这里**不重复实现**协议细节。
 * - 日志写在 `~/.wb-switch/token_refresh_logs.json`（本工具私有，与 workbuddy-switch 无交集），
 *   只记结果与到期时间，**绝不记 token**。
 */
import path from 'node:path';
import {
  STORE_DIR,
  loadAccounts,
  accountDisplayName,
  secretValue,
  readJsonFile,
} from './accounts.mjs';
import { variantOf } from './variant.mjs';
import { detectCurrentAccounts } from './auth.mjs';
import { verifyAccountCredential } from './credits.mjs';
import { refreshAccessToken } from '../proxy/wb.mjs';
import { atomicWriteJson } from '../store/config.mjs';

/** access_token 剩余不足这个小时数就刷新 */
export const ACCESS_MIN_HOURS = 24;
/** refresh_token 剩余不足这个小时数就刷新（整条链过期前的最后机会） */
export const REFRESH_MIN_HOURS = 72;
/** 自动巡检对「上次刷新失败」的账号的冷却窗口（期间不再自动重试，只响应手动刷新） */
export const FAILED_COOLDOWN_MS = 24 * 3600 * 1000;

/** 本工具私有的刷新日志（不含任何 token） */
export const REFRESH_LOGS_FILE = path.join(STORE_DIR, 'token_refresh_logs.json');
const LOG_LIMIT = 200;
const HOUR_MS = 3600 * 1000;

/** 时间戳 → 剩余小时数；无法判断时返回 null（而不是 0，两者语义完全不同） */
function hoursLeft(ts, now) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return null;
  return (n - now) / HOUR_MS;
}

/** 明文（非信封）字符串字段 */
function plain(account, key) {
  const v = secretValue(account, key);
  return typeof v === 'string' && v.trim() ? v : '';
}

/**
 * 把"当前账号"参数归一化成 uid 集合。
 *
 * 国内版与国际版各有一份登录态，可能同时是"当前账号"，所以要支持多个 uid。
 * 同时兼容老调用方传单个 `currentUid`（测试与外部模块还在用）。
 */
function uidSetOf(currentUid, currentUids) {
  const set = new Set();
  const add = (v) => {
    if (v != null && String(v)) set.add(String(v));
  };
  add(currentUid);
  for (const v of Array.isArray(currentUids) ? currentUids : currentUids != null ? [currentUids] : []) add(v);
  return set;
}

/**
 * 单个账号的刷新判定。纯函数，便于回归测试直接喂时间戳。
 * 返回 { id, name, variant, accessHours, refreshHours, hasRefreshToken, dead, due, reason }
 */
export function refreshPlanFor(
  account,
  { now = Date.now(), force = false, currentUid = null, currentUids = null } = {}
) {
  const accessHours = hoursLeft(account?.expiresAt, now);
  const refreshHours = hoursLeft(account?.refreshExpiresAt, now);
  const hasRefreshToken = !!plain(account, 'refresh_token');
  const hasAccess = !!plain(account, 'access_token');
  const currentSet = uidSetOf(currentUid, currentUids);

  const base = {
    id: account?.id || '',
    uid: account?.uid || '',
    name: accountDisplayName(account),
    variant: variantOf(account).id,
    accessHours,
    refreshHours,
    hasRefreshToken,
    hasPlainAccess: hasAccess,
    /** 该账号是否就是 WorkBuddy 当前登录账号（登录态由官方客户端自己维护） */
    current: !!(account?.uid && currentSet.has(String(account.uid))),
    dead: false,
    due: false,
    reason: 'ok',
  };

  /**
   * 当前登录账号**不参与自动刷新**（2026-10-18「登录状态莫名失效」的核心修复）。
   *
   * 官方刷新是轮换式的：谁刷谁拿到新 token，另一份立即作废。当前登录账号的登录态文件
   * 由 WorkBuddy 自己在维护，我们每 6 小时拿库里的副本再刷一次，等于把它手里的
   * refresh_token 顶掉——它下次自己刷新就失败，用户看到的就是「莫名其妙登出」。
   * 手动指定该账号（force）仍然允许：那条路径刷新后会把新凭据同步写回登录态文件。
   */
  if (base.current && !force) {
    return { ...base, due: false, reason: 'current' };
  }

  if (!hasRefreshToken) {
    // 只能靠已导入的明文 access_token 撑着：一过期就只能重新扫码。所以**临期就该示警**，
    // 而不是等到真的过期了才说"用不了"——那时用户已经只能重新登录了。
    const dying = accessHours != null && accessHours <= ACCESS_MIN_HOURS;
    return { ...base, dead: dying, due: false, reason: 'no-refresh-token' };
  }
  if (refreshHours != null && refreshHours <= 0) {
    return { ...base, dead: true, reason: 'dead' };
  }
  if (force) return { ...base, due: true, reason: 'manual' };

  if (accessHours != null && accessHours < ACCESS_MIN_HOURS) {
    return { ...base, due: true, reason: 'access-expiring' };
  }
  if (refreshHours != null && refreshHours < REFRESH_MIN_HOURS) {
    return { ...base, due: true, reason: 'refresh-expiring' };
  }
  // 两个有效期都缺失：判断不了，不动它
  if (accessHours == null && refreshHours == null) return { ...base, reason: 'unknown-expiry' };
  return base;
}

/** 全部账号的判定结果（界面用；不含 token）。带上当前登录账号标记与最近一次验活结论 */
export function refreshPlan({ now = Date.now() } = {}) {
  // 两档位各有一份登录态：两个当前账号都要保护，只取一个会顶掉另一档
  const currents = detectCurrentAccounts();
  const currentUids = [currents.cn.uid, currents.ai.uid].filter(Boolean);
  const status = loadCredentialStatus();
  return loadAccounts().map((a) => {
    const plan = refreshPlanFor(a, { now, currentUids });
    return { ...plan, verify: status[plan.id] || null };
  });
}

/** 读取刷新日志（最新在前） */
export function loadRefreshLogs() {
  const rows = readJsonFile(REFRESH_LOGS_FILE, []);
  return Array.isArray(rows) ? rows.slice().reverse() : [];
}

/** 最近一次巡检的汇总（界面用） */
export function lastRefreshRun() {
  const rows = readJsonFile(REFRESH_LOGS_FILE, []);
  if (!Array.isArray(rows) || !rows.length) return null;
  const lastAt = Number(rows[rows.length - 1]?.at) || null;
  const sameRun = rows.filter((r) => r?.at === lastAt);
  return { at: lastAt, refreshed: sameRun.filter((r) => r.ok && r.action === 'refreshed').length };
}

function appendRefreshLogs(entries) {
  const rows = readJsonFile(REFRESH_LOGS_FILE, []);
  const list = Array.isArray(rows) ? rows : [];
  const stamped = entries.map((e) => ({ ...e, at: Date.now() }));
  try {
    atomicWriteJson(REFRESH_LOGS_FILE, [...list, ...stamped].slice(-LOG_LIMIT));
  } catch {
    /* 日志写失败不影响刷新结果 */
  }
}

/** 该账号最近一条刷新日志（从尾部倒序找；用于失败冷却） */
function latestLogFor(accountId) {
  const rows = readJsonFile(REFRESH_LOGS_FILE, []);
  const list = Array.isArray(rows) ? rows : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.accountId === accountId) return list[i];
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 凭据验活状态（持久化，界面展示用）
 * ------------------------------------------------------------------ */

/**
 * 验活结果落盘：`accountId → { at, valid, unauthorized, message }`。
 *
 * 为什么要存：本地 expiresAt 只说明"没到时间"，不代表服务端还认这个 token
 * （2026-10-18 用户反馈：面板显示「凭据有效」，切过去却登录过期）。巡检每次都会真的
 * 打一次官方接口验活，结果存下来给界面直接展示，不必让界面自己再发请求。
 * 只存结论，**不存任何 token**。
 */
export const CREDENTIAL_STATUS_FILE = path.join(STORE_DIR, 'credential_status.json');
const STATUS_LIMIT = 100;

/** 读取全部验活状态（accountId → state） */
export function loadCredentialStatus() {
  const raw = readJsonFile(CREDENTIAL_STATUS_FILE, {});
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function saveCredentialStatus(state) {
  try {
    atomicWriteJson(CREDENTIAL_STATUS_FILE, state);
  } catch {
    /* 状态写失败不影响刷新结果 */
  }
}

/** 记录单个账号的验活结论 */
function recordVerify(accountId, state) {
  if (!accountId) return;
  const all = loadCredentialStatus();
  all[accountId] = state;
  // 只保留最近的 N 个账号结论，避免文件无限增长（已删账号的残留自然淘汰）
  const keys = Object.keys(all);
  if (keys.length > STATUS_LIMIT) {
    for (const k of keys.sort((a, b) => (all[a]?.at || 0) - (all[b]?.at || 0)).slice(0, keys.length - STATUS_LIMIT)) delete all[k];
  }
  saveCredentialStatus(all);
}

/**
 * 验活一个账号（读接口，**不轮换 token**，因此对当前登录账号也是安全的）。
 * 结果自动落盘。返回 `{ at, valid, unauthorized, message }`。
 */
export async function verifyAccount(account) {
  const r = await verifyAccountCredential(account);
  const state = { at: Date.now(), valid: !!r.valid, unauthorized: !!r.unauthorized, message: r.message || '' };
  recordVerify(account?.id || account?.uid || '', state);
  return state;
}

/** 该账号最近一次验活结论（没有就返回 null） */
export function verifyStateOf(accountId) {
  return loadCredentialStatus()[accountId] || null;
}

/**
 * 巡检决策（纯函数，便于离线回归）：把「验活结论 + 本地有效期 + 是否当前账号」翻译成一个动作。
 *
 * 返回 `{ action, reason, message, needRefresh }`：
 * - `needRefresh: true` → 调用方去刷新；
 * - 其余三种动作直接作为结果上报。
 */
export function decideCredentialAction({ plan, verify = null, force = false } = {}) {
  // 网络异常：不是鉴权失败，什么都不做，更不能据此判定失效
  if (verify && !verify.valid && !verify.unauthorized) {
    return {
      action: 'skipped',
      reason: 'verify-failed',
      message: `验活请求失败（${verify.message || '网络异常'}），本次不改动该账号`,
      needRefresh: false,
    };
  }

  // 服务端明确拒绝
  if (verify && verify.unauthorized) {
    if (!plan?.hasRefreshToken) {
      return {
        action: 'dead',
        reason: 'invalid-no-refresh',
        message: '服务端已拒绝该凭据，且没有 refresh_token 可用于续期，需重新登录后导入',
        needRefresh: false,
      };
    }
    if (plan.current && !force) {
      return {
        action: 'dead',
        reason: 'current-invalid',
        message: '当前登录账号的凭据已被服务端拒绝，请在 WorkBuddy 里重新登录该账号',
        needRefresh: false,
      };
    }
    return { action: 'refresh', reason: plan?.reason || 'invalid', message: '', needRefresh: true };
  }

  // 还没验活（加密信封账号 / 显式跳过）：退回旧的"按本地有效期"逻辑
  if (!verify) {
    if (plan?.dead) {
      return {
        action: 'dead',
        reason: plan.reason,
        message:
          plan.reason === 'dead'
            ? 'refresh_token 已过期，需用 WorkBuddy 重新扫码登录后再导入'
            : '该账号没有 refresh_token，access_token 一过期就只能重新扫码登录',
        needRefresh: false,
      };
    }
    return { action: plan?.due ? 'refresh' : 'skipped', reason: plan?.reason || 'ok', message: '', needRefresh: !!plan?.due };
  }

  // 验活有效：当前账号不自动刷新；临期才刷；否则什么都不用做
  if (plan?.current && !force) {
    return {
      action: 'skipped',
      reason: 'current',
      message: '当前登录账号由 WorkBuddy 自行续期，自动刷新已跳过（手动刷新会同步回登录态）',
      needRefresh: false,
    };
  }
  if (plan?.due) return { action: 'refresh', reason: plan.reason, message: '', needRefresh: true };
  return {
    action: 'skipped',
    reason: 'verified-valid',
    message: '服务端确认凭据有效，未到临期，无需刷新',
    needRefresh: false,
  };
}

/**
 * 执行巡检：**先验活、再决定是否刷新**。
 *
 * 早先只看本地有效期决定刷不刷——本地「未过期」的账号可能早就被服务端作废了，
 * 而界面上还挂着「凭据有效」，直到用户切过去才暴露（2026-10-18 反馈）。
 * 现在每次巡检都对每个账号真的打一次官方接口，再按结论行动（决策表见 decideCredentialAction）。
 * 当前登录账号仍然**不自动刷新**（登录态由 WorkBuddy 维护），但会参与验活——
 * 那是只读操作，结果用于界面展示。
 *
 * @param {object}   opts
 * @param {string[]} [opts.accountIds] 只处理这些账号（id 或 uid）；不传 = 全部
 * @param {boolean}  [opts.force]      跳过临期判定，强制刷新（用户手动点「立即刷新」）
 * @param {number}   [opts.delayMs]    每次处理之间的间隔，避免连续打官方接口
 * @param {boolean}  [opts.skipVerify] 不验活，走旧逻辑（离线测试/网络极差时用）
 * @returns {{ results: object[], summary: object }}
 */
export async function refreshAccounts({ accountIds = null, force = false, delayMs = 400, skipVerify = false } = {}) {
  const wanted = Array.isArray(accountIds) && accountIds.length ? new Set(accountIds) : null;
  const targets = loadAccounts().filter((a) => !wanted || wanted.has(a?.id) || wanted.has(a?.uid));
  // 当前登录账号的登录态由 WorkBuddy 自己维护，自动刷新必须绕开它（见 refreshPlanFor 注释）。
  // 两档位各有一份登录态，所以是"两个当前账号"，只保护一个会顶掉另一档。
  const currents = detectCurrentAccounts();
  const currentUids = [currents.cn.uid, currents.ai.uid].filter(Boolean);

  const results = [];
  for (const account of targets) {
    const plan = refreshPlanFor(account, { force, currentUids });

    // 1) 验活（加密信封账号没有明文凭据，发不出带鉴权的请求，只能跳过）
    let verify = null;
    if (!skipVerify && plain(account, 'access_token')) {
      try {
        verify = await verifyAccount(account);
      } catch {
        verify = null;
      }
    }

    /**
     * 2) 失败冷却：自动巡检不再重试最近失败过的账号（refresh_token 已被服务端作废，
     *    反复拿它去撞接口可能触发重放检测，连累该账号其它有效会话）。
     *    但如果这次验活发现 token 仍然有效，说明冷却没有意义了，照常继续。
     */
    if (!force && !(verify && verify.valid)) {
      const last = latestLogFor(plan.id || account?.id);
      if (last && last.ok === false && Date.now() - Number(last.ts || 0) < FAILED_COOLDOWN_MS) {
        results.push({
          ok: true,
          action: 'skipped',
          reason: 'failed-cooldown',
          message: '上次刷新失败（refresh_token 已失效），已暂停自动重试；请重新登录该账号后再手动刷新',
          verify,
          ...metaOf(plan),
        });
        continue;
      }
    }

    // 3) 按验活结论决定动作
    const decision = decideCredentialAction({ plan, verify, force });
    if (!decision.needRefresh) {
      const ok = decision.action !== 'dead';
      results.push({ ok, action: decision.action, reason: decision.reason, message: decision.message, verify, ...metaOf(plan) });
      if (!ok) {
        appendRefreshLogs([
          {
            ts: Date.now(),
            accountId: plan.id,
            accountName: plan.name,
            variant: plan.variant,
            ok: false,
            action: 'failed',
            reason: decision.reason,
            message: decision.message,
          },
        ]);
      }
      continue;
    }

    const before = { accessHours: plan.accessHours, refreshHours: plan.refreshHours };
    try {
      await refreshAccessToken(account);
      // 重新读盘拿刷新后的有效期（refreshAccessToken 已原子写回）
      const after = loadAccounts().find((a) => a?.id === account.id || a?.uid === account.uid) || account;
      const next = refreshPlanFor(after, { now: Date.now(), currentUids });
      // 刷新成功即视为服务端认可（refresh 端点本身就是一次带凭据的调用），更新验活结论
      const verifyAfter = skipVerify ? verify : { at: Date.now(), valid: true, unauthorized: false, message: '' };
      if (verifyAfter) recordVerify(plan.id || account?.id || '', verifyAfter);
      results.push({
        ok: true,
        action: 'refreshed',
        reason: plan.reason,
        message: '',
        verify: verifyAfter,
        ...metaOf(next),
        before,
      });
      appendRefreshLogs([
        {
          ts: Date.now(),
          accountId: plan.id,
          accountName: plan.name,
          variant: plan.variant,
          ok: true,
          action: 'refreshed',
          reason: plan.reason,
          accessHours: next.accessHours,
          refreshHours: next.refreshHours,
        },
      ]);
    } catch (e) {
      const message = e?.message || '刷新失败';
      // 刷新失败且验活本来就被拒 → 结论是"确实失效"；否则只是这次刷新没成功
      const deadNow = !!(verify && verify.unauthorized);
      results.push({ ok: false, action: deadNow ? 'dead' : 'failed', reason: plan.reason, message, verify, ...metaOf(plan) });
      appendRefreshLogs([
        {
          ts: Date.now(),
          accountId: plan.id,
          accountName: plan.name,
          variant: plan.variant,
          ok: false,
          action: 'failed',
          reason: plan.reason,
          message,
        },
      ]);
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  const summary = {
    total: results.length,
    refreshed: results.filter((r) => r.action === 'refreshed').length,
    skipped: results.filter((r) => r.action === 'skipped').length,
    failed: results.filter((r) => r.action === 'failed').length,
    dead: results.filter((r) => r.action === 'dead').length,
    /** 服务端确认有效（含刷新后有效） */
    verified: results.filter((r) => r.verify?.valid).length,
    /** 服务端明确拒绝（需重新登录） */
    invalid: results.filter((r) => r.verify && !r.verify.valid && r.verify.unauthorized).length,
  };
  return { results, summary };
}

/** 结果里对外的账号字段（不含任何 token） */
function metaOf(plan) {
  return {
    accountId: plan.id,
    accountName: plan.name,
    variant: plan.variant,
    accessHours: plan.accessHours,
    refreshHours: plan.refreshHours,
  };
}
