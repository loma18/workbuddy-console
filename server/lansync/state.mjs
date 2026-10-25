/**
 * 待同步队列：b 刷新凭据后，把结果暂存在这里等手机（a）来拉。
 *
 * ## 为什么是"入队 + 拉取"而不是"直接反推手机"
 *
 * 手机当服务端有三个绕不开的问题：DHCP 让 IP 每天变、Android 后台不允许长期监听、
 * 还要常驻前台服务。改成"b 入队、a 主动拉"之后：
 *
 * - b 不需要知道手机的地址，少一份会过期的配置；
 * - a 不需要开端口，不需要前台服务；
 * - 拉取天然幂等（同一条可以重复拉到，直到 ack 为止），断网重试零成本。
 *
 * ## 安全
 *
 * 队列里存的是**明文 refresh_token**，和账号库同级敏感。所以：
 * - 目录 0700、文件 0600；
 * - 原子写（tmp + rename），断电不会留下半截 JSON；
 * - 只保留最近 200 条，按 uid 去重（同账号只留最新一次刷新）。
 *
 * 日志里**绝不能**出现 token 或队列原文，只能出现账号名/uid/条数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { STORE_DIR } from '../workbuddy/accounts.mjs';
import { toMs } from './protocol.mjs';

export const PENDING_FILE = path.join(STORE_DIR, 'lansync_pending.json');

/** 队列上限：手机长期不回拉时不能无限涨 */
export const PENDING_LIMIT = 200;

/** 读取队列；文件缺失或损坏返回空数组（同步功能不能因为队列坏了就整体报错） */
export function listPending() {
  try {
    const raw = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    const items = Array.isArray(raw?.items) ? raw.items : [];
    return items.filter((x) => x && typeof x === 'object' && x.id);
  } catch {
    return [];
  }
}

/** 原子写 + 收紧权限 */
function writePending(items) {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  const file = PENDING_FILE;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    // rename 在部分文件系统上会丢失 mode，重新收一次
    fs.chmodSync(file, 0o600);
  } catch {
    /* 尽力而为：Windows 上 chmod 语义有限 */
  }
}

/**
 * 入队一条刷新结果。
 *
 * 按 uid（退化到 id）去重：同一账号只保留**最新**凭据。否则手机一次拉取会拿到
 * 三条同一账号的历史 token，而其中两条已经是废值。
 *
 * @param {object} entry  { uid, id?, accessToken, refreshToken, expiresAt, refreshExpiresAt, version, source? }
 * @returns {{ ok: boolean, id?: string, error?: string }}
 */
export function enqueuePending(entry) {
  const uid = String(entry?.uid || entry?.id || '').trim();
  const accessToken = String(entry?.accessToken || '').trim();
  const refreshToken = String(entry?.refreshToken || '').trim();
  if (!uid) return { ok: false, error: '缺少 uid，无法入队' };
  if (!accessToken && !refreshToken) return { ok: false, error: '没有可回传的凭据' };

  const items = listPending().filter((x) => String(x.uid || '') !== uid);
  const record = {
    id: randomUUID(),
    uid,
    accessToken,
    refreshToken,
    expiresAt: toMs(entry.expiresAt),
    refreshExpiresAt: toMs(entry.refreshExpiresAt),
    version: Math.max(0, Number(entry.version) || 0),
    source: String(entry.source || 'desktop'),
    at: Date.now(),
  };
  items.push(record);
  // 超出上限淘汰最旧的：被淘汰的账号下次刷新会重新入队，不会永久丢
  const trimmed = items.slice(-PENDING_LIMIT);
  try {
    writePending(trimmed);
    return { ok: true, id: record.id };
  } catch (e) {
    return { ok: false, error: e?.message || '写队列失败' };
  }
}

/** 批量入队（一次刷新多个账号） */
export function enqueueMany(entries) {
  const results = [];
  for (const e of entries || []) results.push({ uid: e?.uid, ...enqueuePending(e) });
  return {
    ok: results.every((r) => r.ok),
    queued: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

/**
 * 手机确认收到后出队。幂等：传了不存在的 id 也不会报错。
 * @param {string[]} ids
 * @returns {{ removed: number, remaining: number }}
 */
export function ackPending(ids) {
  const set = new Set((Array.isArray(ids) ? ids : []).map(String));
  if (!set.size) return { removed: 0, remaining: listPending().length };
  const items = listPending();
  const kept = items.filter((x) => !set.has(String(x.id)));
  const removed = items.length - kept.length;
  if (removed) {
    try {
      writePending(kept);
    } catch {
      /* 写失败时保持原文件：下次拉取会重复收到，但不会丢凭据 */
      return { removed: 0, remaining: items.length };
    }
  }
  return { removed, remaining: kept.length };
}

/** 清空队列（设置页"重置同步"用） */
export function clearPending() {
  try {
    fs.rmSync(PENDING_FILE, { force: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || '清空失败' };
  }
}

/**
 * 队列摘要（给设置页展示，**不含 token**）。
 * 只返回账号 uid、时间和条数，够用户判断"还有几条没同步过去"。
 */
export function pendingSummary() {
  const items = listPending();
  return {
    count: items.length,
    oldestAt: items.length ? Math.min(...items.map((x) => Number(x.at) || 0)) : null,
    newestAt: items.length ? Math.max(...items.map((x) => Number(x.at) || 0)) : null,
    uids: items.map((x) => x.uid),
  };
}
