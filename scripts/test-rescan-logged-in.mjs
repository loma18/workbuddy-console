/**
 * 「重新获取已登录账号」的回归测试（离线，不联网、不碰真实账号库与真实登录态）。
 *
 * 守护场景：用户在 WorkBuddy / WorkBuddy AI 客户端里直接换了账号（登出再登入），
 * 或手动替换了登录态文件。登录态文件已经指向新账号，但账号库里没有它，
 * 「当前登录态」一栏只能显示"尚未导入"——界面拿不到最新登录的账号。
 *
 * 断言：
 *   1. 一次读两档：国内版 / 国际版各自的账号都能入库（action=imported）；
 *   2. 客户端里换了账号后重新获取：新账号入库，老账号保留（不会被删）；
 *   3. 账号库里已有该账号：刷新资料（昵称/手机号），保留本地备注与展示字段；
 *   4. **登录态只有加密信封时不覆盖账号库里的明文凭据**（否则会退化成"加密凭据"）；
 *   5. 某档没有登录态时只给"没读到"的结论，不算失败，也不影响另一档；
 *   6. 重新获取只读登录态：两档登录态文件内容原样不动。
 *
 * 隔离：`HOME` / `LOCALAPPDATA` / `APPDATA`（登录态文件路径）+ `WB_SWITCH_HOME`
 * （账号库）都指到临时目录，且必须在 import 之前设置。
 *
 * 运行：node scripts/test-rescan-logged-in.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-rescan-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.LOCALAPPDATA = path.join(tmp, 'appdata', 'local');
process.env.APPDATA = path.join(tmp, 'appdata', 'roaming');
process.env.WB_SWITCH_HOME = path.join(tmp, 'wb-switch');
process.env.FREE_TOKEN_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.WB_SWITCH_HOME, { recursive: true });
fs.mkdirSync(process.env.FREE_TOKEN_CONFIG_DIR, { recursive: true });

const { authFilePath } = await import('../server/workbuddy/variant.mjs');
const { rescanLoggedInAccounts, detectCurrentAccounts } = await import('../server/workbuddy/auth.mjs');
const { loadAccounts, saveAccounts, isEnvelope } = await import('../server/workbuddy/accounts.mjs');

// 最后一道保险：路径没落到临时目录就立刻停下，绝不能再碰真实登录态。
for (const variantId of ['cn', 'ai']) {
  const p = path.resolve(authFilePath(variantId));
  if (!p.startsWith(path.resolve(tmp) + path.sep)) {
    throw new Error(`测试隔离失败：${variantId} 登录态路径不在临时目录：${p}`);
  }
}

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

const NOW = Date.now();
const HOUR = 3600_000;
const ENV_AT = { $wbEncrypted: 1, envelope: 'AT_ENVELOPE_BASE64' };
const ENV_RT = { $wbEncrypted: 1, envelope: 'RT_ENVELOPE_BASE64' };

/** 写某个档位的登录态文件（默认明文 token，与扫码所得形态一致） */
function writeAuthFile(variantId, { uid, accessToken = 'AT_PLAIN', refreshToken = 'RT_PLAIN', nickname = '', phoneNumber = '', expiresAt = NOW + 8 * HOUR } = {}) {
  const p = authFilePath(variantId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const doc = {
    account: { uid, nickname, phoneNumber, uin: '10000' },
    accounts: [{ uid }],
    allAccounts: [{ uid }],
    auth: {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      scope: 'openid profile offline_access email',
      sessionState: `session-${uid}`,
      domain: variantId === 'ai' ? 'www.workbuddy.ai' : 'www.codebuddy.cn',
      lastRefreshTime: NOW - HOUR,
      expiresAt,
      refreshExpiresAt: expiresAt + 30 * 24 * HOUR,
    },
  };
  fs.writeFileSync(p, JSON.stringify(doc, null, 2), 'utf8');
  return { path: p, raw: JSON.stringify(doc, null, 2) };
}

/* ------------------------------------------------------------------ */
section('1. 两档一次读完：国内版与国际版各自登录的账号都入库');
/* ------------------------------------------------------------------ */

let cnFile = writeAuthFile('cn', { uid: 'cn-uid-A', nickname: '国内号' });
let aiFile = writeAuthFile('ai', { uid: 'ai-uid-B', nickname: '国际号' });

{
  const r = rescanLoggedInAccounts();
  check('返回两档结论', r.results.length === 2, r.results.map((x) => x.variant));
  const cn = r.results.find((x) => x.variant === 'cn');
  const ai = r.results.find((x) => x.variant === 'ai');
  check('国内版：新增', cn?.action === 'imported' && cn?.ok === true, cn);
  check('国际版：新增', ai?.action === 'imported' && ai?.ok === true, ai);
  check('国内版账号档位正确', cn?.account?.variant === 'cn', cn?.account?.variant);
  check('国际版账号档位正确', ai?.account?.variant === 'ai', ai?.account?.variant);
  check('两档 uid 都进了账号库', loadAccounts().length === 2, loadAccounts().map((a) => a.uid));
  check('currents 同步给出两档登录态', r.currents?.cn?.uid === 'cn-uid-A' && r.currents?.ai?.uid === 'ai-uid-B', r.currents);
  check('登录态文件原样未动（国内版）', fs.readFileSync(cnFile.path, 'utf8') === cnFile.raw);
  check('登录态文件原样未动（国际版）', fs.readFileSync(aiFile.path, 'utf8') === aiFile.raw);
}

/* ------------------------------------------------------------------ */
section('2. 客户端里手动换号后重新获取：新账号入库，老账号保留');
/* ------------------------------------------------------------------ */

{
  // 用户在客户端登出 A、登录 C：登录态文件指向 C
  cnFile = writeAuthFile('cn', { uid: 'cn-uid-C', nickname: '新国内号' });
  const r = rescanLoggedInAccounts();
  const cn = r.results.find((x) => x.variant === 'cn');
  check('国内版：识别为新增', cn?.action === 'imported', cn);
  check('新账号已入库', loadAccounts().some((a) => a.uid === 'cn-uid-C'), loadAccounts().map((a) => a.uid));
  check('老账号没有被删掉', loadAccounts().some((a) => a.uid === 'cn-uid-A'), loadAccounts().map((a) => a.uid));
  check('currents 指向新账号', r.currents?.cn?.uid === 'cn-uid-C', r.currents?.cn?.uid);
  check('currents 能对上账号库记录', r.currents?.cn?.account?.id === 'cn-uid-C', r.currents?.cn?.account);
}

/* ------------------------------------------------------------------ */
section('3. 账号已存在：刷新资料，保留本地备注与展示字段');
/* ------------------------------------------------------------------ */

{
  saveAccounts(
    loadAccounts().map((a) =>
      a.uid === 'cn-uid-C' ? { ...a, note: '我的新号', displayField: 'note', email: 'me@example.com' } : a
    )
  );
  writeAuthFile('cn', { uid: 'cn-uid-C', nickname: '改过的昵称', phoneNumber: '13800000000' });
  const r = rescanLoggedInAccounts();
  const cn = r.results.find((x) => x.variant === 'cn');
  check('国内版：识别为更新', cn?.action === 'updated' && cn?.ok === true, cn);
  check('备注保留', cn?.account?.note === '我的新号', cn?.account?.note);
  check('展示字段保留', cn?.account?.displayField === 'note', cn?.account?.displayField);
  check('昵称已刷新', cn?.account?.nickname === '改过的昵称', cn?.account?.nickname);
  check('手机号已刷新', loadAccounts().find((a) => a.uid === 'cn-uid-C')?.profile_raw?.phoneNumber === '13800000000');
  check('邮箱没有被空值抹掉', loadAccounts().find((a) => a.uid === 'cn-uid-C')?.email === 'me@example.com');
}

/* ------------------------------------------------------------------ */
section('4. 登录态只有加密信封：不覆盖账号库里已有的明文凭据');
/* ------------------------------------------------------------------ */

{
  const before = loadAccounts().find((a) => a.uid === 'cn-uid-C');
  check('前置：库里是明文凭据', before?.access_token === 'AT_PLAIN', before?.access_token);
  writeAuthFile('cn', {
    uid: 'cn-uid-C',
    accessToken: ENV_AT,
    refreshToken: ENV_RT,
    nickname: '信封里的昵称',
  });
  const r = rescanLoggedInAccounts();
  const cn = r.results.find((x) => x.variant === 'cn');
  const after = loadAccounts().find((a) => a.uid === 'cn-uid-C');
  check('结论标记保留了明文凭据', cn?.keptPlainToken === true, cn);
  check('access_token 仍是明文', after?.access_token === 'AT_PLAIN', after?.access_token);
  check('refresh_token 仍是明文', after?.refresh_token === 'RT_PLAIN', after?.refresh_token);
  check('到期时间沿用库里那份', after?.expiresAt === before?.expiresAt, { before: before?.expiresAt, after: after?.expiresAt });
  check('资料仍然刷新（昵称）', cn?.account?.nickname === '信封里的昵称', cn?.account?.nickname);
  check('界面仍判定为可用明文凭据', cn?.account?.hasPlainToken === true, cn?.account?.hasPlainToken);
}

/* ------------------------------------------------------------------ */
section('5. 某档没有登录态：只给"没读到"的结论，不影响另一档');
/* ------------------------------------------------------------------ */

{
  fs.rmSync(authFilePath('ai'), { force: true });
  const r = rescanLoggedInAccounts();
  const ai = r.results.find((x) => x.variant === 'ai');
  const cn = r.results.find((x) => x.variant === 'cn');
  check('国际版：action=none', ai?.action === 'none', ai);
  check('国际版：ok=false（但不是抛错）', ai?.ok === false, ai);
  check('国际版：文案说明没有登录态文件', /没有登录态文件/.test(ai?.message || ''), ai?.message);
  check('国内版照常更新', cn?.ok === true, cn);
  check('国际版已有账号没有被删', loadAccounts().some((a) => a.uid === 'ai-uid-B'));
}

/* ------------------------------------------------------------------ */
section('6. 加密信封首次入库：原样保存（与导入口径一致）');
/* ------------------------------------------------------------------ */

{
  writeAuthFile('ai', { uid: 'ai-uid-D', accessToken: ENV_AT, refreshToken: ENV_RT });
  const r = rescanLoggedInAccounts();
  const ai = r.results.find((x) => x.variant === 'ai');
  const rec = loadAccounts().find((a) => a.uid === 'ai-uid-D');
  check('国际版：新增', ai?.action === 'imported', ai);
  check('信封原样保存', isEnvelope(rec?.access_token) && isEnvelope(rec?.refresh_token), rec?.access_token);
  check('标记为加密凭据', ai?.account?.hasEnvelope === true && ai?.account?.hasPlainToken === false, ai?.account);
  check('detectCurrentAccounts 同步可见', detectCurrentAccounts().ai.uid === 'ai-uid-D', detectCurrentAccounts().ai);
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
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}
