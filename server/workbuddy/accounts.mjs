/**
 * 账号库：读写 `~/.wb-switch/accounts.json`。
 *
 * 与 workbuddy-switch 共享同一个数据目录（该工具已在本机运行，账号数据在这里，
 * 两个工具互不干扰地读同一份）。文件缺失或损坏返回空列表，绝不抛异常——
 * 界面应展示"没有账号"而不是崩溃。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { atomicWriteJson } from '../store/config.mjs';
import { variantOf, getVariant } from './variant.mjs';

/** 账号库根目录：默认 ~/.wb-switch，可用 WB_SWITCH_HOME 重定向（测试隔离） */
export const STORE_DIR = process.env.WB_SWITCH_HOME
  ? path.resolve(process.env.WB_SWITCH_HOME)
  : path.join(os.homedir(), '.wb-switch');

export const ACCOUNTS_FILE = path.join(STORE_DIR, 'accounts.json');
export const BACKUP_DIR = path.join(STORE_DIR, 'backups');
/**
 * 积分快照：**故意与 workbuddy-switch 共用** `credit_usage_snapshots.json`。
 *
 * 两边结构是兼容的超集（`{accountId, accountName, total, remaining, ts}`，
 * 我们多写一个 `variant`，对方反序列化时忽略未知字段），共用能让离线兜底
 * 看到更长的历史。**这是核实过的，不是漏改。**
 */
export const CREDIT_SNAPSHOTS_FILE = path.join(STORE_DIR, 'credit_usage_snapshots.json');
/**
 * 签到日志：**本工具私有**。
 *
 * workbuddy-switch 也用 `~/.wb-switch/auto_checkin_logs.json`，但它写的是
 * `{accountId, email, result, ts}`，我们写的是 `{accountName, message, ok, ...}`；
 * 混在一个文件里会让双方的界面都出现空字段。所以各写各的（账号库仍然共用）。
 */
export const CHECKIN_LOGS_FILE = path.join(STORE_DIR, 'checkin_logs.json');
/**
 * 积分用量的**本工具专用**缓存。
 *
 * 不能用 `~/.wb-switch/official_usage_cache.json`：那个文件与 workbuddy-switch
 * 共用，但两边的 payload 结构不同（对方是 per-account 的 daily/models/reportedTotal，
 * 我们是扁平的 round 列表）。谁后写谁覆盖，读回来的一旦是对方的结构，
 * 界面就会出现「余额未知」——实测踩过。缓存的读写各用各的文件，账号库仍然共用。
 */
export const OFFICIAL_USAGE_CACHE_FILE = path.join(STORE_DIR, 'credit_stats_cache.json');

/** 读取账号库；文件缺失或损坏返回空数组 */
export function loadAccounts() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveAccounts(accounts) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  atomicWriteJson(ACCOUNTS_FILE, accounts);
}

/** 按 id 或 uid 查找账号（uid 兼容：切换时前端可能拿 uid 当标识） */
export function findAccount(accountId) {
  return loadAccounts().find((a) => a?.id === accountId || a?.uid === accountId) || null;
}

/** 判断字段是否为 WorkBuddy 5.6 加密信封（`{$wbEncrypted, envelope}`） */
export function isEnvelope(value) {
  return !!(value && typeof value === 'object' && !Array.isArray(value) && '$wbEncrypted' in value);
}

/**
 * 取账号里的敏感字段值：
 * 可能是明文字符串（OAuth 所得），也可能是加密信封对象（需原样写回）。
 * 两者都要原样返回——信封降级为空串会静默毁掉登录态。
 */
export function secretValue(account, key) {
  const v = account?.[key];
  if (typeof v === 'string' && v.trim()) return v;
  if (isEnvelope(v)) return v;
  return '';
}

/**
 * 账号是否持有**明文** access_token（不管是否过期）。
 *
 * 与 {@link hasPlainToken} 的区别：这里只回答"能不能把 token 放进
 * Authorization 头"，不判断有效期。加密信封与空值都不算——拿它们去发请求
 * 只会得到 401，然后被误判成"凭据已失效"。
 */
export function hasPlainAccessToken(account) {
  const token = secretValue(account, 'access_token');
  return typeof token === 'string' && !!token.trim();
}

/** 账号是否持有可用的明文 access_token（OAuth 扫码所得形态） */
export function hasPlainToken(account) {
  if (!hasPlainAccessToken(account)) return false;
  const exp = Number(account?.expiresAt);
  if (Number.isFinite(exp) && exp > 0) return exp > Date.now();
  return true; // 无过期时间时保守认为有效
}

/** token 是否已过期（用于界面提示"需重新授权"） */
export function isExpired(account) {
  const exp = Number(account?.expiresAt);
  return Number.isFinite(exp) && exp > 0 && exp <= Date.now();
}

/** 从 profile_raw 读取官方手机号（仅接受非空字符串） */
function profilePhone(account) {
  const v = account?.profile_raw?.phoneNumber;
  if (typeof v === 'string' && v.trim()) return v.trim();
  return '';
}

/**
 * 解析明文 access_token（JWT）里的身份声明。
 *
 * 只解码 payload、**不验签**——用途仅限界面展示（邮箱 / 昵称 / 用户名），
 * 不参与任何鉴权判断。token 是加密信封时返回 null（解不开，交给其它兜底）。
 */
function jwtIdentityClaims(account) {
  const token = account?.access_token;
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 3) return null;
  try {
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

/**
 * 账号的可读身份：账号库字段优先，缺失时用 access_token 的 JWT 声明补。
 *
 * ## 为什么需要（2026-10-29 反馈：账号卡片标题显示成一串 uuid）
 *
 * 国际版扫码/导入得到的 `profile_raw.nickname`、`phoneNumber` 是**加密信封**
 * （`{$wbEncrypted, envelope}`），既解不开也读不出；`email` 服务端又没下发明文。
 * 于是账号库里 nickname / email 都是空串，`accountDisplayName()` 一路兜到 uid，
 * 界面就把 uuid 当名字显示。而同一账号的 access_token（明文 JWT）里其实带着
 * `email` / `nickname` / `name` / `preferred_username`，直接取用即可。
 */
export function accountIdentity(account) {
  const claims = jwtIdentityClaims(account) || {};
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const email = str(account?.email) || str(claims.email);
  const nickname =
    str(account?.nickname) || str(claims.nickname) || str(claims.name) || str(claims.given_name);
  const username = str(claims.preferred_username);
  // 国内版的 preferred_username 就是手机号；国际版是账号名，不能混用
  const phone = profilePhone(account) || (/^\+?\d{6,}$/.test(username) ? username : '');
  return { email, nickname, username, phone };
}

/**
 * 账号展示名：按本地 displayField 选择，再逐级兜底。
 *
 * - `note` / `auto`：都优先用备注（界面上「自动」写的就是「备注 → 邮箱 → 昵称 → UID」，
 *   之前 auto 分支忘了取备注，导致用户改完备注看不到任何变化）。
 * - `phone`：优先官方手机号，取不到再回落备注。
 * 兜底链：email → nickname → preferred_username → uid → unknown。
 * email / nickname 会先从 JWT 声明补全，避免昵称是加密信封时直接露出 uuid。
 */
export function accountDisplayName(account) {
  const note = String(account?.note || '').trim();
  const identity = accountIdentity(account);
  const byField = account?.displayField === 'phone' ? identity.phone || note : note;
  const uid = String(account?.uid || '').trim();
  return byField || identity.email || identity.nickname || identity.username || uid || 'unknown';
}

/**
 * 对外暴露的账号摘要（不含 token 等敏感字段）。
 * `masked` 只保留 token 末 4 位，供界面区分同名账号。
 */
export function accountMeta(account) {
  const variant = variantOf(account);
  const identity = accountIdentity(account);
  return {
    id: account?.id || '',
    uid: account?.uid || '',
    name: accountDisplayName(account),
    email: identity.email || null,
    nickname: identity.nickname || null,
    note: String(account?.note || '') || null,
    displayField: account?.displayField || 'auto',
    domain: account?.domain || getVariant(variant).apiEndpoint,
    variant: variant.id,
    variantLabel: variant.label,
    enterpriseName: account?.enterpriseName ? String(account.enterpriseName) : null,
    createdAt: Number(account?.createdAt) || null,
    refreshedAt: Number(account?.refreshedAt) || null,
    expiresAt: Number(account?.expiresAt) || null,
    refreshExpiresAt: Number(account?.refreshExpiresAt) || null,
    hasPlainToken: hasPlainToken(account),
    expired: isExpired(account),
    hasEnvelope: isEnvelope(account?.access_token),
    masked: maskToken(secretValue(account, 'access_token')),
  };
}

/** token 只保留末 4 位用于界面区分，完整值永不返回给前端 */
export function maskToken(token) {
  if (typeof token !== 'string' || !token) return '';
  if (token.length <= 4) return '••••';
  return `••••${token.slice(-4)}`;
}

/** 备份登录态文件，返回备份路径；文件不存在返回 null */
export function backupAuthFile(srcPath, tag) {
  try {
    if (!fs.existsSync(srcPath)) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, `${tag || 'workbuddy-desktop'}.${stamp}.info`);
    fs.copyFileSync(srcPath, dest);
    return dest;
  } catch {
    return null;
  }
}

/** 读取 JSON 文件；不存在或损坏返回 null */
export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}