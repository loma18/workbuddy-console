/**
 * 退出客户端时的**档位作用域**回归测试（离线，仅 Windows；其他平台自动跳过）。
 *
 * 守护 2026-10-26 用户反馈：「国际版和国内版同时登录时，切国内版账号必然失败，
 * 提示『无法退出 WorkBuddy（仍在运行：PID …）』，怀疑退出时把国际版也一起检测了」。
 *
 * 实测真因不是检测串档，而是 `taskkill /T` 的语义：它要求**整棵进程树**都能终止，
 * 而 WorkBuddy 5.9 的 agent 会话会在客户端下面挂沙箱化的 shell / MCP 子进程，
 * 只要有一个子进程拒绝终止，Windows 就拒绝杀它的父进程 —— 客户端反而活下来。
 * 修复后强杀路径是「先尽力按树杀，再逐个 /F（不带 /T）」。
 *
 * 本测试用 node.exe 的副本冒充客户端，断言：
 *   1. 枚举本档位时**不会**混入"本档位名 + AI"的进程（`X` vs `XAI`，对应真实的两档名）；
 *   2. 也不会混入"以目标名开头"的其它进程（防前缀匹配）；
 *   3. 真实档位名（`WorkBuddy` / `WorkBuddyAI`）**只做只读枚举**，验证跨档不串——不杀；
 *   4. 等待窗口里高频调用的轻量探针（tasklist）同样按映像名精确匹配；
 *   5. `stopWorkbuddy` 只杀目标档位，同前缀替身毫发无损；且客户端下面挂着子进程时
 *      （模拟 agent 会话）退出依然成功——这正是旧实现被 `taskkill /T` 拖死的场景，
 *      替身又是控制台程序、不吃 WM_CLOSE，所以这里必然走强杀路径。
 *
 * 替身用**每轮唯一的隔离映像名**（`WbScope<pid>` 等），不碰真实客户端，见 TAG 处的说明。
 *
 * 运行：node scripts/test-stop-variant-scope.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { listWorkbuddyProcesses, stopWorkbuddy, detectWorkbuddyProcess, anyWorkbuddyProcess } from '../server/targets/workbuddy.mjs';

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

const tmpDir = path.join(os.tmpdir(), `wb-scope-${process.pid}`);
fs.mkdirSync(tmpDir, { recursive: true });

/**
 * ⚠️ 替身**不能**用真实的映像名（`WorkBuddy` / `WorkBuddyAI`）。
 *
 * 一开始就是那么写的，结果本机恰好开着国内版客户端时，`stopWorkbuddy({variant:'cn'})`
 * 把**用户真实的 9 个 WorkBuddy 进程全杀了**（2026-10-26 实测，测试跑在开发机上）。
 * 现在改用每轮唯一的隔离名：`WbScope<pid>` / `…AI` / `…Extra` —— 前缀包含关系一致
 * （`X` 是 `XAI` 的前缀，也是 `XExtra` 的前缀），验证的仍是同一件事，但永远碰不到真客户端。
 */
const TAG = `WbScope${process.pid}`;
const CN_NAME = TAG;
const AI_NAME = `${TAG}AI`;
const DECOY_NAME = `${TAG}Extra`;

/** 造一个"冒充某档客户端"的可执行文件（node.exe 的副本，映像名即进程名） */
function makeFake(name) {
  const p = path.join(tmpDir, `${name}.exe`);
  fs.copyFileSync(process.execPath, p);
  return p;
}

/**
 * 拉起替身并保持存活；`withChild` 时再挂一个子进程
 * （模拟 WorkBuddy 客户端下面那些 agent 会话 / MCP / shell 子进程）。
 *
 * 子进程用的是替身自己的 exe（`process.execPath` 在替身里就是它自己），
 * 因此映像名与父进程相同 —— 和 Electron 的 helper 进程一个样。
 */
function spawnFake(exe, { withChild = false } = {}) {
  const script = withChild
    ? `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); setInterval(() => {}, 1000)`
    : `setInterval(() => {}, 1000)`;
  const child = spawn(exe, ['-e', script], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child.pid;
}

/** 兜底清理：无论断言成败都要确保替身不留在系统里 */
async function killHard(pid) {
  await new Promise((resolve) => {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

/** 安全阀：枚举出来的每一行都必须来自本测试的临时目录，否则立刻中止（绝不误杀真客户端） */
function assertOwnProcesses(rows, where) {
  for (const r of rows) {
    if (!r.exePath || !path.resolve(r.exePath).startsWith(path.resolve(tmpDir))) {
      throw new Error(`[安全阀] ${where} 枚举到非本测试的进程（${r.name}:${r.pid} → ${r.exePath || '路径未知'}），已中止`);
    }
  }
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('非 Windows 平台，跳过档位作用域测试');
    return;
  }

  const cnExe = makeFake(CN_NAME);
  const aiExe = makeFake(AI_NAME);
  const decoyExe = makeFake(DECOY_NAME);

  const cnPid = spawnFake(cnExe, { withChild: true });
  const aiPid = spawnFake(aiExe);
  const decoyPid = spawnFake(decoyExe);

  try {
    await runChecks({ cnPid, aiPid, decoyPid });
  } finally {
    // 断言失败（stopWorkbuddy 抛错）也必须清场，否则替身残留到下一轮，
    // 下一轮的枚举里会混进上轮的尸体，排查时非常容易被带偏
    for (const pid of [cnPid, aiPid, decoyPid]) await killHard(pid);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

async function runChecks({ cnPid, aiPid, decoyPid }) {
  await new Promise((r) => setTimeout(r, 1500));

  /* ---------------------------------------------------------------- */
  section('1. 枚举按映像名精确匹配：本档位不混入同前缀的其它进程');
  /* ---------------------------------------------------------------- */
  {
    const cn = await listWorkbuddyProcesses({ names: [CN_NAME] });
    const ai = await listWorkbuddyProcesses({ names: [AI_NAME] });
    assertOwnProcesses(cn.processes, '国内版枚举');
    const cnPids = cn.processes.map((p) => p.pid);
    const aiPids = ai.processes.map((p) => p.pid);
    check('国内版枚举到替身', cnPids.includes(cnPid), cnPids);
    check('国内版枚举不含"本档位名 + AI"的替身', !cnPids.includes(aiPid), cnPids);
    check(`国内版枚举不含同前缀替身（${DECOY_NAME}）`, !cnPids.includes(decoyPid), cnPids);
    check('国际版枚举到自己的替身', aiPids.includes(aiPid), aiPids);
    check('国际版枚举不含国内版替身', !aiPids.includes(cnPid), aiPids);
    check('国际版枚举不含同前缀替身', !aiPids.includes(decoyPid), aiPids);

    const det = await detectWorkbuddyProcess({ names: [CN_NAME] });
    check('探测国内版时 running=true 且 pid 是替身', det.running === true && det.pid === cnPid, det);
  }

  /* ---------------------------------------------------------------- */
  section('2. 真实档位名只做只读校验：跨档检测不会把另一档算进来');
  /* ---------------------------------------------------------------- */
  {
    // 这一段**只枚举、不杀**，所以即使本机正开着两个真实客户端也安全。
    // 它守的正是用户最初的猜测：「切国内版时，检测进程有没有退出会不会把国际版也算上」。
    const cnReal = await listWorkbuddyProcesses({ variant: 'cn' });
    const aiReal = await listWorkbuddyProcesses({ variant: 'ai' });
    check(
      '国内版枚举里没有 WorkBuddyAI',
      !cnReal.processes.some((p) => String(p.name || '').toLowerCase() === 'workbuddyai'),
      cnReal.processes.map((p) => `${p.name}:${p.pid}`)
    );
    check(
      '国际版枚举里没有 WorkBuddy',
      !aiReal.processes.some((p) => String(p.name || '').toLowerCase() === 'workbuddy'),
      aiReal.processes.map((p) => `${p.name}:${p.pid}`)
    );
  }

  /* ---------------------------------------------------------------- */
  section('3. 轻量存活探针（等待窗口内高频调用）同样是精确匹配的');
  /* ---------------------------------------------------------------- */
  {
    check('国内版探针 = 存活', (await anyWorkbuddyProcess({ names: [CN_NAME] })) === true);
    check('国际版探针 = 存活', (await anyWorkbuddyProcess({ names: [AI_NAME] })) === true);
    // 用一个绝对不存在的映像名验证"探针会给出 false"，否则上面的 true 说明不了什么
    check('不存在的映像名 = 不存活', (await anyWorkbuddyProcess({ names: [`${TAG}NoSuch`] })) === false);
  }

  /* ---------------------------------------------------------------- */
  section('4. 退出国内版：只杀国内版替身，同前缀替身毫发无损');
  /* ---------------------------------------------------------------- */
  {
    // names 优先于 variant：显式限定到隔离映像名，杀不到任何真客户端；variant 只用来取文案/回传
    const r = await stopWorkbuddy({ names: [CN_NAME], variant: 'cn', gracefulMs: 600, forceMs: 8000 });
    check('返回 wasRunning=true', r.wasRunning === true, r);
    check('档位标记为 cn', r.variant === 'cn', r.variant);
    check('killed 里不含同前缀替身', !r.killed.includes(aiPid) && !r.killed.includes(decoyPid), r.killed);

    const cnAfter = await listWorkbuddyProcesses({ names: [CN_NAME] });
    const aiAfter = await listWorkbuddyProcesses({ names: [AI_NAME] });
    const decoyAfter = await listWorkbuddyProcesses({ names: [DECOY_NAME] });
    check('国内版替身已退出', !cnAfter.processes.some((p) => p.pid === cnPid), cnAfter.processes.map((p) => p.pid));
    check('同前缀替身（…AI）仍在运行', aiAfter.processes.some((p) => p.pid === aiPid), aiAfter.processes.map((p) => p.pid));
    check('同前缀替身（…Extra）仍在运行', decoyAfter.processes.some((p) => p.pid === decoyPid), decoyAfter.processes.map((p) => p.pid));
  }

  /* ---------------------------------------------------------------- */
  section('5. 客户端下面挂着子进程时，退出依然成功');
  /* ---------------------------------------------------------------- */
  {
    // 第 4 节那个国内版替身带了一个子进程（模拟 agent 会话），
    // 若实现仍依赖 taskkill /T 的"整棵树都能杀"，这里就会抛错。
    const cnNow = await listWorkbuddyProcesses({ names: [CN_NAME] });
    check('国内版进程表已清空', cnNow.processes.length === 0, cnNow.processes.map((p) => p.pid));
    const again = await stopWorkbuddy({ names: [CN_NAME], variant: 'cn', gracefulMs: 300, forceMs: 2000 });
    check('再退一次是空转（wasRunning=false）', again.wasRunning === false, again);
  }
}

await main();

console.log(`\n${'─'.repeat(56)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log('全部通过 ✓');
}
