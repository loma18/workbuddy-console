/**
 * 凭据合并与冲突裁决（纯函数，不读盘、不联网）。
 *
 * ## 这个文件存在的唯一理由
 *
 * WorkBuddy 的 refresh_token 是**轮换式**的：一次刷新成功，服务端立刻作废旧值。
 * 手机（a）和电脑（b）各持一份副本时，"谁刷谁活、另一份当场死亡"。所以合并两份
 * 凭据不是简单覆盖，而是必须先判断**谁的更新**，再决定谁覆盖谁。
 *
 * ## 裁决优先级（顺序不可调整）
 *
 * 1. **当前登录账号**（b 正在用的那个）：一律不覆盖。b 的 WorkBuddy 客户端自己维护
 *    这份登录态，外部改写会让它下次续期失败 → 用户看到"莫名掉登录"。
 * 2. **加密信封账号**：b 手里没有明文，覆盖等于把密文换成空串，直接毁掉登录态。
 * 3. **版本回退**：remote.version 落后于本地 syncVersion，说明对面拿的是旧快照。
 * 4. **同链幂等**：两边 refresh_token 相同 = 同一条链，没有冲突，只需回传。
 * 5. **无 refresh_token 的入站**：a 只粘了 access token 时不能覆盖本地的可续期凭据。
 * 6. **新鲜度比较**：`local.refreshedAt` vs `remote.obtainedAt`，带 5 分钟时钟容差。
 * 7. 剩下的才是真正可覆盖的情况。
 *
 * 第 6 步的容差不能用 0：手机和电脑的时钟本来就有偏差，严格比较会把"同一时刻的
 * 正常同步"误判成并发轮换。
 */

import { createHash } from 'node:crypto';
import { normalizeVariant, toMs, isEnvelope } from './protocol.mjs';

/** 两端时钟允许的偏差：窗口内视为"同时发生"，按保守策略处理 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** 决策结果枚举（字符串而非数字：日志和测试输出可读） */
export const ACTIONS = {
  /** 本地没有这个账号 → 新建 */
  CREATE: 'create',
  /** 远端更新 → 用远端覆盖本地 */
  ADOPT: 'adopt',
  /** 本地更新 → 拒绝覆盖，把本地凭据回传给 a */
  KEEP_LOCAL: 'keep-local',
  /** 同一条 refresh 链 → 无冲突，回传本地 */
  SAME: 'same',
  /** 本地是 b 当前登录账号 → 不动，回传本地 */
  SKIPPED_CURRENT: 'skipped-current',
  /** 本地是加密信封，没有明文可同步 → 不动 */
  SKIPPED_ENCRYPTED: 'skipped-encrypted',
  /** 远端版本落后 → 不动 */
  SKIPPED_VERSION: 'skipped-version',
  /** 远端凭据已彻底失效（无 access 也无 refresh） */
  SKIPPED_DEAD: 'skipped-dead',
  /** 同一批次里重复推送了同一个账号 */
  SKIPPED_DUPLICATE: 'skipped-duplicate',
};

/** 这些动作需要写回账号库 */
export const WRITE_ACTIONS = new Set([ACTIONS.CREATE, ACTIONS.ADOPT]);

/**
 * refresh_token 的不可逆指纹，用作"没有 uid 时"的匹配键。
 *
 * 不能直接拿 refresh_token 当 id：它每次刷新都会变（轮换），且把凭据当标识会
 * 泄漏到日志里。sha256 前 8 字节（16 hex）足够避免碰撞，也便于肉眼比对。
 */
export function fingerprintOf(refreshToken) {
  const t = String(refreshToken || '').trim();
  if (!t) return '';
  return createHash('sha256').update(t).digest('hex').slice(0, 16);
}

/** 账号的稳定标识：uid 优先，其次 refresh 指纹。用于生成 b 的账号 id */
export function stableIdOf({ uid, refreshToken, label }) {
  if (uid) return uid;
  const fp = fingerprintOf(refreshToken);
  if (fp) return `wb-${fp}`;
  const safeLabel = String(label || '').trim().slice(0, 32);
  return safeLabel ? `wb-label-${safeLabel}` : '';
}

/** 本地账号的 syncVersion（老数据没有该字段，视为 0） */
function versionOf(record) {
  const n = Number(record?.syncVersion);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * "当前登录账号"归一化成 uid 集合。
 *
 * 国内版与国际版各有一份登录态，可能同时各在用一个账号，所以支持传数组；
 * 也兼容老调用方传单个 uid。
 */
function toUidSet(currentUid) {
  const set = new Set();
  const add = (v) => {
    if (v != null && String(v)) set.add(String(v));
  };
  if (Array.isArray(currentUid) || currentUid instanceof Set) {
    for (const v of currentUid) add(v);
  } else {
    add(currentUid);
  }
  return set;
}

/** 本地账号是否有可用的明文 access_token（加密信封不算） */
function plainAccessOf(record) {
  const t = record?.access_token;
  return typeof t === 'string' && t.trim() ? t : '';
}

/**
 * 建立本地索引。三个索引分别对应三种匹配方式，命中顺序与 user 直觉一致：
 * 先认账号身份（uid），再认凭据（指纹），最后才退到名字。
 */
function buildIndex(localAccounts) {
  const byUid = new Map();
  const byFingerprint = new Map();
  const byLabel = new Map();
  for (const a of localAccounts) {
    const uid = String(a?.uid || '').trim();
    const id = String(a?.id || '').trim();
    if (uid) byUid.set(uid, a);
    // b 的 id 历史上就是 uid（importLocalAccount 用 uid 当 id），但也可能被手工改过
    if (id && !byUid.has(id)) byUid.set(id, a);
    const fp = fingerprintOf(typeof a?.refresh_token === 'string' ? a.refresh_token : '');
    if (fp && !byFingerprint.has(fp)) byFingerprint.set(fp, a);
    const label = String(a?.note || a?.nickname || '').trim();
    if (label) {
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(a);
    }
  }
  return { byUid, byFingerprint, byLabel };
}

/**
 * 找到本地对应的账号。
 *
 * label 兜底必须**同时满足**三个条件，否则宁可不匹配（宁可多建一条，也不能把
 * A 账号的凭据写到 B 账号上）：
 * 1. 双方都没有 uid；
 * 2. 双方都没有 refresh 指纹可匹配；
 * 3. 该 label 在本地唯一。
 */
export function matchLocal(remote, index) {
  const uid = String(remote?.uid || '').trim();
  if (uid) {
    const hit = index.byUid.get(uid);
    if (hit) return { local: hit, matchedBy: 'uid' };
  }
  const fp = fingerprintOf(remote?.refreshToken);
  if (fp) {
    const hit = index.byFingerprint.get(fp);
    if (hit) return { local: hit, matchedBy: 'refresh-fingerprint' };
  }
  const label = String(remote?.label || '').trim();
  if (!uid && label) {
    const list = index.byLabel.get(label) || [];
    // 唯一 + 候选本身也没有 uid，才敢用名字认人
    if (list.length === 1 && !String(list[0]?.uid || '').trim()) {
      return { local: list[0], matchedBy: 'label' };
    }
  }
  return { local: null, matchedBy: '' };
}

/**
 * 单条裁决。纯函数：同样的输入永远得到同样的动作，便于时序测试复现。
 *
 * @param {object}  remote       归一化后的入站账号（见 protocol.normalizeIncoming）
 * @param {object?} local        本地账号记录
 * @param {string|string[]} currentUid b 当前登录账号的 uid（两档位可能各有一个，故支持数组）
 * @param {'merge'|'force'} mode merge=以新者为准（默认）；force=以手机为准
 * @param {number}  now
 */
export function decideFor({ remote, local, currentUid = null, mode = 'merge', now = Date.now() }) {
  const base = { action: '', reason: '', risk: '' };

  // 入站没有任何可用凭据：既刷不了也用不了，写进去只会污染账号库
  const hasAccess = !!String(remote?.accessToken || '').trim();
  const hasRefresh = !!String(remote?.refreshToken || '').trim();
  if (!hasAccess && !hasRefresh) {
    return { ...base, action: ACTIONS.SKIPPED_DEAD, reason: 'empty-credential' };
  }

  /**
   * 过期判定必须排在"本地没有 → 新建"**之前**。
   *
   * 否则一个已经彻底死掉的账号（access 和 refresh 都过期）会被当成新账号写进库，
   * 界面上多出一条永远刷不动的死记录，用户还得手动删。
   */
  const remoteAccessExp = toMs(remote.expiresAt);
  const remoteRefreshExp = toMs(remote.refreshExpiresAt);
  const accessDead = remoteAccessExp > 0 && remoteAccessExp <= now;
  const refreshDead = remoteRefreshExp > 0 && remoteRefreshExp <= now;
  if (!hasAccess && refreshDead) {
    return { ...base, action: ACTIONS.SKIPPED_DEAD, reason: 'remote-expired' };
  }
  if (accessDead && refreshDead) {
    return { ...base, action: ACTIONS.SKIPPED_DEAD, reason: 'remote-both-expired' };
  }
  // 没有 access 且没有 refresh 的情况上面已拦；这里保证入库的至少有一项能用
  if (!hasAccess && !hasRefresh) {
    return { ...base, action: ACTIONS.SKIPPED_DEAD, reason: 'empty-credential' };
  }

  // 1) 本地没有 → 新建
  if (!local) {
    return { ...base, action: ACTIONS.CREATE, reason: 'not-found' };
  }

  // 2) 当前登录账号：任何情况下都不动（force 也不行）
  //    两档位可能各有一个当前账号，所以 currentUid 允许传数组
  const localUid = String(local.uid || local.id || '').trim();
  if (localUid && toUidSet(currentUid).has(localUid)) {
    return {
      ...base,
      action: ACTIONS.SKIPPED_CURRENT,
      reason: 'current-account',
      risk: '电脑端正在使用该账号，刷新或覆盖会导致该档位的 WorkBuddy 掉登录',
    };
  }

  // 3) 加密信封：拿不到明文，覆盖等于毁掉登录态
  if (isEnvelope(local.access_token)) {
    return { ...base, action: ACTIONS.SKIPPED_ENCRYPTED, reason: 'local-envelope' };
  }

  // 4) 版本回退：对面拿的是旧快照，写回去会制造"时间倒流"
  const localVersion = versionOf(local);
  const remoteVersion = Number(remote.version) || 0;
  if (mode !== 'force' && remoteVersion > 0 && localVersion > 0 && remoteVersion < localVersion) {
    return {
      ...base,
      action: ACTIONS.SKIPPED_VERSION,
      reason: `remote-version-stale(${remoteVersion}<${localVersion})`,
    };
  }

  const localRefresh = typeof local.refresh_token === 'string' ? local.refresh_token.trim() : '';
  const remoteRefresh = String(remote.refreshToken || '').trim();

  // 5) 同一条链：两边本来就是同一份凭据，没有轮换冲突
  if (localRefresh && remoteRefresh && localRefresh === remoteRefresh) {
    return { ...base, action: ACTIONS.SAME, reason: 'same-refresh-token' };
  }

  // 6) 入站没有 refresh_token，但本地有：覆盖会让 b 失去续期能力（access 一过就死）
  if (!remoteRefresh && localRefresh) {
    return { ...base, action: ACTIONS.KEEP_LOCAL, reason: 'remote-has-no-refresh' };
  }

  // 7) force：用户明确要求以手机为准
  if (mode === 'force') {
    return { ...base, action: ACTIONS.ADOPT, reason: 'force' };
  }

  // 9) 新鲜度比较
  const localFresh = toMs(local.refreshedAt);
  const remoteFresh = toMs(remote.obtainedAt);

  // 远端没带时间（老客户端）：判断不了谁新，保守保留本地并把本地凭据回传
  if (!remoteFresh) {
    const dying = localFresh > 0 && now - localFresh > 30 * 24 * 3600 * 1000;
    return {
      ...base,
      action: ACTIONS.KEEP_LOCAL,
      reason: 'remote-freshness-unknown',
      // 本地也 30 天没动过，说明两边可能都旧了，值得提醒用户去重扫码
      risk: dying ? '本地凭据已超过 30 天未刷新，建议重新扫码后强制同步' : '',
    };
  }

  // 本地从未刷新过（老数据）：远端只要更新就直接采纳
  if (!localFresh) {
    return { ...base, action: ACTIONS.ADOPT, reason: 'local-never-refreshed' };
  }

  const diff = localFresh - remoteFresh;
  if (diff > CLOCK_SKEW_MS) {
    // 本地明显更新：a 手里的多半是 b 刷新前的旧值
    return { ...base, action: ACTIONS.KEEP_LOCAL, reason: 'local-newer' };
  }
  if (diff < -CLOCK_SKEW_MS) {
    return { ...base, action: ACTIONS.ADOPT, reason: 'remote-newer' };
  }

  // 落在容差窗口内：两端可能都刷过，服务端只认先到的那个，无法从本地数据判定谁赢
  return {
    ...base,
    action: ACTIONS.KEEP_LOCAL,
    reason: 'concurrent-rotation',
    risk: '检测到两端可能在 5 分钟内各自刷新过，已保留电脑端凭据；若手机端刚重新扫码，请用「以手机为准」再同步一次',
  };
}

/**
 * 批量裁决。
 *
 * @param {object}   opts
 * @param {object[]} opts.remoteAccounts 归一化后的入站账号
 * @param {object[]} opts.localAccounts  本地账号库
 * @param {string?}  opts.currentUid     b 当前登录账号 uid
 * @param {'merge'|'force'} opts.mode
 * @param {number}   opts.now
 * @returns {{ plans: object[], summary: object }}
 */
export function planMerge({ remoteAccounts = [], localAccounts = [], currentUid = null, mode = 'merge', now = Date.now() } = {}) {
  const index = buildIndex(localAccounts);
  const plans = [];
  /** 同一批里重复推送同一个账号时，后一条不能各算各的（否则两条都 create） */
  const usedLocalIds = new Set();
  /** 本批次已经处理过的远端身份（uid / 指纹），用于识别重复推送 */
  const seenRemoteKeys = new Set();

  for (const remote of remoteAccounts) {
    // 同一批里同一个账号出现两次：保留第一条（a 侧按列表顺序，前面的更靠前）
    const remoteKey = String(remote.uid || fingerprintOf(remote.refreshToken) || '').trim();
    if (remoteKey && seenRemoteKeys.has(remoteKey)) {
      plans.push({
        action: ACTIONS.SKIPPED_DUPLICATE,
        reason: 'duplicate-in-batch',
        risk: '',
        remote,
        local: null,
        matchedBy: '',
        localId: '',
      });
      continue;
    }
    if (remoteKey) seenRemoteKeys.add(remoteKey);

    const { local, matchedBy } = matchLocal(remote, index);
    // 已被本批前面的条目认领的本地账号，不能再被第二条覆盖
    const effectiveLocal = local && usedLocalIds.has(String(local.id || local.uid)) ? null : local;
    const decision = decideFor({ remote, local: effectiveLocal, currentUid, mode, now });
    const newLocalId = effectiveLocal
      ? String(effectiveLocal.id || effectiveLocal.uid || '')
      : // 新建时预登记 id，避免后面那条以 label 命中同一账号
        stableIdOf({ uid: remote.uid, refreshToken: remote.refreshToken, label: remote.label });
    if (WRITE_ACTIONS.has(decision.action)) {
      if (newLocalId) usedLocalIds.add(newLocalId);
    }
    plans.push({
      ...decision,
      remote,
      local: effectiveLocal || null,
      matchedBy: effectiveLocal ? matchedBy : '',
      localId: effectiveLocal ? String(effectiveLocal.id || effectiveLocal.uid || '') : '',
    });
  }

  const count = (action) => plans.filter((p) => p.action === action).length;
  return {
    plans,
    summary: {
      total: plans.length,
      create: count(ACTIONS.CREATE),
      adopt: count(ACTIONS.ADOPT),
      keepLocal: count(ACTIONS.KEEP_LOCAL),
      same: count(ACTIONS.SAME),
      skipped: plans.filter((p) => p.action.startsWith('skipped')).length,
      /** 需要写盘 + 入待同步队列的条数 */
      writable: plans.filter((p) => WRITE_ACTIONS.has(p.action)).length,
      risks: plans.filter((p) => p.risk).length,
    },
  };
}

/** 档位对应的默认 API 域名（新建记录时用，与 variant.mjs 保持一致） */
function domainOf(variant) {
  return normalizeVariant(variant) === 'ai' ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';
}

/**
 * 把入站凭据构造成本地账号记录（新建分支）。
 *
 * 结构与 `auth.mjs:importLocalAccount` 产出的记录保持一致，这样账号页、切换、
 * 代理、巡检等既有链路不需要为"来自手机的账号"写任何特判。
 */
export function buildRecord(remote, { now = Date.now(), deviceName = 'android' } = {}) {
  const uid = String(remote.uid || '').trim();
  const id = stableIdOf({ uid, refreshToken: remote.refreshToken, label: remote.label }) || `wb-${now}`;
  const label = String(remote.label || '').trim();
  const expiresAt = toMs(remote.expiresAt);
  const refreshExpiresAt = toMs(remote.refreshExpiresAt);
  const refreshedAt = toMs(remote.obtainedAt) || now;
  const variant = normalizeVariant(remote.variant);
  return {
    id,
    uid,
    nickname: label,
    email: '',
    note: label,
    displayField: 'auto',
    domain: domainOf(variant),
    variant,
    access_token: String(remote.accessToken || ''),
    refresh_token: String(remote.refreshToken || ''),
    token_type: 'Bearer',
    expiresAt,
    refreshExpiresAt,
    refreshedAt,
    createdAt: now,
    // 只放最小身份信息：完整 profile 要等 b 自己调接口补，别拿手机端的瘦数据冒充
    profile_raw: uid ? { uid, nickname: label } : {},
    auth_raw: {
      auth: {
        accessToken: String(remote.accessToken || ''),
        refreshToken: String(remote.refreshToken || ''),
        tokenType: 'Bearer',
        domain: domainOf(variant),
        expiresAt,
        lastRefreshTime: refreshedAt,
      },
    },
    syncVersion: Math.max(0, Number(remote.version) || 0) + 1,
    lastSyncAt: now,
    lastSyncBy: deviceName,
  };
}

/**
 * 用入站凭据更新本地记录（采纳分支）。
 *
 * 只覆盖凭据相关的键，**保留** note / displayField / createdAt / profile_raw ——
 * 用户在本机改的备注、头像、企业信息不能被手机端的瘦数据抹掉。
 */
export function applyRemoteToLocal(local, remote, { now = Date.now(), deviceName = 'android' } = {}) {
  const expiresAt = toMs(remote.expiresAt);
  const refreshExpiresAt = toMs(remote.refreshExpiresAt);
  const refreshedAt = toMs(remote.obtainedAt) || now;
  const next = {
    ...local,
    access_token: String(remote.accessToken || ''),
    refresh_token: String(remote.refreshToken || ''),
    token_type: local.token_type || 'Bearer',
    expiresAt,
    refreshExpiresAt,
    refreshedAt,
    // 版本取两端较大值再 +1：任何一次写入都让版本严格单调，防回退
    syncVersion: Math.max(versionOf(local), Number(remote.version) || 0) + 1,
    lastSyncAt: now,
    lastSyncBy: deviceName,
  };
  // 本地没有 uid 而远端有（手机扫码拿到了），补上——后续就能按 uid 稳定匹配
  if (!next.uid && remote.uid) next.uid = String(remote.uid);
  return next;
}

/** 按裁决结果产出要落库的记录；不需要写盘的返回 null */
export function materialize(plan, { now = Date.now(), deviceName = 'android' } = {}) {
  if (plan.action === ACTIONS.CREATE) {
    return buildRecord(plan.remote, { now, deviceName });
  }
  if (plan.action === ACTIONS.ADOPT && plan.local) {
    return applyRemoteToLocal(plan.local, plan.remote, { now, deviceName });
  }
  return null;
}
