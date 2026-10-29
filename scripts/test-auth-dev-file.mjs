/**
 * 登录态 `-dev` 变体的回归测试。
 *
 * 背景（2026-10-29 实测）：WorkBuddy AI 5.9.3 的登录态文件名不再是常量，而是
 * `join(getSharedAuthDirectory(), `${authentication.id}.info`)`；当客户端进程带
 * `NODE_ENV=development` 时，id 会被追加 `-dev`，于是它读写
 * `workbuddy-desktop-ai-dev.info`。控制台原本只写 `workbuddy-desktop-ai.info`，
 * 表现为「点切换 → 客户端重启 → 账号没变」。
 *
 * 这个脚本验收四件事：
 * 1. 只有主文件时，切换**不会**凭空造出 `-dev` 文件；
 * 2. 两份都存在时，切换把两份都写成目标账号（客户端走哪个分支都能生效）；
 * 3. 两份都留了备份，且备份名能被 backups.mjs 归到正确档位；
 * 4. 恢复备份同样覆盖两份；`authFilePath()` 跟随"最新修改"的那份。
 *
 * 隔离：`HOME` / `LOCALAPPDATA` / `APPDATA`（登录态路径）+ `WB_SWITCH_HOME`
 * （账号库）全部指到临时目录，且必须在 import 之前设置。
 *
 * 运行：node scripts/test-auth-dev-file.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auth-dev-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
process.env.LOCALAPPDATA = path.join(tmp, 'appdata', 'local');
process.env.APPDATA = path.join(tmp, 'appdata', 'roaming');
process.env.WB_SWITCH_HOME = path.join(tmp, 'wb-switch');
fs.mkdirSync(process.env.WB_SWITCH_HOME, { recursive: true });

const { authFileCandidates, authFilePath, authWriteTargets } = await import('../server/workbuddy/variant.mjs');
const { saveAccounts, BACKUP_DIR } = await import('../server/workbuddy/accounts.mjs');
const { switchAccount, detectCurrentAccountForVariant } = await import('../server/workbuddy/auth.mjs');
const { listBackups, restoreBackup } = await import('../server/workbuddy/backups.mjs');

// 最后一道保险：路径不在临时目录就立刻停下，绝不碰真实登录态
const primary = authFileCandidates('ai')[0];
const dev = authFileCandidates('ai').find((p) => p.endsWith('-dev.info'));
if (!path.resolve(primary).startsWith(path.resolve(tmp) + path.sep)) {
  throw new Error(`测试隔离失败：路径不在临时目录：${primary}`);
}
if (!String(dev).endsWith('workbuddy-desktop-ai-dev.info')) {
  throw new Error(`-dev 候选名不符合预期：${dev}`);
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

/** 写一份登录态文件，模拟"该档位正登录着 uid" */
function writeAuth(file, uid) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        account: { uid, nickname: uid },
        accounts: [{ uid, nickname: uid }],
        allAccounts: [{ uid, nickname: uid }],
        auth: { accessToken: `AT_${uid}`, refreshToken: `RT_${uid}`, tokenType: 'Bearer', expiresAt: NOW + HOUR },
      },
      null,
      2
    )
  );
  return file;
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const uidOf = (file) => read(file)?.account?.uid;

section('0. 候选名：基名 + -dev 变体');
{
  const list = authFileCandidates('ai');
  check('含主文件候选', list.some((p) => p.endsWith('workbuddy-desktop-ai.info')), list);
  check('含 -dev 候选', list.some((p) => p.endsWith('workbuddy-desktop-ai-dev.info')), list);
  const cn = authFileCandidates('cn');
  check('国内版候选名不受影响', cn.some((p) => p.endsWith('workbuddy-desktop.info')) && cn.some((p) => p.endsWith('workbuddy-desktop-dev.info')), cn);
}

section('1. 只有主文件：切换只写主文件，不凭空创建 -dev');
{
  writeAuth(primary, 'old-uid');
  saveAccounts([
    {
      id: 'acct-a',
      uid: 'acct-a',
      nickname: 'A',
      variant: 'ai',
      domain: 'https://www.workbuddy.ai',
      access_token: 'AT_acct-a',
      refresh_token: 'RT_acct-a',
      expiresAt: NOW + 30 * 24 * HOUR,
      refreshExpiresAt: NOW + 30 * 24 * HOUR,
    },
  ]);
  check('切换前没有 -dev 文件', !fs.existsSync(dev));
  check('authWriteTargets 只有一份', authWriteTargets('ai').length === 1, authWriteTargets('ai'));
  const r = switchAccount('acct-a');
  check('切换成功', r.ok === true, r);
  check('主文件已是目标账号', uidOf(primary) === 'acct-a', uidOf(primary));
  check('没有创建 -dev 文件', !fs.existsSync(dev));
  check('返回的写入列表只有一份', Array.isArray(r.authFilePaths) && r.authFilePaths.length === 1, r.authFilePaths);
}

section('2. 两份都在：切换把两份都写成目标账号（升级后切号失效的根因）');
{
  writeAuth(primary, 'stale-uid');
  writeAuth(dev, 'old-uid');
  // 让 dev 比主文件"更新"，模拟客户端刚刷新过它
  const newer = new Date(Date.now() + 5000);
  fs.utimesSync(dev, newer, newer);
  check('authWriteTargets 覆盖两份', authWriteTargets('ai').length === 2, authWriteTargets('ai'));
  check('authFilePath 跟随最新的 dev 文件', authFilePath('ai') === dev, authFilePath('ai'));

  const r = switchAccount('acct-a');
  check('切换成功', r.ok === true, r);
  check('主文件已是目标账号', uidOf(primary) === 'acct-a', uidOf(primary));
  check('  -dev 文件同样是目标账号', uidOf(dev) === 'acct-a', uidOf(dev));
  check('两份 token 一致', read(primary).auth.accessToken === read(dev).auth.accessToken);
  check('返回 authFilePath 指向主文件', r.authFilePath === primary, r.authFilePath);
  check('返回 authFilePaths 含两份', r.authFilePaths.length === 2, r.authFilePaths);
  check('两份都留了备份', Boolean(r.backupPath) && fs.existsSync(r.backupPath), r.backupPath);
  const devBackups = listBackups().backups.filter((b) => /-dev\./.test(b.name) || b.name.includes('-dev.'));
  check('备份里能看到 -dev 那一份', devBackups.length >= 1, devBackups.map((b) => b.name));
  check('备份被归到国际版档位', devBackups.every((b) => b.variant === 'ai'), devBackups.map((b) => `${b.name}:${b.variant}`));
  check('当前账号识别为目标账号', detectCurrentAccountForVariant('ai').uid === 'acct-a', detectCurrentAccountForVariant('ai').uid);
}

section('3. 只更新 -dev（客户端自己刷新）：authFilePath 与"当前账号"跟随最新');
{
  writeAuth(dev, 'acct-b');
  const newer = new Date(Date.now() + 60_000);
  fs.utimesSync(dev, newer, newer);
  check('authFilePath 指向 -dev', authFilePath('ai') === dev, authFilePath('ai'));
  check('当前账号读的是 -dev 里的账号', detectCurrentAccountForVariant('ai').uid === 'acct-b', detectCurrentAccountForVariant('ai').uid);
  check('主文件保持原样（未被误改）', uidOf(primary) === 'acct-a', uidOf(primary));
}

section('4. 恢复备份：两份一起恢复');
{
  const name = `workbuddy-desktop-ai.2026-01-01T00-00-00-000Z.info`;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(BACKUP_DIR, name),
    JSON.stringify({ account: { uid: 'restored-uid' }, auth: { accessToken: 'AT_restored' } }, null, 2)
  );
  const r = restoreBackup(name);
  check('恢复成功', r.ok === true, r);
  check('主文件已回到备份内容', uidOf(primary) === 'restored-uid', uidOf(primary));
  check(' -dev 文件同步恢复', uidOf(dev) === 'restored-uid', uidOf(dev));
  check('返回 authFilePaths 含两份', Array.isArray(r.authFilePaths) && r.authFilePaths.length === 2, r.authFilePaths);
}

section('5. 拉起客户端时摘掉 NODE_ENV（让客户端走正式模式的登录态文件）');
{
  const { clientSpawnEnv } = await import('../server/targets/workbuddy.mjs');
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const env = clientSpawnEnv();
  check('返回的环境里没有 NODE_ENV', !('NODE_ENV' in env), Object.keys(env).filter((k) => k === 'NODE_ENV'));
  check('其余环境变量仍在', env.PATH === process.env.PATH || typeof env.PATH === 'string');
  if (saved === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = saved;
}

console.log('\n' + '─'.repeat(56));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('失败项：\n  - ' + failures.join('\n  - '));
  process.exitCode = 1;
} else {
  console.log('全部通过 ✓');
}
