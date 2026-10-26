/**
 * 国际版「加密凭据」导入的回归测试（离线，不联网、不碰真实账号库与真实登录态）。
 *
 * 守护 2026-10-26 用户反馈「WorkBuddy 登录国际版后点导入，账号显示无可用凭据」：
 * 国际版登录态文件里的 accessToken / refreshToken 是 WorkBuddy 5.6 的加密信封
 * （`{$wbEncrypted: 1, envelope: '...'}`）。旧导入逻辑把非字符串一律降级成 `''`，
 * 于是 `hasEnvelope` 判不出来，界面误报「无可用凭据」，切换/刷新/查余额全部失效。
 *
 * 断言：
 *   1. 导入后信封原样保存，账号摘要标记 hasEnvelope；
 *   2. 重复导入保留本地备注/展示字段；
 *   3. 加密账号不会发空 Bearer：验活/余额查询不标记「凭据已失效」；
 *   4. 切换时信封与加密昵称原样写回登录态文件；
 *   5. 后续用明文凭据（扫码）重新导入时能正常覆盖为可用账号。
 *
 * 隔离：`HOME` / `LOCALAPPDATA` / `APPDATA`（登录态文件路径）+ `WB_SWITCH_HOME`
 * （账号库）都指到临时目录，且必须在 import 之前设置。**Windows 的登录态路径走
 * LOCALAPPDATA，只设 HOME 不够**——否则测试会覆盖本机真实的 WorkBuddy 登录态。
 *
 * 运行：node scripts/test-import-envelope.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-import-envelope-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.LOCALAPPDATA = path.join(tmp, 'appdata', 'local');
process.env.APPDATA = path.join(tmp, 'appdata', 'roaming');
process.env.WB_SWITCH_HOME = path.join(tmp, 'wb-switch');
process.env.FREE_TOKEN_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.WB_SWITCH_HOME, { recursive: true });
fs.mkdirSync(process.env.FREE_TOKEN_CONFIG_DIR, { recursive: true });

const { authFilePath } = await import('../server/workbuddy/variant.mjs');
const { importLocalAccount, switchAccount, detectCurrentAccountForVariant } = await import(
  '../server/workbuddy/auth.mjs'
);
const { loadAccounts, saveAccounts, isEnvelope } = await import('../server/workbuddy/accounts.mjs');
const { verifyAccountCredential, getAccountBalances } = await import('../server/workbuddy/credits.mjs');

// 最后一道保险：路径没落到临时目录就立刻停下，绝不能再碰真实登录态。
for (const variantId of ['cn', 'ai']) {
  const p = path.resolve(authFilePath(variantId));
  const root = path.resolve(tmp) + path.sep;
  if (!p.startsWith(root)) {
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
const UID = 'ai-envelope-uid';
const AT = { $wbEncrypted: 1, envelope: 'AT_ENVELOPE_BASE64' };
const RT = { $wbEncrypted: 1, envelope: 'RT_ENVELOPE_BASE64' };
const NICK = { $wbEncrypted: 1, envelope: 'NICK_ENVELOPE_BASE64' };
const EXPIRES_AT = NOW + 1000 * HOUR;

/** 写国际版登录态文件：token 与昵称都是加密信封（与实测一致） */
function writeAiAuthFile({ accessToken = AT, refreshToken = RT, nickname = NICK, uid = UID } = {}) {
  const p = authFilePath('ai');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        account: { uid, nickname, uin: '450702863595' },
        accounts: [{ uid }],
        allAccounts: [{ uid }],
        auth: {
          accessToken,
          refreshToken,
          tokenType: 'Bearer',
          scope: 'openid profile offline_access email',
          sessionState: 'keep-session-state',
          notBeforePolicy: 0,
          domain: 'www.workbuddy.ai',
          lastRefreshTime: NOW - HOUR,
          expiresAt: EXPIRES_AT,
          refreshExpiresAt: EXPIRES_AT,
        },
      },
      null,
      2
    ),
    'utf8'
  );
  return p;
}

writeAiAuthFile();

/* ------------------------------------------------------------------ */
section('1. 导入国际版加密登录态：信封必须原样保存');
/* ------------------------------------------------------------------ */

{
  const meta = importLocalAccount('ai');
  check('档位 = 国际版', meta.variant === 'ai', meta.variant);
  check('标记为加密凭据', meta.hasEnvelope === true, meta);
  check('没有明文凭据', meta.hasPlainToken === false, meta);
  check('到期时间从登录态文件带入', meta.expiresAt === EXPIRES_AT, meta.expiresAt);
  check('昵称取不出明文时回落到 uid', meta.name === UID, meta.name);

  const rec = loadAccounts().find((a) => a.uid === UID);
  check('账号库已写入', !!rec);
  check('access_token 是信封', isEnvelope(rec?.access_token), rec?.access_token);
  check('refresh_token 是信封', isEnvelope(rec?.refresh_token), rec?.refresh_token);
  check('profile_raw 里的加密昵称未被覆盖', isEnvelope(rec?.profile_raw?.nickname), rec?.profile_raw?.nickname);
}

/* ------------------------------------------------------------------ */
section('2. 重复导入：更新凭据但保留本地备注 / 展示字段');
/* ------------------------------------------------------------------ */

{
  saveAccounts(loadAccounts().map((a) => ({ ...a, note: '我的国际号', displayField: 'note' })));
  const meta = importLocalAccount('ai');
  check('备注保留', meta.note === '我的国际号', meta.note);
  check('展示字段保留', meta.displayField === 'note', meta.displayField);
  check('仍然是加密凭据', meta.hasEnvelope === true, meta);
}

/* ------------------------------------------------------------------ */
section('3. 加密账号不发空 Bearer：验活 / 余额查询不得误报「凭据已失效」');
/* ------------------------------------------------------------------ */

{
  const rec = loadAccounts().find((a) => a.uid === UID);
  const verify = await verifyAccountCredential(rec);
  check('验活：valid=false', verify.valid === false, verify);
  check('验活：unauthorized=false（不是官方拒绝）', verify.unauthorized === false, verify);
  check('验活：给出加密凭据原因', /加密信封/.test(verify.message), verify.message);

  const balances = await getAccountBalances({ refresh: true });
  const row = balances.accounts.find((r) => r.accountId === rec.id);
  check('余额行存在', !!row);
  check('余额行不标记 authInvalid', row?.authInvalid === false, row);
  check('余额为空', row?.balance === null, row);
  check('没有网络错误（未发请求）', balances.errors.length === 0, balances.errors);
  check('余额提示是加密凭据', /加密信封/.test(row?.balanceError || ''), row?.balanceError);
}

/* ------------------------------------------------------------------ */
section('4. 切换账号：信封与加密昵称原样写回登录态文件');
/* ------------------------------------------------------------------ */

{
  const result = switchAccount(UID);
  check('写入的是国际版文件', result.authFilePath === authFilePath('ai'), result.authFilePath);
  check('切换返回 ai 档位', result.variant === 'ai', result.variant);

  const doc = JSON.parse(fs.readFileSync(result.authFilePath, 'utf8'));
  check('accessToken 仍是信封', isEnvelope(doc.auth.accessToken), doc.auth.accessToken);
  check('refreshToken 仍是信封', isEnvelope(doc.auth.refreshToken), doc.auth.refreshToken);
  check('加密昵称没有被清空', isEnvelope(doc.account.nickname), doc.account.nickname);
  check('服务端字段 sessionState 原样保留', doc.auth.sessionState === 'keep-session-state', doc.auth.sessionState);

  const current = detectCurrentAccountForVariant('ai');
  check('登录态仍识别为当前账号', current.account?.id === UID, current.account?.id);
}

/* ------------------------------------------------------------------ */
section('5. 扫码拿到明文后重新导入：覆盖为可用账号');
/* ------------------------------------------------------------------ */

{
  writeAiAuthFile({ accessToken: 'AT_PLAIN', refreshToken: 'RT_PLAIN', nickname: '国际号' });
  const meta = importLocalAccount('ai');
  check('hasPlainToken = true', meta.hasPlainToken === true, meta);
  check('hasEnvelope = false', meta.hasEnvelope === false, meta);
  // displayField 仍为 note（上一节设置过），展示名会继续用备注；
  // 这里单独断言昵称已从密文换成明文。
  check('昵称换成明文', meta.nickname === '国际号', meta.nickname);
  check('备注仍然保留', meta.note === '我的国际号', meta.note);

  const rec = loadAccounts().find((a) => a.uid === UID);
  check('账号库已换成明文 access_token', rec?.access_token === 'AT_PLAIN', rec?.access_token);
  check('账号库已换成明文 refresh_token', rec?.refresh_token === 'RT_PLAIN', rec?.refresh_token);
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
