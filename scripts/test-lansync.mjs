/**
 * 手机同步：协议 + 冲突裁决 + 待同步队列的离线回归测试。
 *
 * 全部是纯函数 / 临时目录，不联网、不碰真实账号库。守的是几条"写错了肉眼看不出来，
 * 但会让用户账号掉线"的判据：
 *
 * 1. **秒 / 毫秒**：a 用秒、b 用毫秒，差 1000 倍。写错账号会"刚同步完就过期"。
 * 2. **轮换冲突**：b 已经刷过新凭据时，a 推来的旧 token 不能覆盖回去，否则把 b 打回死值。
 * 3. **当前登录账号**：绝不能覆盖，否则电脑上的 WorkBuddy 立刻掉登录。
 * 4. **加密信封**：没有明文可同步，覆盖等于毁掉登录态。
 * 5. **版本单调**：任何一次写入都让 syncVersion +1，防"时间倒流"。
 *
 * 隔离：`WB_SWITCH_HOME` 必须在 **import 之前**设置——STORE_DIR 是模块加载时算出来的。
 *
 * 运行：node scripts/test-lansync.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lansync-'));
process.env.WB_SWITCH_HOME = path.join(tmp, 'wb-switch');
process.env.FREE_TOKEN_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.WB_SWITCH_HOME, { recursive: true });
fs.mkdirSync(process.env.FREE_TOKEN_CONFIG_DIR, { recursive: true });

const {
  PROTOCOL_VERSION,
  toMs,
  toSec,
  normalizeIncoming,
  validatePushRequest,
  serializeAccount,
  safeEqual,
  generatePairCode,
  MAX_ACCOUNTS,
} = await import('../server/lansync/protocol.mjs');
const { planMerge, decideFor, materialize, fingerprintOf, stableIdOf, ACTIONS, CLOCK_SKEW_MS } = await import(
  '../server/lansync/merge.mjs'
);
const { enqueuePending, listPending, ackPending, clearPending, pendingSummary, PENDING_LIMIT, PENDING_FILE } = await import(
  '../server/lansync/state.mjs'
);

let pass = 0;
let fail = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    const detail = extra === undefined ? '' : ` → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
    failures.push(label + detail);
    console.log(`  ✗ ${label}${detail}`);
  }
}
function section(t) {
  console.log(`\n${t}`);
}

/** 固定"现在"，避免时钟漂移让断言偶发失败 */
const NOW = 1_761_000_000_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** 本地账号（b 的 records 形态，毫秒） */
const localAcct = (over = {}) => ({
  id: 'u1',
  uid: 'u1',
  nickname: '测试号',
  note: '测试号',
  displayField: 'auto',
  variant: 'cn',
  access_token: 'AT_local',
  refresh_token: 'RT_local',
  token_type: 'Bearer',
  expiresAt: NOW + HOUR,
  refreshExpiresAt: NOW + 30 * DAY,
  refreshedAt: NOW - 2 * HOUR,
  createdAt: NOW - 10 * DAY,
  profile_raw: { uid: 'u1', phoneNumber: '13800000000' },
  ...over,
});

/** 入站账号（走 normalizeIncoming，默认用秒级时间戳，模拟 a 的真实形态） */
const remoteAcct = (over = {}) =>
  normalizeIncoming({
    uid: 'u1',
    label: '测试号',
    accessToken: 'AT_remote',
    refreshToken: 'RT_remote',
    expiresAt: Math.floor((NOW + HOUR) / 1000),
    obtainedAt: NOW - HOUR,
    ...over,
  });

/* ------------------------------------------------------------------ */
section('1. 时间单位（秒 / 毫秒）');
/* ------------------------------------------------------------------ */

check('秒级时间戳 → 毫秒', toMs(1_761_000_000) === 1_761_000_000_000, toMs(1_761_000_000));
check('毫秒级时间戳原样保留', toMs(1_761_000_000_000) === 1_761_000_000_000, toMs(1_761_000_000_000));
check('0 / 负数 / 非数字 → 0（未知，不当作已过期）', toMs(0) === 0 && toMs(-1) === 0 && toMs('x') === 0, [toMs(0), toMs(-1), toMs('x')]);
check('毫秒 → 秒向下取整', toSec(1_761_000_000_999) === 1_761_000_000, toSec(1_761_000_000_999));
check('归一化后 expiresAt 是毫秒', remoteAcct().expiresAt === NOW + HOUR, remoteAcct().expiresAt);
check('入站兼容 a 的 `token` 别名', normalizeIncoming({ token: 'AT' }).accessToken === 'AT');

/* ------------------------------------------------------------------ */
section('2. 首次推送 → 新建账号');
/* ------------------------------------------------------------------ */

{
  const r = remoteAcct();
  const { plans, summary } = planMerge({ remoteAccounts: [r], localAccounts: [], now: NOW });
  check('动作为 create', plans[0].action === ACTIONS.CREATE, plans[0].action);
  check('summary 计数正确', summary.create === 1 && summary.writable === 1, summary);

  const rec = materialize(plans[0], { now: NOW });
  check('id 用 uid', rec.id === 'u1', rec.id);
  check('access_token 落到 b 的字段名', rec.access_token === 'AT_remote');
  check('refresh_token 落到 b 的字段名', rec.refresh_token === 'RT_remote');
  check('expiresAt 写的是毫秒', rec.expiresAt === NOW + HOUR, rec.expiresAt);
  check('syncVersion 从 0 → 1', rec.syncVersion === 1, rec.syncVersion);
  check('label → note，账号页能直接显示', rec.note === '测试号');
  check('保留 profile_raw 最小身份', rec.profile_raw?.uid === 'u1');
  check('domain 按档位给国内版', rec.domain === 'https://www.codebuddy.cn', rec.domain);
}

/* ------------------------------------------------------------------ */
section('3. 同一条 refresh 链 → 幂等，不写盘');
/* ------------------------------------------------------------------ */

{
  const local = localAcct({ refresh_token: 'RT_same' });
  const r = remoteAcct({ refreshToken: 'RT_same' });
  const { plans, summary } = planMerge({ remoteAccounts: [r], localAccounts: [local], now: NOW });
  check('动作为 same', plans[0].action === ACTIONS.SAME, plans[0].action);
  check('不可写', summary.writable === 0, summary);
  check('materialize 返回 null', materialize(plans[0], { now: NOW }) === null);
}

/* ------------------------------------------------------------------ */
section('4. b 已刷新过，a 推来旧 token → 必须拒绝覆盖');
/* ------------------------------------------------------------------ */

{
  // b 2 小时前刷过；a 手里是 5 小时前的快照
  const local = localAcct({ refreshedAt: NOW - 2 * HOUR, syncVersion: 3 });
  const r = remoteAcct({ obtainedAt: NOW - 5 * HOUR, refreshToken: 'RT_old' });
  const p = planMerge({ remoteAccounts: [r], localAccounts: [local], now: NOW }).plans[0];
  check('动作为 keep-local', p.action === ACTIONS.KEEP_LOCAL, p.action);
  check('原因是本地更新', p.reason === 'local-newer', p.reason);
  check('不写盘（否则 b 被打回死值）', materialize(p, { now: NOW }) === null);
}

/* ------------------------------------------------------------------ */
section('5. a 刚重新扫码，比 b 新 → 采纳');
/* ------------------------------------------------------------------ */

{
  const local = localAcct({ refreshedAt: NOW - 6 * HOUR });
  const r = remoteAcct({ obtainedAt: NOW - 1 * HOUR, refreshToken: 'RT_new' });
  const p = planMerge({ remoteAccounts: [r], localAccounts: [local], now: NOW }).plans[0];
  check('动作为 adopt', p.action === ACTIONS.ADOPT, p.action);
  check('原因是远端更新', p.reason === 'remote-newer', p.reason);

  const rec = materialize(p, { now: NOW });
  check('refresh_token 已换新', rec.refresh_token === 'RT_new');
  check('refreshedAt 跟随 a 的时间', rec.refreshedAt === NOW - HOUR, rec.refreshedAt);
  check('版本严格递增', rec.syncVersion === 1, rec.syncVersion);
}

/* ------------------------------------------------------------------ */
section('6. 本地从未刷新过（老数据）→ 直接采纳');
/* ------------------------------------------------------------------ */

{
  const local = localAcct({ refreshedAt: 0 });
  const p = planMerge({ remoteAccounts: [remoteAcct()], localAccounts: [local], now: NOW }).plans[0];
  check('动作为 adopt', p.action === ACTIONS.ADOPT, p.action);
  check('原因 local-never-refreshed', p.reason === 'local-never-refreshed', p.reason);
}

/* ------------------------------------------------------------------ */
section('7. 5 分钟内双方都刷过 → 判定并发，保守保留本地并给出风险提示');
/* ------------------------------------------------------------------ */

{
  const local = localAcct({ refreshedAt: NOW - HOUR });
  const r = remoteAcct({ obtainedAt: NOW - HOUR + 60_000 });
  const p = planMerge({ remoteAccounts: [r], localAccounts: [local], now: NOW }).plans[0];
  check('动作为 keep-local', p.action === ACTIONS.KEEP_LOCAL, p.action);
  check('原因为并发轮换', p.reason === 'concurrent-rotation', p.reason);
  check('带可展示的风险提示', typeof p.risk === 'string' && p.risk.length > 0, p.risk);
  check('容差确实是 5 分钟', CLOCK_SKEW_MS === 5 * 60_000, CLOCK_SKEW_MS);
}

/* ------------------------------------------------------------------ */
section('8. 当前登录账号 → 任何模式都不动');
/* ------------------------------------------------------------------ */

{
  const local = localAcct({ refreshedAt: NOW - 6 * HOUR });
  const r = remoteAcct({ obtainedAt: NOW - 1 * HOUR, refreshToken: 'RT_new' });
  for (const mode of ['merge', 'force']) {
    const p = planMerge({ remoteAccounts: [r], localAccounts: [local], currentUid: 'u1', mode, now: NOW }).plans[0];
    check(`mode=${mode} 时为 skipped-current`, p.action === ACTIONS.SKIPPED_CURRENT, p.action);
    check(`mode=${mode} 时 materialize 为 null`, materialize(p, { now: NOW }) === null);
  }
  check('风险文案非空', !!planMerge({ remoteAccounts: [r], localAccounts: [local], currentUid: 'u1', now: NOW }).plans[0].risk);
}

/* ------------------------------------------------------------------ */
section('9. 加密信封账号 → 跳过（覆盖会毁掉登录态）');
/* ------------------------------------------------------------------ */

{
  const local = localAcct({ access_token: { $wbEncrypted: true, envelope: 'BASE64...' } });
  const p = planMerge({ remoteAccounts: [remoteAcct({ refreshToken: 'RT_x' })], localAccounts: [local], now: NOW }).plans[0];
  check('动作为 skipped-encrypted', p.action === ACTIONS.SKIPPED_ENCRYPTED, p.action);
}

/* ------------------------------------------------------------------ */
section('10. 入站只有 access、没有 refresh → 不能覆盖本地的续期能力');
/* ------------------------------------------------------------------ */

{
  const local = localAcct();
  const r = remoteAcct({ refreshToken: '', accessToken: 'AT_only' });
  const p = planMerge({ remoteAccounts: [r], localAccounts: [local], now: NOW }).plans[0];
  check('动作为 keep-local', p.action === ACTIONS.KEEP_LOCAL, p.action);
  check('原因 remote-has-no-refresh', p.reason === 'remote-has-no-refresh', p.reason);
}

/* ------------------------------------------------------------------ */
section('11. 远端凭据已彻底过期 → 不入库');
/* ------------------------------------------------------------------ */

{
  const r = normalizeIncoming({
    uid: 'u9',
    label: '死号',
    accessToken: 'AT',
    refreshToken: 'RT',
    expiresAt: Math.floor((NOW - 2 * HOUR) / 1000),
    refreshExpiresAt: Math.floor((NOW - HOUR) / 1000),
  });
  const p = planMerge({ remoteAccounts: [r], localAccounts: [], now: NOW }).plans[0];
  check('动作为 skipped-dead', p.action === ACTIONS.SKIPPED_DEAD, p.action);
  check('原因 remote-both-expired', p.reason === 'remote-both-expired', p.reason);
}

/* ------------------------------------------------------------------ */
section('12. 版本回退 → 拒绝（防时间倒流）');
/* ------------------------------------------------------------------ */

{
  const local = localAcct({ syncVersion: 5, refreshedAt: NOW - 10 * HOUR });
  const r = remoteAcct({ version: 3, obtainedAt: NOW - HOUR, refreshToken: 'RT_old' });
  const p = planMerge({ remoteAccounts: [r], localAccounts: [local], now: NOW }).plans[0];
  check('动作为 skipped-version', p.action === ACTIONS.SKIPPED_VERSION, p.action);

  const forced = planMerge({ remoteAccounts: [r], localAccounts: [local], mode: 'force', now: NOW }).plans[0];
  check('force 可覆盖版本回退', forced.action === ACTIONS.ADOPT, forced.action);
}

/* ------------------------------------------------------------------ */
section('13. 没有 uid 时按 refresh 指纹 / label 唯一性匹配');
/* ------------------------------------------------------------------ */

{
  const fp = fingerprintOf('RT_fp');
  const local = localAcct({ id: `wb-${fp}`, uid: '', note: '指纹号', refresh_token: 'RT_fp' });
  const r = remoteAcct({ uid: '', label: '指纹号', refreshToken: 'RT_fp' });
  const p = planMerge({ remoteAccounts: [r], localAccounts: [local], now: NOW }).plans[0];
  check('按 fingerprint 命中', p.matchedBy === 'refresh-fingerprint', p.matchedBy);
  check('同链判定为 same', p.action === ACTIONS.SAME, p.action);
}

{
  // 两个同名的无 uid 账号：不敢按名字认人，宁可新建
  const a1 = localAcct({ id: 'wb-a', uid: '', note: '老王', refresh_token: 'RT_a' });
  const a2 = localAcct({ id: 'wb-b', uid: '', note: '老王', refresh_token: 'RT_b' });
  const r = remoteAcct({ uid: '', label: '老王', refreshToken: 'RT_c' });
  const p = planMerge({ remoteAccounts: [r], localAccounts: [a1, a2], now: NOW }).plans[0];
  check('重名不匹配，走新建', p.action === ACTIONS.CREATE, p.action);
}

{
  const local = localAcct({ id: 'wb-only', uid: '', note: '独苗', refresh_token: 'RT_old2', refreshedAt: NOW - 6 * HOUR });
  const r = remoteAcct({ uid: '', label: '独苗', refreshToken: 'RT_new2', obtainedAt: NOW - HOUR });
  const p = planMerge({ remoteAccounts: [r], localAccounts: [local], now: NOW }).plans[0];
  check('唯一同名可匹配', p.matchedBy === 'label', p.matchedBy);
  check('并按新鲜度采纳', p.action === ACTIONS.ADOPT, p.action);
}

/* ------------------------------------------------------------------ */
section('14. 同一批重复推送同一账号 → 只处理第一条');
/* ------------------------------------------------------------------ */

{
  const r1 = remoteAcct({ refreshToken: 'RT_1' });
  const r2 = remoteAcct({ refreshToken: 'RT_2' });
  const { plans, summary } = planMerge({ remoteAccounts: [r1, r2], localAccounts: [], now: NOW });
  check('第一条 create', plans[0].action === ACTIONS.CREATE, plans[0].action);
  check('第二条 skipped-duplicate', plans[1].action === ACTIONS.SKIPPED_DUPLICATE, plans[1].action);
  check('writable 只有 1', summary.writable === 1, summary);
}

/* ------------------------------------------------------------------ */
section('15. 采纳时保留本地用户数据');
/* ------------------------------------------------------------------ */

{
  const local = localAcct({
    note: '我自己的备注',
    displayField: 'note',
    createdAt: NOW - 100 * DAY,
    profile_raw: { uid: 'u1', phoneNumber: '13900000000', nickname: '旧昵称' },
    refreshedAt: NOW - 10 * HOUR,
  });
  const r = remoteAcct({ label: '手机上的新名字', refreshToken: 'RT_brand_new', obtainedAt: NOW - HOUR });
  const rec = materialize(planMerge({ remoteAccounts: [r], localAccounts: [local], now: NOW }).plans[0], { now: NOW });
  check('备注不被覆盖', rec.note === '我自己的备注', rec.note);
  check('展示字段不被覆盖', rec.displayField === 'note', rec.displayField);
  check('创建时间不丢', rec.createdAt === NOW - 100 * DAY);
  check('完整 profile 保留（手机端只有瘦数据）', rec.profile_raw?.phoneNumber === '13900000000');
  check('凭据确实换新了', rec.refresh_token === 'RT_brand_new');
}

/* ------------------------------------------------------------------ */
section('16. 请求体校验');
/* ------------------------------------------------------------------ */

{
  check('正常请求通过', validatePushRequest({ version: 1, accounts: [{ uid: 'u1', refreshToken: 'RT' }] }).ok);
  check('空数组被拒', !validatePushRequest({ version: 1, accounts: [] }).ok);
  check('缺 accounts 被拒', !validatePushRequest({ version: 1 }).ok);
  check('非对象被拒', !validatePushRequest(null).ok);
  check(
    '协议版本过高被拒',
    !validatePushRequest({ version: PROTOCOL_VERSION + 1, accounts: [{ refreshToken: 'RT' }] }).ok
  );
  check('单条无凭据被拒', !validatePushRequest({ version: 1, accounts: [{ uid: 'u1' }] }).ok);
  check(
    '超过账号上限被拒',
    !validatePushRequest({
      version: 1,
      accounts: Array.from({ length: MAX_ACCOUNTS + 1 }, (_, i) => ({ uid: `u${i}`, refreshToken: 'RT' })),
    }).ok
  );
}

/* ------------------------------------------------------------------ */
section('17. 配对码比较与生成');
/* ------------------------------------------------------------------ */

{
  check('相同为 true', safeEqual('12345678', '12345678'));
  check('不同为 false', !safeEqual('12345678', '12345679'));
  check('长度不同为 false', !safeEqual('12345678', '1234567'));
  check('空值为 false', !safeEqual('', ''));
  const code = generatePairCode();
  check('生成 8 位纯数字', /^\d{8}$/.test(code), code);
  check('两次生成不同', code !== generatePairCode());
}

/* ------------------------------------------------------------------ */
section('18. 出站序列化（b → a）');
/* ------------------------------------------------------------------ */

{
  const rec = localAcct({ uid: 'u1', nickname: '测试号', expiresAt: NOW + HOUR, refreshExpiresAt: NOW + 30 * DAY });
  const out = serializeAccount(rec, { isCurrent: true, version: 7 });
  check('token 用 a 的字段名', out.token === 'AT_local');
  check('refreshToken 用 a 的字段名', out.refreshToken === 'RT_local');
  check('expiresAt 输出秒', out.expiresAt === Math.floor((NOW + HOUR) / 1000), out.expiresAt);
  check('同时保留毫秒原值', out.expiresAtMs === NOW + HOUR, out.expiresAtMs);
  check('透传 isCurrent', out.isCurrent === true);
  check('透传 version', out.version === 7);
}

/* ------------------------------------------------------------------ */
section('19. 待同步队列');
/* ------------------------------------------------------------------ */

{
  clearPending();
  const e1 = enqueuePending({ uid: 'u1', accessToken: 'AT1', refreshToken: 'RT1', expiresAt: NOW + HOUR, version: 1 });
  check('入队成功', e1.ok && !!e1.id, e1);
  check('队列长度 1', listPending().length === 1, listPending().length);

  // 同账号再刷一次：应替换而不是追加（否则手机会拉到两条历史值）
  enqueuePending({ uid: 'u1', accessToken: 'AT1-new', refreshToken: 'RT1-new', expiresAt: NOW + HOUR, version: 2 });
  const afterDup = listPending();
  check('同 uid 去重后仍为 1 条', afterDup.length === 1, afterDup.length);
  check('保留的是最新凭据', afterDup[0].accessToken === 'AT1-new', afterDup[0].accessToken);

  enqueuePending({ uid: 'u2', accessToken: 'AT2', refreshToken: 'RT2', version: 1 });
  check('不同账号会追加', listPending().length === 2, listPending().length);

  const summary = pendingSummary();
  check('摘要不含 token', !JSON.stringify(summary).includes('AT1-new'), JSON.stringify(summary));
  check('摘要给的是 uid 列表', summary.uids.length === 2, summary.uids);

  const target = listPending().find((x) => x.uid === 'u1');
  const ack1 = ackPending([target.id]);
  check('ack 后剩余 1 条', ack1.removed === 1 && ack1.remaining === 1, ack1);

  const ack2 = ackPending([target.id]);
  check('重复 ack 幂等（不报错、不误删）', ack2.removed === 0 && ack2.remaining === 1, ack2);

  check('ack 空数组安全', ackPending([]).removed === 0);

  clearPending();
  check('清空后为 0', listPending().length === 0);
}

{
  // 上限淘汰：不能无限涨
  clearPending();
  for (let i = 0; i < PENDING_LIMIT + 5; i++) {
    enqueuePending({ uid: `u${i}`, accessToken: `AT${i}`, refreshToken: `RT${i}` });
  }
  check(`队列不超过 ${PENDING_LIMIT}`, listPending().length === PENDING_LIMIT, listPending().length);
  clearPending();
}

{
  // 缺 uid / 无凭据的条目要拒绝，不能污染队列
  check('缺 uid 被拒', !enqueuePending({ accessToken: 'AT' }).ok);
  check('无凭据被拒', !enqueuePending({ uid: 'u1' }).ok);
}

{
  // 队列文件权限：里面是明文 refresh_token
  clearPending();
  enqueuePending({ uid: 'u1', accessToken: 'AT', refreshToken: 'RT' });
  if (process.platform !== 'win32') {
    const mode = fs.statSync(PENDING_FILE).mode & 0o777;
    check('队列文件权限 0600', mode === 0o600, mode.toString(8));
  } else {
    console.log('  - 跳过权限检查（Windows）');
  }
  clearPending();
}

/* ------------------------------------------------------------------ */
console.log(`\n${'─'.repeat(56)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log('全部通过 ✓');
}
fs.rmSync(tmp, { recursive: true, force: true });
