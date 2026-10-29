import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { loadConfig } from '../store/config.mjs';
import { matchPlatformUrl } from '../providers/registry.mjs';
import { appLabelOf, getVariant, processNamesFor } from '../workbuddy/variant.mjs';

/** 检查目录是否具备 WorkBuddy 数据目录的特征文件 */
function inspectDir(dir) {
  const has = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  const markers = {
    modelsJson: has(path.join(dir, 'models.json')),
    projects: has(path.join(dir, 'projects')),
    sessions: has(path.join(dir, 'sessions')),
    db: has(path.join(dir, 'workbuddy.db')),
  };
  const score = Object.values(markers).filter(Boolean).length;
  return { ...markers, score, exists: score > 0 };
}

/**
 * 自动检测 WorkBuddy 数据目录：
 * 1. 用户手动指定的目录（settings.workbuddyDir，优先但需通过特征校验才标记 valid）
 * 2. 默认位置 ~/.workbuddy（WorkBuddy 桌面端约定位置）
 * 3. 常见安装位置的候选目录，按特征文件（models.json/projects/sessions/workbuddy.db）命中判定
 */
export function detectWorkbuddyDir() {
  const cfg = loadConfig();
  const override = String(cfg.settings?.workbuddyDir || '').trim();
  const home = os.homedir();

  const candidates = [];
  if (override) candidates.push({ dir: path.resolve(override), source: 'override', sourceLabel: '手动指定' });
  candidates.push({ dir: path.join(home, '.workbuddy'), source: 'default', sourceLabel: '默认位置' });
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) candidates.push({ dir: path.join(process.env.LOCALAPPDATA, 'WorkBuddy'), source: 'scan', sourceLabel: '自动检测' });
    if (process.env.APPDATA) candidates.push({ dir: path.join(process.env.APPDATA, 'WorkBuddy'), source: 'scan', sourceLabel: '自动检测' });
  } else {
    candidates.push({ dir: path.join(home, 'Library', 'Application Support', 'WorkBuddy'), source: 'scan', sourceLabel: '自动检测' });
    candidates.push({ dir: path.join(home, '.config', 'WorkBuddy'), source: 'scan', sourceLabel: '自动检测' });
  }

  for (const c of candidates) {
    const markers = inspectDir(c.dir);
    if (markers.score > 0) return { ...c, markers, valid: true };
  }
  // 全部未命中：返回最高优先级候选并标记未检测到（手动指定优先，其次默认位置）
  const fallback = candidates[0] || { dir: path.join(home, '.workbuddy'), source: 'default', sourceLabel: '默认位置' };
  return { ...fallback, markers: inspectDir(fallback.dir), valid: false };
}

export function workbuddyDir() {
  return detectWorkbuddyDir().dir;
}

export function modelsJsonPath() {
  return path.join(workbuddyDir(), 'models.json');
}

export function readModelsJson() {
  const p = modelsJsonPath();
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(raw)) return { entries: raw, exists: true };
    return { entries: [], exists: true, invalid: true };
  } catch (err) {
    if (err?.code === 'ENOENT') return { entries: [], exists: false };
    // 语法级损坏同样标记 invalid，让调用方优雅降级（载入拒绝 / 移除拒绝 / 列表提示），而非抛异常
    return { entries: [], exists: true, invalid: true, parseError: err?.message };
  }
}

/** 仅认定指向已注册平台端点的自定义条目属于本工具的管理范围（用户手动加的其他条目永不触碰） */
export function isManagedEntry(e) {
  return !!matchPlatformUrl(e?.url);
}

const BACKUP_KEEP = 10;

function backupModelsJson() {
  const p = modelsJsonPath();
  if (!fs.existsSync(p)) return null;
  // 文件名保留毫秒且查重递增：同一秒内连续两次写入也不得互相覆盖（真实踩过的坑）
  const base = new Date().toISOString().replace(/[:.]/g, '-');
  let bak = `${p}.bak-${base}`;
  for (let i = 1; fs.existsSync(bak); i++) bak = `${p}.bak-${base}-${i}`;
  fs.copyFileSync(p, bak);
  // 备份保留策略：只留最近 N 份，避免无限累积
  try {
    const dir = path.dirname(p);
    const olds = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${path.basename(p)}.bak-`))
      .sort()
      .slice(0, -BACKUP_KEEP);
    for (const f of olds) fs.unlinkSync(path.join(dir, f));
  } catch {
    /* 清理失败不影响主流程 */
  }
  return bak;
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function verifyEntries(ids, apiKey) {
  const check = JSON.parse(fs.readFileSync(modelsJsonPath(), 'utf8'));
  if (!Array.isArray(check)) throw new Error('回读校验失败：models.json 不是数组');
  for (const id of ids) {
    const e = check.find((x) => x && x.id === id);
    if (!e) throw new Error(`回读校验失败：缺少 ${id}`);
    if (apiKey && e.apiKey !== apiKey) throw new Error(`回读校验失败：${id} 的 apiKey 不一致`);
  }
}

/**
 * 批量载入模型到 WorkBuddy：备份 -> 按 id 合并（已存在则更新）-> 原子写 -> 回读校验 -> 失败回滚
 */
export function loadModels(entries) {
  if (!entries?.length) throw new Error('没有可载入的模型');
  if (!fs.existsSync(workbuddyDir())) {
    throw new Error(`WorkBuddy 数据目录不存在：${workbuddyDir()}（请先安装并运行一次 WorkBuddy）`);
  }
  const { entries: current, invalid } = readModelsJson();
  if (invalid) throw new Error('models.json 格式异常（不是数组），请先在 WorkBuddy 中检查自定义模型配置');

  const backup = backupModelsJson();
  const byId = new Map(current.map((e) => [e.id, e]));
  let added = 0;
  let updated = 0;
  for (const m of entries) {
    const existing = byId.get(m.id);
    if (existing) {
      Object.assign(existing, m);
      updated++;
    } else {
      current.push(m);
      byId.set(m.id, m);
      added++;
    }
  }
  try {
    atomicWriteJson(modelsJsonPath(), current);
    verifyEntries(entries.map((e) => e.id), entries[0]?.apiKey);
    return { added, updated, backup, total: current.length };
  } catch (err) {
    if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, modelsJsonPath());
    throw err;
  }
}

/** 从 models.json 移除本工具载入的条目（任何平台的；用户手动加的其他条目永不触碰） */
export function removeModels(ids) {
  const { entries, invalid } = readModelsJson();
  if (invalid) return { invalid: true, removed: 0 };
  const idSet = new Set(ids);
  const kept = entries.filter((e) => !(idSet.has(e?.id) && isManagedEntry(e)));
  const removed = entries.length - kept.length;
  const backup = backupModelsJson();
  try {
    atomicWriteJson(modelsJsonPath(), kept);
    return { removed, backup, total: kept.length };
  } catch (err) {
    if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, modelsJsonPath());
    throw err;
  }
}

/** models.json 最后修改时间（null = 文件不存在） */
export function modelsJsonMtime() {
  try {
    return fs.statSync(modelsJsonPath()).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 检测"模型配置已变更但 WorkBuddy 尚未读取"：
 * WorkBuddy 只在启动时读取 models.json，若文件修改时间晚于其进程启动时间（留 3 秒容差），
 * 则运行中的 WorkBuddy 需要重启才能让新增/移除的模型生效。
 */
export function isPendingRestart(proc) {
  const mtime = modelsJsonMtime();
  if (!proc?.running || !proc?.startTime || mtime == null) return false;
  return mtime > proc.startTime + 3000;
}

/** 已载入的本工具条目（key 脱敏，标注来源平台） */
export function listLoaded() {
  const { entries, exists, invalid } = readModelsJson();
  const loaded = entries.filter(isManagedEntry).map((e) => ({
    id: e.id,
    name: e.name || e.id,
    platform: matchPlatformUrl(e.url) || 'unknown',
    keyTail: typeof e.apiKey === 'string' ? e.apiKey.slice(-4) : '',
    supportsToolCall: !!e.supportsToolCall,
    supportsImages: !!e.supportsImages,
    supportsReasoning: !!e.supportsReasoning,
  }));
  return { exists, invalid, dir: workbuddyDir(), modelsJsonPath: modelsJsonPath(), loaded };
}

function run(cmd, args, timeoutMs = 10000, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stderr }));
      resolve(stdout);
    });
  });
}

/** 把 execFile 的报错压成一句可读原因（原始 message 会带上整条命令行，不适合展示） */
function shortExecError(err) {
  const code = err?.code;
  if (code && typeof code === 'string') return code; // EPERM / EACCES / ENOENT ...
  const first = String(err?.stderr || '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean);
  return first ? first.slice(0, 120) : '命令执行失败或不被允许';
}

/**
 * 进程名的默认值 = **国内版**（`WorkBuddy` / 旧名 `CodeBuddy`）。
 *
 * 为什么不默认"两档都算"：`models.json`、`~/.workbuddy` 数据目录、模型载入后的
 * "待重启"判定全都是国内版的事，默认值必须保持历史语义。国际版要显式传
 * `{ variant: 'ai' }`（进程名 `WorkBuddyAI`）——两档是两个独立客户端，
 * 切号时只该动自己那一档。
 *
 * ⚠️ 千万别改成通配符（`WorkBuddy*`）：两者的匹配都是**按映像名精确**的，而控制台自己打包后的
 * 进程叫 `WorkBuddy Console`（electron-builder 的 productName）。一旦放宽成前缀匹配，
 * 切号时就会**把控制台自己杀掉**，切换动作当场中断。
 * （同理 `WorkBuddy` 也**不会**匹配到 `WorkBuddyAI`：PowerShell 的 `-Name` 不带通配符时是精确匹配，
 * tasklist 的 `IMAGENAME eq` 同样是精确比较，实测两档进程各自独立。）
 */
export const WORKBUDDY_PROCESS_NAMES = getVariant('cn').processNames;

/**
 * 解析"这次要动哪些进程名"。
 *
 * 优先级：显式 `names`（自动化测试用） > `variant`（'cn' / 'ai' / 'all'） > 默认国内版。
 */
function resolveNames({ names, variant } = {}) {
  if (Array.isArray(names) && names.length) return names;
  if (variant) return processNamesFor(variant);
  return WORKBUDDY_PROCESS_NAMES;
}

/** 去掉 `.exe` 并转小写：比较映像名时统一口径 */
function bareName(name) {
  return String(name || '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

/** 正则转义：进程名会被拼进 RegExp */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 本次要动的映像名集合（小写、去 `.exe`）。
 *
 * 枚举结果一律按它**精确**过滤，确保「切国内版只动国内版」不是靠调用方自觉：
 * `WorkBuddy` 与 `WorkBuddyAI` 是两个客户端，任何前缀/子串匹配都会把另一档卷进来。
 */
function nameSet(names) {
  return new Set(names.map(bareName).filter(Boolean));
}

/** 该进程是不是本次目标档位自己的进程（按映像名精确比对） */
function isOwnVariantProcess(row, allowed) {
  const n = bareName(row?.name);
  return !!n && allowed.has(n);
}

/** 解析 PowerShell 序列化的启动时间：PS 5.1 为 "/Date(ms)/"，PS 7 为 ISO 字符串 */
function parseStartTime(v) {
  if (!v) return null;
  const m = String(v).match(/Date\((\d+)/);
  if (m) return Number(m[1]);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

/** PowerShell 的候选启动方式：PATH 里的 powershell.exe + 系统绝对路径兜底 */
const POWERSHELL_CANDIDATES = [
  'powershell.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
];

/**
 * 按候选列表依次尝试启动 PowerShell。
 *
 * 打包安装后的 Electron 应用环境变量可能与开发时不同（个别机器 PATH 里
 * 找不到 powershell.exe，报 ENOENT → 界面显示"PowerShell 不可用"），
 * 但 System32 下的绝对路径在所有 Windows 上都存在，作为兜底足够稳。
 */
async function runPowerShell(args, timeoutMs = 15000) {
  let lastErr;
  for (const cmd of POWERSHELL_CANDIDATES) {
    try {
      return await run(cmd, args, timeoutMs);
    } catch (err) {
      lastErr = err;
      // ENOENT（找不到可执行文件）才值得换下一个候选；其他错误（超时/权限）换路径也没用
      if (err?.code !== 'ENOENT') throw err;
    }
  }
  throw lastErr;
}

/**
 * Windows 主路径：枚举**全部**匹配进程，按启动时间升序。
 * 对默认进程名来说，第一个就是主进程（Electron 的渲染/GPU/工具进程都是它的子进程）。
 *
 * 脚本刻意写成 `@(...)` + 显式 `'[]'` 分支，而**不是**直接管道 `ConvertTo-Json`：
 * 没有匹配进程时，`Get-Process -Name X` 会把 `$?` 置为 false，PowerShell 于是以**退出码 1**
 * 结束（stdout 为空、stderr 也被 SilentlyContinue 吞掉）。`run()` 见非 0 即 reject，
 * 调用方只能判定"PowerShell 不可用"并降级到 tasklist —— 明明只是"没有进程"，却白白多跑一趟
 * 更慢的 tasklist，还附送一句"已改用 tasklist 完成检测"的误导性 warning。
 * 现在无匹配恒输出 `[]`、退出码恒为 0，"空结果"与"探测失败"彻底分开。
 */
async function listViaPowerShell(names = WORKBUDDY_PROCESS_NAMES) {
  // 不用 Sort-Object StartTime：个别进程取不到 StartTime 时会让整条管道报错，
  // 改为取回全部进程后在 JS 里排序。
  const ps =
    `$ErrorActionPreference='Stop'; $p = @(Get-Process -Name ${names.join(',')} -ErrorAction SilentlyContinue); ` +
    `if ($p.Count -gt 0) { $p | Select-Object Id,ProcessName,Path,StartTime | ConvertTo-Json -Compress } else { '[]' }`;
  const stdout = await runPowerShell(['-NoProfile', '-NonInteractive', '-Command', ps], 15000);
  const t = stdout.trim();
  if (!t) return [];
  const parsed = JSON.parse(t);
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter(Boolean)
    .map((o) => ({
      pid: Number(o.Id),
      name: o.ProcessName,
      exePath: o.Path || null,
      startTime: parseStartTime(o.StartTime),
    }))
    .filter((p) => Number.isFinite(p.pid) && p.pid > 0)
    .sort((a, b) => (a.startTime || Number.MAX_SAFE_INTEGER) - (b.startTime || Number.MAX_SAFE_INTEGER));
}

/** Windows 主路径的探测版：取启动最早的那个 = 应用真正启动的时刻 */
async function detectViaPowerShell(names = WORKBUDDY_PROCESS_NAMES) {
  const rows = await listViaPowerShell(names);
  if (!rows.length) return null;
  // WorkBuddy 基于 Electron，会有多个进程（主进程 + 渲染/GPU/工具子进程）。
  const main = rows[0];
  return {
    running: true,
    pid: main.pid,
    name: main.name,
    exePath: main.exePath,
    startTime: main.startTime,
    processCount: rows.length,
    platform: 'win32',
    method: 'powershell',
  };
}

/**
 * Windows 兜底：tasklist 不依赖 PowerShell，被安全策略限制的环境下通常仍可用。
 *
 * 返回**全部**匹配行（每个 PID 一行）。tasklist 给不了启动时间，
 * 所以这里连主进程是谁都分不出来——靠 `taskkill /T` 顺着进程树倒推。
 */
async function listViaTasklist(names = WORKBUDDY_PROCESS_NAMES) {
  const out = [];
  for (const name of names) {
    const exe = /\.exe$/i.test(name) ? name : `${name}.exe`;
    let stdout = '';
    try {
      stdout = await run('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH'], 10000);
    } catch {
      continue;
    }
    for (const line of stdout
      .split('\n')
      .map((s) => s.trim())) {
      // 无匹配时 tasklist 会打印 "INFO: No tasks are running..." 之类的说明，不含 exe 名
      if (!line.toLowerCase().includes(exe.toLowerCase())) continue;
      const cols = line.split('","').map((s) => s.replace(/^"|"$/g, ''));
      const pid = Number(cols[1]);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      out.push({
        pid,
        name: exe.replace(/\.exe$/i, ''),
        exePath: null,
        startTime: null, // tasklist 不提供启动时间，因此无法判断配置是否"待重启"
        startTimeUnknown: true,
      });
    }
  }
  return out;
}

/** Windows 兜底探测版：只关心"有没有在跑"，随便取一个 PID 即可 */
async function detectViaTasklist(names = WORKBUDDY_PROCESS_NAMES) {
  const rows = await listViaTasklist(names);
  const first = rows[0];
  if (!first) return null;
  return {
    running: true,
    pid: first.pid,
    name: first.name,
    exePath: null,
    startTime: null,
    processCount: rows.length,
    platform: 'win32',
    method: 'tasklist',
    startTimeUnknown: true,
  };
}

/* ---------------------------------------------------------------------- *
 * macOS / Linux：ps 全量进程表（替代 pgrep，见 listViaPs 注释）
 * ---------------------------------------------------------------------- */

const PS_MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** 解析 `ps -axo pid=,ppid=,lstart=,command=` 输出；供 listViaPs 与单元测试使用 */
export function parsePsProcessTable(stdout) {
  const rows = [];
  const re = /^\s*(\d+)\s+(\d+)\s+[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})\s+(.*)$/;
  for (const line of String(stdout).split('\n')) {
    const m = line.match(re);
    if (!m) continue;
    const mo = PS_MONTHS[m[3]];
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const command = m[9] || '';
    let startTime = null;
    if (mo !== undefined) {
      startTime = new Date(Number(m[8]), mo, Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])).getTime();
    }
    rows.push({ pid, ppid, command, startTime });
  }
  return rows;
}

/**
 * macOS / Linux 主路径的**核心筛选**（纯函数，供单测）：
 * 1) 剔除本工具自己的进程子树（自己 + 全部后代）——⚠️ 这是 macOS「意外退出」的根因修复：
 *    pgrep 时代按完整命令行做子串匹配，而打包后的控制台进程名就叫 "WorkBuddy Console"
 *    （web 版脚本路径也常含 workbuddy 字样），模式 WorkBuddy|CodeBuddy 必然连自己一起命中，
 *    切号时把自己杀掉 → macOS 弹「意外退出」（macOS 用户实测 2026-10-17）。
 *    Windows 分支无此问题：那里的匹配按映像名**精确**匹配。
 * 2) 按名称模式匹配命令行（大小写不敏感）；
 *    ⚠️ 映像名后面必须**不是**字母数字：`WorkBuddy` 不能匹配 `WorkBuddyAI`（另一档客户端），
 *    但要继续匹配 `WorkBuddy Helper` 与 `WorkBuddy.app/Contents/MacOS/WorkBuddy`。
 *    早先是纯子串匹配，两档同时登录时国际版会被算进国内版的进程表（跨档误杀/误判）。
 * 3) 按启动时间升序：最早 = 主进程，先杀主进程，Electron 子进程随之退出；
 *    反过来先强杀 helper 会触发主进程 Chromium CHECK 失败（SIGTRAP）→ 真正的 WorkBuddy「意外退出」。
 */
export function selectWorkbuddyRows(rows, names = WORKBUDDY_PROCESS_NAMES) {
  const own = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (own.has(r.pid) || !own.has(r.ppid)) continue;
      own.add(r.pid);
      grew = true;
    }
  }
  const pattern = new RegExp(`(${names.map((n) => escapeRegExp(n.replace(/\.exe$/i, ''))).join('|')})(?![\\w])`, 'i');
  return rows
    .filter((r) => !own.has(r.pid) && pattern.test(r.command))
    .map((r) => {
      const exePath = r.command.split(/\s+/)[0] || null; // 首个空格前 = 可执行文件路径（无参启动的 Electron 主进程成立）
      return {
        pid: r.pid,
        name: exePath ? exePath.split('/').pop() : null,
        exePath,
        startTime: r.startTime,
        command: r.command,
      };
    })
    .sort((a, b) => (a.startTime ?? Number.MAX_SAFE_INTEGER) - (b.startTime ?? Number.MAX_SAFE_INTEGER));
}

async function listViaPs(names = WORKBUDDY_PROCESS_NAMES) {
  // 全量进程表可能很大（每行含完整命令行），放宽 execFile 的 1MB 默认上限
  const stdout = await run('ps', ['-axo', 'pid=,ppid=,lstart=,command='], 8000, { maxBuffer: 16 * 1024 * 1024 });
  return selectWorkbuddyRows(parsePsProcessTable(stdout), names);
}

export async function detectWorkbuddyProcess({ names, variant } = {}) {
  const procs = resolveNames({ names, variant });
  const platform = process.platform;

  if (platform === 'win32') {
    const failures = []; // 探测方式**本身**没能执行（不代表"没进程"）
    let probed = false; // 是否至少有一种方式成功执行完

    try {
      const r = await detectViaPowerShell(procs);
      probed = true;
      if (r) return r;
    } catch (err) {
      // 记录失败原因仅用于全失败时的 error 汇总；tasklist 兜底成功后不再对外透出
      // ——探测已完成、结果可信，把内部降级细节摆给用户只会造成误导（实测反馈 2026-10）
      failures.push(`PowerShell 探测失败（${shortExecError(err)}）`);
    }
    try {
      const r = await detectViaTasklist(procs);
      probed = true;
      if (r) return r;
    } catch (err) {
      failures.push(`tasklist 探测失败（${shortExecError(err)}）`);
    }

    /**
     * 只要有一种方式**成功跑完**并且没找到进程，这就是"确实没在运行"的确定答案。
     *
     * 早先这里写反了：把"另一种方式不可用"也当成"无法判定"（只要 failures 非空就报 error）。
     * 后果是——在 PowerShell 被安全策略拦掉的机器上（本机就是），**杀掉 WorkBuddy 之后的那次复检
     * 必然报"无法确认"**，于是切号在最后一道门上被自己拦住、登录态永远写不进去，
     * 界面还显示一句把人往"手动退出"引的误导文案。实测踩过。
     *
     * 安全性没有降低：全都被拦（probed === false）时仍然返回 error，调用方照旧保守拒绝。
     * 曾在此处给"有降级"的确定答案附带 warning，用户反馈同样误导（2026-10），已去掉。
     */
    if (probed) {
      return { running: false, platform, error: null, warning: null };
    }
    return { running: false, platform, error: failures.join('; ') };
  }

  // macOS / Linux：走 ps 全量进程表（pgrep 的自杀陷阱见 listViaPs 注释）
  const { processes, method, error } = await listWorkbuddyProcesses({ names: procs });
  if (error) return { running: false, error, platform };
  if (!processes.length) return { running: false, platform, method };
  // 列表已按启动时间升序（ps 路径），第一个 = 主进程 = 应用真正启动的时刻
  const main = processes[0];
  return {
    running: true,
    pid: main.pid,
    name: main.name,
    exePath: main.exePath,
    startTime: main.startTime,
    processCount: processes.length,
    platform,
    method,
  };
}

/**
 * 定位**指定档位**的可执行文件：优先检测到的真实路径，再按常见安装位置兜底。
 *
 * 检测到的路径只在文件名属于本档位时才采用——这是"切国际版却把国内版拉起来"的防线：
 * 两档的 exe 名字不同（`WorkBuddy.exe` / `WorkBuddyAI.exe`），文件名对不上就说明
 * 那条路径属于另一个档位，宁可去标准安装目录找，也不能跨档启动。
 *
 * 导出只为回归测试（`scripts/test-variant-process.mjs` 断言不跨档选 exe），生产路径由
 * `launchWorkbuddy` / `restartWorkbuddy` 调用。
 */
export function findWorkbuddyExe(detectedPath, variant = 'cn') {
  const v = getVariant(variant);
  const wanted = v.exeNames.map((n) => n.toLowerCase());
  const detected =
    detectedPath && wanted.includes(path.basename(detectedPath).toLowerCase()) ? detectedPath : null;
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    detected,
    ...v.exeNames.map((n) => path.join(localAppData, 'Programs', v.appDirName, n)),
    ...v.exeNames.map((n) => path.join('C:\\Program Files', v.appDirName, n)),
    ...v.exeNames.map((n) => path.join('C:\\Program Files (x86)', v.appDirName, n)),
  ].filter(Boolean);
  return candidates.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/**
 * 枚举某一档客户端的全部进程（判定「是否已退出」与「逐个关掉」都用它）。
 *
 * 返回 `{ processes, method, complete?, warning?, error? }`。
 * `complete: false` 表示只用 tasklist 拿到了单个 PID（没有启动时间），
 * 此时靠 `taskkill /T` 杀进程树来兜底。
 * `error` 非空表示**无法判定**当前状态，调用方必须保守处理，不能当成"没在运行"。
 */
export async function listWorkbuddyProcesses({ names, variant } = {}) {
  const procs = resolveNames({ names, variant });
  if (process.platform === 'win32') {
    try {
      return { processes: await listViaPowerShell(procs), method: 'powershell', complete: true };
    } catch (err) {
      const psError = shortExecError(err);
      try {
        const rows = await listViaTasklist(procs);
        return rows.length
          ? {
              processes: rows,
              method: 'tasklist',
              complete: false,
              warning: `已改用 tasklist 完成检测（PowerShell 暂不可用：${psError}），拿不到启动时间，会靠进程树兜底`,
            }
          : { processes: [], method: 'tasklist', warning: `已改用 tasklist 完成检测（PowerShell 暂不可用：${psError}）` };
      } catch (err2) {
        return { processes: [], error: `PowerShell（${psError}）与 tasklist（${shortExecError(err2)}）都不可用` };
      }
    }
  }
  // macOS / Linux 主路径：ps 全量进程表（自动剔除本工具自己的进程子树，按启动时间升序）
  try {
    return { processes: await listViaPs(procs), method: 'ps', complete: true };
  } catch (err) {
    // 兜底用 pgrep：只拿得到 PID（无启动时间、无法剔除全部后代），
    // 仅剔除自己一个 PID——ps 都不可用的机器已经非常罕见， degraded 路径可接受
    const pattern = procs.map((n) => n.replace(/\.exe$/i, '')).join('|');
    try {
      const stdout = await run('pgrep', ['-if', pattern], 8000);
      const processes = String(stdout)
        .split('\n')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid)
        .map((pid) => ({ pid, name: null, exePath: null, startTime: null }));
      return { processes, method: 'pgrep', complete: true };
    } catch (err2) {
      // pgrep 无匹配时退出码为 1 —— 那是"没有进程"，不是探测失败
      if (err2?.code === 1) return { processes: [], method: 'pgrep', complete: true };
      return { processes: [], error: `ps（${err?.message || String(err)}）与 pgrep（${err2?.message || String(err2)}）都不可用` };
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询直到 `predicate()` 返回 true 或超时；返回是否在超时前达成。
 *
 * 等待"进程真的没了"必须用它 + 便宜的探测，**不能**每次都用全量枚举：
 * 一次 `Get-Process … | ConvertTo-Json` 在慢机器上要好几秒（沙箱里实测 4~5s），
 * 拿它当 400ms 轮询的探针，一轮就把整个超时预算吃光了 —— 于是"刚杀完、还没确认"
 * 就被判成"退不掉"，报出「无法退出 WorkBuddy（仍在运行）」的假失败。
 */
async function waitUntil(predicate, timeoutMs, stepMs = 350) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  for (;;) {
    if (await predicate()) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await sleep(Math.min(stepMs, left));
  }
}

/**
 * 轻量存活探测：只回答"还有没有**本档位**进程"，不要求 PID、启动时间。
 *
 * Windows 走 tasklist（`IMAGENAME eq` 精确匹配，比 PowerShell 快得多，也不会把
 * `WorkBuddyAI` 算进来）；tasklist 不可用时退回全量枚举——**宁可慢，也不能瞎猜**：
 * 把"探测失败"当成"没有进程"会让切号在客户端还活着时继续写登录态，那才是真正会丢数据的方向。
 *
 * macOS / Linux 直接复用 ps 全量枚举（那边 ps 本来就快）。
 */
export async function anyWorkbuddyProcess({ names, variant } = {}) {
  const procs = resolveNames({ names, variant });
  const allowed = nameSet(procs);
  const mine = (p) => p.pid !== process.pid && isOwnVariantProcess(p, allowed);

  if (process.platform === 'win32') {
    try {
      for (const name of procs) {
        const exe = /\.exe$/i.test(name) ? name : `${name}.exe`;
        const stdout = await run('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH'], 8000);
        for (const line of String(stdout)
          .split('\n')
          .map((s) => s.trim())) {
          // 无匹配时 tasklist 打印 "INFO: No tasks are running…"，不含 exe 名
          if (!line.toLowerCase().includes(exe.toLowerCase())) continue;
          const pid = Number(line.split('","').map((s) => s.replace(/^"|"$/g, ''))[1]);
          if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) return true;
        }
      }
      return false;
    } catch {
      /* tasklist 不可用（被安全策略拦掉等）：退回全量枚举，结论依旧可信 */
    }
  }

  const { processes, error } = await listWorkbuddyProcesses({ names: procs });
  if (error) throw new Error(error);
  return processes.some(mine);
}

/** 优雅退出的等待窗口：够 WM_CLOSE 走完，又不至于让界面等太久 */
const STOP_GRACEFUL_MS = 2500;
/** 强杀后的等待上限 */
const STOP_FORCE_MS = 12000;
/** 强杀每一轮里"等它死"的窗口：短一点，确认不了就重新枚举再来一轮（新冒出来的 helper 也能被清掉） */
const FORCE_ROUND_WAIT_MS = 2500;

/**
 * 给单个 PID 发终止信号（win32 走 taskkill，其他平台走 kill）。
 *
 * `tree` 只在"尽力把整棵进程树一起带走"时才开：`/T` 的语义是**连子孙一起杀，
 * 且任何一个子孙杀不掉就拒绝杀父进程**。WorkBuddy 5.9 的 agent 会话会在客户端下面挂
 * 沙箱化的 shell / MCP 子进程，那些进程外部杀不掉，于是 `/T` 每次都失败、客户端反而
 * 活得好好的（2026-10-26「两档同时登录时切号必然失败」的真因）。
 * 所以强杀路径**必须**同时有一个不带 `/T` 的兜底：只按映像名杀本档位自己的进程。
 *
 * 失败不抛错（单个进程杀不掉不该中断整轮清理），但要如实返回结果 ——
 * 早先这里 `run(...).catch(() => {})` 之后才挂调试日志，catch 已经把 rejection 吃掉，
 * 日志于是**永远**打印 ok，把真正的失败藏了起来。
 */
function terminatePid(pid, force, { tree = false } = {}) {
  const args =
    process.platform === 'win32'
      ? ['/PID', String(pid), ...(tree ? ['/T'] : []), ...(force ? ['/F'] : [])]
      : [force ? '-KILL' : '-TERM', String(pid)];
  return run(process.platform === 'win32' ? 'taskkill' : 'kill', args)
    .then(() => ({ ok: true }))
    .catch((err) => ({ ok: false, error: shortExecError(err) }))
    .then((r) => {
      if (process.env.WB_DEBUG_STOP === '1') {
        console.log(`[stop] kill ${r.ok ? 'ok' : 'FAIL'} ${pid} ${args.join(' ')}${r.ok ? '' : ` (${r.error})`}`);
      }
      return r;
    });
}

/**
 * 退出**某一档**客户端（该档的全部相关进程），并**确认真的消失了**才返回。
 *
 * 两步走：先优雅关闭（向主窗口发 WM_CLOSE，能保住正在落盘的数据），
 * 等不到就强杀。第二步不是多余的——WorkBuddy 关窗会缩到系统托盘，
 * 优雅退出经常"看起来关掉了其实还活着"，那样切号会被它把登录态改写回去。
 *
 * **每轮都重新枚举再杀**，而不是开局枚举一次就照着那份 PID 名单猛敲：
 * 一来 tasklist 兜底时一次只能看到部分 PID、连主进程是谁都分不出；
 * 二来先杀 helper 会被主进程立刻重新拉起来。反复枚举能让名单自然收敛
 * （先冒出来的子进程被清掉 → 主进程暴露出来 → 再清掉它），直到进程表真的空了。
 *
 * ## 强杀为什么是"先按树、再逐个"（2026-10-26 修复）
 *
 * 只按树杀（`/T /F`）会被客户端下面的 agent 会话子进程拖死：`taskkill /T` 要求整棵树
 * 都能杀，只要有一个沙箱化子进程拒绝终止，它就**连父进程一起放弃**——于是客户端还在、
 * 界面报「无法退出 WorkBuddy（仍在运行：PID …）」，用户只能手动退出后重试。
 * 现在的做法是：先尽力按树杀（正常情况一次带走全部 helper 与 agent 子进程），
 * 再对枚举到的每个进程逐个 `/F`（不带 `/T`）。逐个杀只依赖"映像名属于本档位"，
 * 不会被任何子孙拖累，因此**本档位自己的进程一定死得掉**。
 *
 * 同一轮修复还顺手换掉了等待方式：确认"真的没了"改用 tasklist / ps 的**轻量探针**，
 * 而不是每 400ms 起一个 PowerShell 做全量枚举（慢机器上单次 4~5 秒，一轮就吃光超时预算，
 * 于是刚杀干净也会误报「仍在运行」）。详见 {@link waitUntil} 与 {@link anyWorkbuddyProcess}。
 *
 * `variant` 决定动哪一档：`'cn'` 只动国内版、`'ai'` 只动国际版、`'all'` 两档都动。
 * 不传则沿用历史默认（国内版）。切号必须显式传目标账号所属档位——两档是两个客户端，
 * 切国际版账号时去关国内版不但没用，还会把用户正在用的另一个客户端关掉。
 *
 * @returns `{ stopped, wasRunning, killed, forced, exePath, variant }`；关不掉时抛错（绝不静默返回成功）
 */
export async function stopWorkbuddy({
  names,
  variant,
  gracefulMs = STOP_GRACEFUL_MS,
  forceMs = STOP_FORCE_MS,
} = {}) {
  const procs = resolveNames({ names, variant });
  const allowed = nameSet(procs);
  const label = variant && String(variant) !== 'all' ? appLabelOf(variant) : 'WorkBuddy';

  /**
   * 枚举本档位自己的进程：按映像名**精确**过滤（不靠调用方自觉），并排除控制台自己——
   * 控制台被用户从 WorkBuddy 里拉起时就是客户端的子进程，误杀自己等于切换当场中断。
   */
  const enumerate = async () => {
    const { processes, error } = await listWorkbuddyProcesses({ names: procs });
    if (error) throw new Error(`无法确认 ${label} 是否已退出（${error}），已中止`);
    return processes.filter((p) => p.pid !== process.pid && isOwnVariantProcess(p, allowed));
  };

  /**
   * 便宜的"还在不在"探针（tasklist / ps），只用于等待窗口内的轮询。
   * 探测本身失败时抛错 —— 调用方绝不能把"不知道"当成"已经没了"。
   */
  const alive = async () => {
    try {
      return await anyWorkbuddyProcess({ names: procs });
    } catch (err) {
      throw new Error(`无法确认 ${label} 是否已退出（${err?.message || err}），已中止`);
    }
  };

  const first = await enumerate();
  if (!first.length) {
    return { stopped: true, wasRunning: false, killed: [], forced: false, exePath: null, variant: variant || null };
  }

  const exePath = first.find((p) => p.exePath)?.exePath || null;
  const killed = new Set();

  /** 优雅关闭只针对主进程（最早启动的那个）：/T 会把整棵树都关一遍，而 agent 子进程根本不吃 WM_CLOSE */
  const mainPid = first[0].pid;
  killed.add(mainPid);
  await terminatePid(mainPid, false);
  if (await waitUntil(async () => !(await alive()), gracefulMs)) {
    // 进程刚没，让 SQLite 把 -wal/-shm 的句柄彻底放开，再动数据库
    await sleep(700);
    return { stopped: true, wasRunning: true, killed: [...killed], forced: false, exePath, variant: variant || null };
  }

  /**
   * 强杀：每轮「尽力按树杀 + 逐个兜底杀」，直到进程表真的空了。
   *
   * 判定"空了"用**便宜的探针**而不是再枚举一次：枚举要起一个 PowerShell，慢机器上单次要
   * 4~5 秒，拿它当轮询探针的话，一轮就把 forceMs 预算耗尽，于是明明刚杀干净也会报
   * 「仍在运行」的假失败（2026-10-26 实测踩到，日志里 deadline 直接是负数）。
   * 每轮的等待只给一小段（`FORCE_ROUND_WAIT_MS`），确认不了就重新枚举再来一轮——
   * 这样"杀完之后主进程又拉起新的 helper"也能被下一轮清掉。
   * 只有预算真的耗尽才抛错，抛之前再枚举一次，好给出**准确**的残留 PID 供用户手动处理。
   */
  const forceDeadline = Date.now() + forceMs;
  let rows = first;
  for (;;) {
    if (!rows.length) break;
    for (const p of rows) killed.add(p.pid);
    await terminatePid(rows[0].pid, true, { tree: true });
    for (const p of rows) await terminatePid(p.pid, true);

    const budget = forceDeadline - Date.now();
    if (budget > 0 && (await waitUntil(async () => !(await alive()), Math.min(budget, FORCE_ROUND_WAIT_MS)))) break;

    // 还没确认干净：重新枚举（可能冒出了新的 helper；也可能刚好已经退了）
    rows = await enumerate().catch(() => rows);
    if (!rows.length) break;
    if (Date.now() >= forceDeadline) {
      throw new Error(
        `无法退出 ${label}（仍在运行：${rows.map((p) => `${p.name}:${p.pid}`).join(', ')}），请手动退出后重试`
      );
    }
  }

  // 进程刚没，让 SQLite 把 -wal/-shm 的句柄彻底放开，再动数据库
  await sleep(700);
  const confirm = await enumerate().catch(() => []);
  if (confirm.length) throw new Error(`${label} 退出后又重新启动，请手动退出后重试`);
  return { stopped: true, wasRunning: true, killed: [...killed], forced: true, exePath, variant: variant || null };
}

/**
 * 拉起客户端时用的环境变量。
 *
 * ## 为什么要摘掉 `NODE_ENV`（2026-10-29 反馈：升级 WorkBuddy AI 5.9.3 后切号"只重启不生效"）
 *
 * 客户端 5.9.3 的登录态文件名由 `getWorkbuddyAuthenticationConfiguration()` 决定，
 * 而该函数在 `NODE_ENV === 'development'` 时会把 `authentication.id` 追加 `-dev`，
 * 于是读写的是 `workbuddy-desktop-ai-dev.info`，而不是控制台对应的
 * `workbuddy-desktop-ai.info`——写进去的账号客户端压根不读。
 *
 * 控制台用 `spawn(exe, [], { detached: true })` 拉起客户端时**继承自己的环境**，
 * 控制台自身若是从开发态（electron 开发进程 / 开发终端）启动的，这个 development
 * 就会一路传到客户端。用户手动从开始菜单打开客户端时没有这个变量，所以表现为
 * "控制台切号无效、手动重启就生效"。
 *
 * 这里显式摘掉，让客户端无论被谁拉起都走正式模式的登录态文件；写侧另有
 * `authWriteTargets()` 兜底同步 `-dev` 文件，两头都不依赖对方。
 */
export function clientSpawnEnv() {
  const env = { ...process.env };
  delete env.NODE_ENV;
  return env;
}

/**
 * 重新打开**指定档位**的客户端（切换账号后调用，让用户拿到一个已登录新账号的客户端）。
 * Windows 用 exe 直接拉起；macOS 从检测到的可执行文件路径反推 .app 包后用 `open`。
 *
 * `variant` 必须与刚刚 {@link stopWorkbuddy} 的档位一致：切国际版账号要拉起的是
 * `WorkBuddyAI.exe`，拉起国内版等于什么都没生效（还平白多开一个客户端）。
 */
export function launchWorkbuddy(exePath, variant = 'cn') {
  const label = appLabelOf(variant);
  if (process.platform === 'darwin') {
    const bundle = findWorkbuddyAppBundle(exePath, variant);
    if (!bundle) {
      throw new Error(`未能定位 ${label} 的 .app 包（/Applications 下未找到），请手动重新打开 ${label}`);
    }
    const child = spawn('open', [bundle], { detached: true, stdio: 'ignore' });
    child.unref();
    return { launched: true, exePath: bundle };
  }
  if (process.platform !== 'win32') {
    throw new Error(`当前平台（${process.platform}）不支持自动重新打开 ${label}，请手动打开`);
  }
  const exe = findWorkbuddyExe(exePath, variant);
  if (!exe) {
    throw new Error(
      `未能定位 ${label} 可执行文件，请手动重新打开 ${label}。` + (exePath ? `（检测到的路径：${exePath}）` : '')
    );
  }
  const child = spawn(exe, [], { detached: true, stdio: 'ignore', env: clientSpawnEnv() });
  child.unref();
  return { launched: true, exePath: exe };
}

/** macOS：从检测到的可执行文件路径反推 .app 包路径（如 /Applications/WorkBuddy.app），失败按常见位置兜底 */
function findWorkbuddyAppBundle(exePath, variant = 'cn') {
  const v = getVariant(variant);
  const m = String(exePath || '').match(/^(\/.+?\.app)\//i);
  const candidates = [
    m?.[1],
    ...v.macBundles.map((b) => path.join('/Applications', b)),
    ...v.macBundles.map((b) => path.join(os.homedir(), 'Applications', b)),
  ].filter(Boolean);
  return candidates.find((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * 重启**指定档位**的客户端（模型配置变更后让 models.json 生效）。
 *
 * 退出这一步**必须**复用 {@link stopWorkbuddy}：早先这里自己拼了一条
 * `taskkill /PID <主进程> /T /F`，和切号踩的是同一个坑——`/T` 要求整棵树都能杀，
 * 只要客户端下面挂着杀不掉的 agent 子进程，它就拒绝杀父进程，重启于是变成"又开一个"。
 * 复用之后：先按树、再逐个 `/F`，并且**确认真的退出了**才拉起新的。
 */
export async function restartWorkbuddy({ variant = 'cn' } = {}) {
  const label = appLabelOf(variant);
  const proc = await detectWorkbuddyProcess({ variant });
  if (!proc.running) throw new Error(`未检测到运行中的 ${label} 进程，无需重启（下次启动自动生效）`);

  const stopped = await stopWorkbuddy({ variant });
  await new Promise((r) => setTimeout(r, 1200));

  if (process.platform === 'win32') {
    const exe = findWorkbuddyExe(stopped.exePath || proc.exePath, variant);
    if (!exe) {
      throw new Error(
        `未能定位 ${label} 可执行文件，请手动重新打开 ${label}。` +
          (proc.exePath ? `（检测到的路径：${proc.exePath}）` : '')
      );
    }
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', env: clientSpawnEnv() });
    child.unref();
    return { restarted: true, exePath: exe };
  }
  if (process.platform === 'darwin') {
    const bundle = findWorkbuddyAppBundle(stopped.exePath || proc.exePath, variant);
    if (!bundle) {
      throw new Error(`未能定位 ${label} 的 .app 包，请手动重新打开 ${label}`);
    }
    const child = spawn('open', [bundle], { detached: true, stdio: 'ignore' });
    child.unref();
    return { restarted: true, exePath: bundle };
  }
  throw new Error(`当前平台（${process.platform}）暂不支持自动重启，请手动重启 ${label}`);
}
