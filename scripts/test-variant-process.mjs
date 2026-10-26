/**
 * 「切号只重启自己那一档」的回归测试。
 *
 * 背景（2026-10-26 反馈）：国内版与国际版是**两个独立安装的客户端**
 * （`WorkBuddy.exe` / `WorkBuddyAI.exe`），但控制台早先把"退出/重开"写死成
 * `WorkBuddy` + `WorkBuddy.exe`：
 * - 切**国际版**账号时，关掉并重新拉起的是**国内版**客户端 → 国际版那份登录态
 *   压根没被重新读取，用户看到的是"两个程序都动了一下，但国际版没换账号"；
 * - 反过来也同理，两档互相打扰。
 *
 * 这个测试锁住四条判据：
 * 1. 档位 → 进程名映射正确（cn 不含 WorkBuddyAI、ai 不含 WorkBuddy）；
 * 2. 两档进程名不重叠（PowerShell `-Name` / tasklist `IMAGENAME eq` 都是精确匹配，
 *    重叠就意味着切一档会误伤另一档）；
 * 3. 可执行文件不跨档：拿另一档的 exe 路径去定位，必须**不采用**它；
 * 4. 真实探测（若两档都在跑）拿到的 PID 集合互不相交。
 *
 * 只读：不结束任何进程、不启动任何程序。
 * 运行：node scripts/test-variant-process.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const { processNamesFor, appLabelOf, ALL_PROCESS_NAMES, getVariant } = await import('../server/workbuddy/variant.mjs');
const { detectWorkbuddyProcess, listWorkbuddyProcesses, findWorkbuddyExe, WORKBUDDY_PROCESS_NAMES } = await import(
  '../server/targets/workbuddy.mjs'
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
    failures.push(label);
    console.log(`  ✗ ${label}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
  }
}
function section(title) {
  console.log(`\n${title}`);
}

section('1. 档位 → 进程名映射');
check("cn 只认国内版进程名", JSON.stringify(processNamesFor('cn')) === JSON.stringify(['WorkBuddy', 'CodeBuddy']), processNamesFor('cn'));
check('ai 只认国际版进程名', JSON.stringify(processNamesFor('ai')) === JSON.stringify(['WorkBuddyAI']), processNamesFor('ai'));
check("'all' 返回两档并集", JSON.stringify(processNamesFor('all')) === JSON.stringify(ALL_PROCESS_NAMES), processNamesFor('all'));
check(
  "不传档位时沿用历史默认（国内版），不影响 models.json 相关判定",
  JSON.stringify(processNamesFor(undefined)) === JSON.stringify(WORKBUDDY_PROCESS_NAMES)
);
check('传账号档位对象也能归一化', JSON.stringify(processNamesFor(getVariant('ai'))) === JSON.stringify(['WorkBuddyAI']));

section('2. 两档进程名不重叠（切一档绝不误伤另一档）');
const cnNames = processNamesFor('cn').map((n) => n.toLowerCase());
const aiNames = processNamesFor('ai').map((n) => n.toLowerCase());
check('cn 与 ai 无交集', cnNames.every((n) => !aiNames.includes(n)), { cnNames, aiNames });
check('cn 不含 WorkBuddyAI', !cnNames.includes('workbuddyai'));
check('ai 不含 WorkBuddy', !aiNames.includes('workbuddy'));
check('两档都不含控制台自身（WorkBuddy Console）', ![...cnNames, ...aiNames].some((n) => n.includes('console')));

section('3. 客户端显示名');
check('cn = WorkBuddy', appLabelOf('cn') === 'WorkBuddy');
check('ai = WorkBuddy AI', appLabelOf('ai') === 'WorkBuddy AI');
check('未知名回落国内版', appLabelOf('whatever') === 'WorkBuddy');

section('4. 可执行文件不跨档');
const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
const aiExe = path.join(localAppData, 'Programs', 'WorkBuddyAI', 'WorkBuddyAI.exe');
const cnExe = path.join(localAppData, 'Programs', 'WorkBuddy', 'WorkBuddy.exe');
const aiInstalled = fs.existsSync(aiExe);
const cnInstalled = fs.existsSync(cnExe);
check('国际版 exe 按 ai 档位能定位到', !aiInstalled || findWorkbuddyExe(aiExe, 'ai') === aiExe, findWorkbuddyExe(aiExe, 'ai'));
check('国内版 exe 按 cn 档位能定位到', !cnInstalled || findWorkbuddyExe(cnExe, 'cn') === cnExe, findWorkbuddyExe(cnExe, 'cn'));
// 关键断言：把国际版的路径喂给国内版，绝不能被采纳（否则切国内版会把国际版拉起来）
check(
  'ai 的 exe 路径不会被 cn 档位采用',
  findWorkbuddyExe(aiExe, 'cn') !== aiExe,
  findWorkbuddyExe(aiExe, 'cn')
);
check(
  'cn 的 exe 路径不会被 ai 档位采用',
  findWorkbuddyExe(cnExe, 'ai') !== cnExe,
  findWorkbuddyExe(cnExe, 'ai')
);

section('5. 真实探测：两档 PID 集合互不相交（只读）');
const cnList = await listWorkbuddyProcesses({ variant: 'cn' });
const aiList = await listWorkbuddyProcesses({ variant: 'ai' });
const cnPids = new Set(cnList.processes.map((p) => p.pid));
const aiPids = new Set(aiList.processes.map((p) => p.pid));
const overlap = [...cnPids].filter((p) => aiPids.has(p));
check('探测本身没有报错', !cnList.error && !aiList.error, { cn: cnList.error, ai: aiList.error });
check('同一 PID 不会同时被算作两档', overlap.length === 0, overlap);
if (aiPids.size) {
  const aiProc = await detectWorkbuddyProcess({ variant: 'ai' });
  check('ai 档位探测到的进程确实来自 WorkBuddyAI.exe', /WorkBuddyAI\.exe$/i.test(aiProc.exePath || '') || aiProc.exePath == null, aiProc.exePath);
}
if (cnPids.size) {
  const cnProc = await detectWorkbuddyProcess({ variant: 'cn' });
  check(
    'cn 档位探测到的进程不会来自 WorkBuddyAI.exe',
    !/WorkBuddyAI\.exe$/i.test(cnProc.exePath || ''),
    cnProc.exePath
  );
}
console.log(
  `  · 当前实况：国内版 ${cnPids.size} 个进程 / 国际版 ${aiPids.size} 个进程` +
    `${aiInstalled ? '' : '（本机未安装国际版）'}${cnInstalled ? '' : '（本机未安装国内版）'}`
);

console.log('\n' + '─'.repeat(56));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('失败项：\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('全部通过 ✓');
