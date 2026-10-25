/**
 * 刷新成功后的"回推手机"钩子。
 *
 * b 侧有四个地方会轮换 refresh_token：代理请求临期、6 小时巡检、设置页手动刷新、
 * 切换账号前兜底刷新。它们最终都汇聚到 `proxy/wb.mjs:refreshAccessToken`——所以只需要
 * 在那一个出口调用本函数，就能覆盖全部场景，不必逐处打补丁。
 *
 * 未启用手机同步时直接跳过：否则队列会一直堆着没人拉的凭据。
 */
import { loadConfig } from '../store/config.mjs';
import { enqueuePending } from './state.mjs';

/**
 * @param {object} record 刷新后的账号记录（账号库里的原始形态）
 * @param {{source?: string}} opts
 * @returns {{ok: boolean, skipped?: boolean, error?: string, id?: string}}
 */
export function notifyTokenRefreshed(record, { source = 'desktop' } = {}) {
  try {
    if (!loadConfig()?.settings?.lanSync?.enabled) return { ok: false, skipped: true };
  } catch {
    // 配置读不出来时按"未启用"处理：宁可少回推一次，也不要因为配置异常打断刷新主流程
    return { ok: false, skipped: true };
  }
  if (!record) return { ok: false, error: 'no-record' };

  // 加密信封拿不到明文，回推空值会让手机把有效凭据覆盖成空串
  const access = typeof record.access_token === 'string' ? record.access_token.trim() : '';
  const refresh = typeof record.refresh_token === 'string' ? record.refresh_token.trim() : '';
  if (!access && !refresh) return { ok: false, error: 'no-plain-credential' };

  return enqueuePending({
    uid: String(record.uid || record.id || ''),
    accessToken: access,
    refreshToken: refresh,
    expiresAt: record.expiresAt,
    refreshExpiresAt: record.refreshExpiresAt,
    version: Number(record.syncVersion) || 0,
    source,
  });
}

/**
 * 手动刷新入口（设置页/接口）用：批量把刷新结果入队。
 * 只处理有明文凭据的账号，其余跳过并计入 skipped。
 */
export function notifyMany(records, { source = 'manual' } = {}) {
  const results = [];
  for (const r of records || []) results.push({ uid: r?.uid || r?.id || '', ...notifyTokenRefreshed(r, { source }) });
  return {
    ok: results.every((x) => x.ok || x.skipped),
    queued: results.filter((x) => x.ok).length,
    skipped: results.filter((x) => x.skipped).length,
    failed: results.filter((x) => !x.ok && !x.skipped).length,
  };
}
