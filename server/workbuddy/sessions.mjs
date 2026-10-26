/**
 * WorkBuddy 会话（对话记录）的读取，以及「把会话复制给另一个账号」。
 *
 * ── 为什么复制能生效（读参考实现 workbuddy-switch 的 session.rs 得出，别再重查）──
 * 会话是「三件套」，缺一不可：
 *   1) 正文    `<数据根>/projects/<工作区>/<会话id>.jsonl`（每行一条 JSON，行内有 `sessionId`）
 *   2) 元数据  `<数据根>/workbuddy.db` 的 `sessions` 表（`user_id NOT NULL`，会话按账号归属）
 *   3) 云端归属 `<数据根>/edge-sync-mapping-v*.db` 的 `session_id → conversation_id` 映射
 * 复制 = 生成新 UUID → 正文里把旧会话 id **全量替换**成新 id → 在 `sessions` 表插一行、
 * `user_id` 写成目标账号。源账号数据一个字不动（新 UUID 与源会话不共享任何 id）。
 *
 * **故意不写第 3 项**：预写映射会让客户端的 edge-sync 判定「已迁移」而跳过上传，
 * 结果云端根本没有这条会话，客户端之后对它的改名/活跃度上报会全部 404。
 * 副本交给客户端下次启动时自行登记（参考实现的注释写得很明确）。
 *
 * ── 安全约束 ──
 * - 写 `sessions` 表要求 WorkBuddy **完全退出**：运行中的实例看不到我们的写入，
 *   继续对话会让副本与源会话状态分叉。账号切换本来就要求退出，所以不额外增加负担。
 * - 先备份 `workbuddy.db`(+`-wal`/`-shm`) 再写；单个会话失败只回滚该会话
 *   （删掉刚写的正文、刚插入的行），不影响已经复制成功的其他会话。
 * - 写后回读校验：正文不得残留旧 id、行内 `sessionId` 必须全是新 id、
 *   库里的行必须存在且 `user_id`/`deleted_at` 正确，否则按失败处理并回滚。
 *
 * ── 不要抄参考项目的「只查一层目录」 ──
 * 本机实测 `projects/` 下既有 `projects/<工作区>/<id>.jsonl`，也有
 * `projects/<工作区>/<子目录>/<id>.jsonl`（27 个两层目录）。参考实现的
 * `find_project_jsonl` 只看一层，会把这些会话判成「没有正文」。这里改成
 * 递归索引（限深 4 层），一次遍历建表、之后 O(1) 查找。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataRoot, getVariant, variantOf } from './variant.mjs';
import { STORE_DIR, findAccount } from './accounts.mjs';
import { readAuthFile } from './auth.mjs';
import { atomicWriteJson } from '../store/config.mjs';
import { detectWorkbuddyProcess, stopWorkbuddy, workbuddyDir } from '../targets/workbuddy.mjs';

/** 递归索引正文的最大深度（`projects/` 记为第 1 层） */
const MAX_PROJECT_DEPTH = 4;
/** 正文超过这个大小就跳过逐行 JSON 解析校验（只做「旧 id 不残留」校验），避免大文件卡住 */
const JSONL_PARSE_LIMIT = 16 * 1024 * 1024;
/**
 * 复制会话时客户端正在运行、且没有授权本工具自动退出的提示语
 * （与参考实现同口径：运行中的实例看不到写入，继续对话会让副本与源会话分叉）。
 *
 * 按档位给出具体客户端名——两档是两个客户端，说"退出 WorkBuddy"会让用国际版的用户
 * 去关错程序（关掉国内版，国际版还在跑，写库照样被改写）。
 */
export function appRunningMessage(variant = 'cn') {
  const label = getVariant(variant).appLabel;
  return `${label} 正在运行，已阻止修改会话数据。请先退出 ${label}，或勾选「先退出 ${label}」由本工具自动结束它。`;
}

/** @deprecated 用 {@link appRunningMessage}：这里固定按国内版文案，仅为兼容旧调用方 */
export const APP_RUNNING_MESSAGE = appRunningMessage('cn');

/**
 * 复制时清空的「云端同步状态」列。
 * 置空 = 让客户端把副本当成尚未上传的新会话，下次启动自行登记到云端映射。
 * 若这里保留了源会话的同步痕迹，客户端会以为副本已经在云上，从而跳过上传。
 */
const CLEAR_ON_COPY = ['agent_dirty', 'agent_dirty_at', 'agent_last_synced', 'verified_at'];
/** 复制时归零的列：副本对目标账号来说是全新的，不应带未读标记 */
const ZERO_ON_COPY = ['unread'];

/* ------------------------------------------------------------------ *
 * SQLite（node:sqlite）
 * ------------------------------------------------------------------ */

let sqliteModule = null;
/** 惰性加载 node:sqlite，失败时给一句能读懂的话，而不是让整个服务起不来 */
async function sqlite() {
  if (!sqliteModule) {
    try {
      sqliteModule = await import('node:sqlite');
    } catch {
      throw new Error(
        '当前运行环境不支持 node:sqlite（需要 Node 22.5+ 或 Electron 内置 Node），无法读写会话数据库'
      );
    }
  }
  return sqliteModule;
}

/**
 * 档位的数据根目录。
 *
 * 国内版沿用 `workbuddyDir()`（与 Token 统计同源，尊重设置页里的「WorkBuddy 目录」覆盖），
 * 国际版沿用 `dataRoot('ai')`。`WB_DATA_ROOT` / `WB_DATA_ROOT_CN|AI` 是**测试隔离专用**
 * 开关：单测用它把数据根指到临时目录，绝不触碰真实会话数据。
 */
export function sessionDataRoot(variantId) {
  const id = getVariant(variantId).id;
  const override = process.env[`WB_DATA_ROOT_${id.toUpperCase()}`] || process.env.WB_DATA_ROOT;
  if (override) return path.resolve(override);
  return id === 'cn' ? workbuddyDir() : dataRoot(id);
}

export function sessionDbPath(variantId) {
  return path.join(sessionDataRoot(variantId), 'workbuddy.db');
}

function sessionProjectsDir(variantId) {
  return path.join(sessionDataRoot(variantId), 'projects');
}

/** 打开会话数据库；readOnly 用于只读查询（列表），写操作必须用读写连接 */
async function openSessionDb(variantId, { readOnly = false } = {}) {
  const { DatabaseSync } = await sqlite();
  const file = sessionDbPath(variantId);
  if (!fs.existsSync(file)) throw new Error(`会话数据库不存在：${file}（请先运行一次 WorkBuddy）`);
  // timeout = SQLite busy_timeout：进程刚退出时可能还握着 -wal 句柄，等一会儿而不是直接报锁
  return new DatabaseSync(file, { readOnly, timeout: readOnly ? 5000 : 8000 });
}

function tableExists(db, name) {
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?")
      .get(name);
    return Number(row?.n) > 0;
  } catch {
    return false;
  }
}

/** 档位是否具备会话复制能力：`projects/` 目录 + `workbuddy.db` 的 `sessions` 表 */
export async function sessionCopySupported(variantId) {
  if (!fs.existsSync(sessionProjectsDir(variantId))) return false;
  if (!fs.existsSync(sessionDbPath(variantId))) return false;
  let db = null;
  try {
    db = await openSessionDb(variantId, { readOnly: true });
    return tableExists(db, 'sessions');
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      /* 关闭失败无所谓 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * 正文索引
 * ------------------------------------------------------------------ */

/**
 * 递归索引 `projects/`：`会话id → 正文完整路径`。
 *
 * 文件名（去掉 `.jsonl`）就是会话 id，所以一次遍历就能建表。符号链接天然被
 * `withFileTypes` 排除（`isDirectory()`/`isFile()` 对符号链接都不成立），不会绕圈。
 */
function indexProjectBodies(variantId) {
  const root = sessionProjectsDir(variantId);
  const index = new Map();
  if (!fs.existsSync(root)) return index;
  const walk = (dir, depth) => {
    if (depth > MAX_PROJECT_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const id = entry.name.slice(0, -'.jsonl'.length);
        // 同名文件只认第一个（正常不会出现）
        if (!index.has(id)) index.set(id, full);
      }
    }
  };
  walk(root, 1);
  return index;
}

function bodySize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ *
 * 复制账本（本工具私有，~/.wb-switch/session_copies.json）
 * ------------------------------------------------------------------ */

export const SESSION_COPIES_FILE = path.join(STORE_DIR, 'session_copies.json');

/**
 * 账本结构：
 * `{ version: 1, pairs: { "<档位>|<源uid>|<目标uid>": { "<源会话id>": "<副本会话id>" } } }`
 *
 * 用「一对账号一张表」而不是扁平数组：查「这个会话有没有复制给这个账号」是 O(1)，
 * 文件也不会随复制次数线性膨胀。**这是本工具私有的文件**，与 workbuddy-switch 不共用
 * （它没有这个文件，共用会让双方互相覆盖）。
 */
function loadCopies() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_COPIES_FILE, 'utf8'));
    if (raw && typeof raw === 'object' && raw.pairs && typeof raw.pairs === 'object') return raw;
  } catch {
    /* 文件不存在或损坏：当成空账本 */
  }
  return { version: 1, pairs: {} };
}

const pairKey = (variantId, sourceUid, targetUid) => `${variantId}|${sourceUid}|${targetUid}`;

/** 某对账号的复制记录：`源会话id → 副本会话id` */
export function sessionCopyLedger(variantId, sourceUid, targetUid) {
  const ledger = loadCopies();
  return ledger.pairs[pairKey(variantId, sourceUid, targetUid)] || {};
}

/**
 * 全账本反查表：`副本会话id → 它的来源会话id`，**不分账号方向**。
 *
 * 为什么不能只看「目标账号 → 本账号」这一层：那样只认得 1 跳的往返。实际使用里会话会接力——
 * A→B→C→A，或者某个会话早先用别的方式复制过——此时单层反查查不到祖先，会话就被当成全新会话
 * 又复制一份，正是用户反馈的「复制出一模一样的会话」。整张账本反过来之后可以沿着祖先链往上找，
 * 一直找到一个「目标账号里确实存在」的那份，才是应该合并进去的落点。
 */
export function copyAncestorMap() {
  const map = new Map();
  for (const table of Object.values(loadCopies().pairs)) {
    for (const [sourceId, copyId] of Object.entries(table)) {
      if (!map.has(copyId)) map.set(copyId, sourceId);
    }
  }
  return map;
}

/**
 * 全账本「家族表」：把每条 `副本 → 来源` 边做并查集，得到 `会话id → 家族根`。
 *
 * 和 copyAncestorMap（只往祖先方向查）互补：这里把**整段对话的所有副本**归成一个家族，
 * 于是「目标账号里已经有这段对话了吗」可以一次问清——不管是本账号直接复制给它的、
 * 还是它从第三个账号那儿拿到的。
 *
 * 现实意义（2026-10-19 用户反馈）：多账号轮转（A→B→C→D→A）时，A 与 D 之间从来没有
 * 直接复制记录，列表只按「这一对账号的账本」判定就会把整段对话当成没复制过，用户看到
 * 一长串"待复制"，只能再复制一遍。按家族判定后，这段对话只要在 D 的家族里已有成员落在 A，
 * 就算已同步，不再出现在待复制列表里。
 */
export function copyFamilyMap() {
  const parent = new Map();
  const find = (x) => {
    let p = parent.get(x);
    if (p === undefined) {
      parent.set(x, x);
      return x;
    }
    if (p === x) return x;
    const root = find(p);
    parent.set(x, root);
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const table of Object.values(loadCopies().pairs)) {
    for (const [sourceId, copyId] of Object.entries(table)) {
      if (!sourceId || !copyId) continue;
      union(String(copyId), String(sourceId));
    }
  }
  const rootOf = (id) => {
    const key = String(id || '');
    if (!key) return '';
    return parent.has(key) ? find(key) : key;
  };
  return { rootOf, size: parent.size };
}

function recordCopies(variantId, sourceUid, targetUid, pairs) {
  if (!pairs.length) return;
  const ledger = loadCopies();
  const key = pairKey(variantId, sourceUid, targetUid);
  const table = ledger.pairs[key] || {};
  for (const { sourceId, newId } of pairs) table[sourceId] = newId;
  ledger.pairs[key] = table;
  ledger.version = 1;
  fs.mkdirSync(STORE_DIR, { recursive: true });
  atomicWriteJson(SESSION_COPIES_FILE, ledger);
}

/* ------------------------------------------------------------------ *
 * 门禁
 * ------------------------------------------------------------------ */

/**
 * 写会话前的门禁：WorkBuddy 必须已退出。
 *
 * `stop: true` 时由本工具**直接结束 WorkBuddy 的全部相关进程**并确认退出
 * （用户不必自己动手；关不掉就抛错，绝不带着运行中的实例往库里写）。
 *
 * 探测本身失败时**保守拦截**——宁可要求用户重试，也不做「无法判定的写入」。
 *
 * 测试专用开关：`WB_FAKE_APP_RUNNING`（`1`/`true` 假装在运行、`0`/`false` 假装已退出）——
 * 测试机上真实 WorkBuddy 多半正在运行，会让门禁变成「永远拒绝」，两条分支都没法验证；
 * `WB_FAKE_STOP_FAIL=1` 配合前者模拟「进程关不掉」。生产路径不设置它们，走真实探测与真实关进程。
 */
export async function ensureAppClosed({ stop = false, variant = 'cn' } = {}) {
  const runningMessage = appRunningMessage(variant);
  const fake = process.env.WB_FAKE_APP_RUNNING;
  if (fake === '1' || fake === 'true') {
    if (!stop) throw new Error(runningMessage);
    if (process.env.WB_FAKE_STOP_FAIL === '1') {
      throw new Error(`无法退出 ${getVariant(variant).appLabel}（测试模拟：进程关不掉），请手动退出后重试`);
    }
    return { stopped: true, wasRunning: true, killed: [], forced: false, exePath: null, fake: true };
  }
  if (fake === '0' || fake === 'false') {
    return { stopped: true, wasRunning: false, killed: [], forced: false, exePath: null, fake: true };
  }

  const proc = await detectWorkbuddyProcess({ variant });
  if (proc.running) {
    if (!stop) throw new Error(runningMessage);
    // 关不掉时 stopWorkbuddy 会抛错，这里不吞
    return await stopWorkbuddy({ variant });
  }
  if (proc.error) {
    throw new Error(
      `无法确认 ${getVariant(variant).appLabel} 是否已退出（进程检测失败：${proc.error}）。为安全起见已阻止会话写入，请确认已退出后重试`
    );
  }
  return { stopped: true, wasRunning: false, killed: [], forced: false, exePath: proc.exePath || null };
}

/* ------------------------------------------------------------------ *
 * 列表
 * ------------------------------------------------------------------ */

/**
 * 目标账号的会话复制视图：源是**该档位当前登录账号**，目标是传入的账号。
 *
 * 返回 `{ variant, sourceUid, targetUid, supported, sessions, stats }`。
 * 每个会话带 `hasBody`（有无正文，没有正文的不能复制）、`bytes`、`copied`（账本里已有记录）。
 */
export async function listSessionsForSwitch({ targetAccountId }) {
  const target = findAccount(targetAccountId);
  if (!target) throw new Error('账号不存在');
  const variantId = variantOf(target).id;
  const targetUid = String(target.uid || '').trim();
  if (!targetUid) throw new Error('目标账号缺少 uid，无法列出会话');

  const sourceUid = currentUidOfVariant(variantId);
  if (!sourceUid) throw new Error('未读取到本档位的登录态，无法确定来源账号');
  if (sourceUid === targetUid) throw new Error('源账号与目标账号相同，无需复制会话');

  const supported = await sessionCopySupported(variantId);
  if (!supported) {
    return {
      variant: variantId,
      sourceUid,
      targetUid,
      supported: false,
      sessions: [],
      stats: { total: 0, withBody: 0, bytes: 0 },
    };
  }

  const index = indexProjectBodies(variantId);
  const ledger = sessionCopyLedger(variantId, sourceUid, targetUid);
  // 家族表：用于判定「这段对话在目标账号里已经有了吗」——跨全部账号对，而不是只看这一对
  const family = copyFamilyMap();
  const db = await openSessionDb(variantId, { readOnly: true });
  let rows = [];
  let targetAlive = new Set();
  /** 家族根 → 目标账号里对应的那份会话 id（同一家族有多份时取最近活动的） */
  const targetFamily = new Map();
  try {
    rows = db
      .prepare(
        `SELECT id, cwd, title, custom_title, status, updated_at, is_playground
           FROM sessions
          WHERE user_id = ? AND deleted_at IS NULL
          ORDER BY updated_at DESC`
      )
      .all(sourceUid);
    // 账本只是「曾经复制过」的记录，目标账号里那份副本可能早就被用户删了。
    // 副本已不在时不能再算「已复制」——界面上会被标记成已复制（默认还会被隐藏、
    // 不可勾选），用户就再也找不到入口把它重新复制过去。
    const targetRows = db
      .prepare('SELECT id, updated_at FROM sessions WHERE user_id = ? AND deleted_at IS NULL')
      .all(targetUid);
    targetAlive = new Set(targetRows.map((r) => String(r.id)));
    for (const r of targetRows) {
      const root = family.rootOf(String(r.id));
      const prev = targetFamily.get(root);
      if (!prev || (Number(r.updated_at) || 0) > (Number(prev.updatedAt) || 0)) {
        targetFamily.set(root, { id: String(r.id), updatedAt: Number(r.updated_at) || 0 });
      }
    }
  } finally {
    db.close();
  }

  const sessions = [];
  let bytes = 0;
  for (const r of rows) {
    const id = String(r.id || '');
    if (!id) continue;
    const cwd = String(r.cwd || '');
    // Claw 工作区绑定的是当前账号的 IM 渠道，复制行也没用，直接剔除
    if (isClawWorkspace(cwd)) continue;
    const body = index.get(id) || null;
    const size = body ? bodySize(body) : 0;
    if (body) bytes += size;
    // 直接复制记录优先（这一对账号自己的账本），没有再看整段对话的家族
    const directId = Object.prototype.hasOwnProperty.call(ledger, id) ? String(ledger[id] || '') : '';
    const directAlive = directId && targetAlive.has(directId) ? directId : '';
    const familyHit = directAlive ? '' : targetFamily.get(family.rootOf(id))?.id || '';
    const copiedTo = directAlive || familyHit || null;
    sessions.push({
      id,
      title: displayTitle(r.title, r.custom_title),
      cwd,
      workspace: workspaceName(cwd),
      status: String(r.status || ''),
      updatedAt: Number(r.updated_at) || 0,
      isPlayground: Number(r.is_playground) === 1,
      hasBody: !!body,
      bytes: size,
      copied: !!copiedTo,
      copiedTo,
      /** direct=这一对账号直接复制过；family=经由其它账号间接同步过去的 */
      copiedScope: directAlive ? 'direct' : familyHit ? 'family' : null,
    });
  }
  return {
    variant: variantId,
    sourceUid,
    targetUid,
    supported: true,
    sessions,
    stats: {
      total: sessions.length,
      withBody: sessions.filter((s) => s.hasBody).length,
      bytes,
    },
  };
}

/** 会话展示名：优先用户改名（custom_title），再回落到自动标题 */
function displayTitle(title, customTitle) {
  const custom = String(customTitle || '').trim();
  if (custom) return custom;
  const t = String(title || '').trim();
  return t || '(无标题)';
}

/** 会话所属工作区名（取 cwd 最后一段）；没有 cwd 的归入「(无工作区)」 */
function workspaceName(cwd) {
  const s = String(cwd || '').replace(/[/\\]+$/, '');
  if (!s) return '(无工作区)';
  const seg = s.split(/[/\\]/).pop();
  return seg || '(无工作区)';
}

/** Claw 是账号绑定的 IM 渠道工作区，复制到别的账号也用不了 */
function isClawWorkspace(cwd) {
  return workspaceName(cwd).toLowerCase() === 'claw';
}

/** 某档位当前登录态里的 uid */
function currentUidOfVariant(variantId) {
  const doc = readAuthFile(variantId);
  const uid = doc?.account?.uid;
  return typeof uid === 'string' && uid.trim() ? uid.trim() : null;
}

/* ------------------------------------------------------------------ *
 * 复制
 * ------------------------------------------------------------------ */

/** 名字里只允许出现 UUID 字符，防止把路径拼串到目录之外 */
function assertSafeSessionId(id) {
  if (!/^[A-Za-z0-9._-]{8,64}$/.test(String(id || ''))) {
    throw new Error(`会话 id 形状异常，已拒绝：${String(id).slice(0, 40)}`);
  }
}

/** 备份 workbuddy.db（含 -wal/-shm），任何一步失败都算备份失败 */
function backupSessionDb(variantId) {
  const dbPath = sessionDbPath(variantId);
  if (!fs.existsSync(dbPath)) throw new Error('会话数据库不存在，未复制');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(STORE_DIR, 'backups', `session-copy-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const src = `${dbPath}${suffix}`;
    if (!fs.existsSync(src)) continue;
    const dest = path.join(dir, `workbuddy.db${suffix}`);
    fs.copyFileSync(src, dest);
    const srcLen = fs.statSync(src).size;
    const destLen = fs.statSync(dest).size;
    if (srcLen !== destLen) throw new Error(`备份 workbuddy.db${suffix} 校验失败：大小不一致，未复制`);
  }
  return dir;
}

/** 持久化写：临时文件 → fsync → 改名，避免断电/崩溃留下半截正文 */
function durableWrite(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** 持久化追加：append 模式打开 + fsync，用于把副本的增量行写回原会话正文 */
function durableAppend(file, currentText, lines) {
  // 原正文若不以换行结尾，先补一个，避免把新行拼到最后一行半截上
  const add = (currentText.length && !currentText.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n';
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, add, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 目标正文路径：沿用源文件在 `projects/` 下的相对目录。
 *
 * 客户端按会话行的 `cwd` 推导工作区目录名，而 `cwd` 复制时原样保留，
 * 所以目录名必须跟着源文件走（不能自己按 cwd 重算 slug，规则一旦不一致客户端就读不到）。
 */
function targetBodyPath(sourcePath, root, newId) {
  const relativeDir = path.relative(path.join(root, 'projects'), path.dirname(sourcePath));
  const base = path.join(root, 'projects');
  const dir = relativeDir && !relativeDir.startsWith('..') ? path.join(base, relativeDir) : base;
  return path.join(dir, `${newId}.jsonl`);
}

/** 回读校验：旧 id 不得残留；行内 sessionId 必须全是新 id；行数不变 */
function verifyCopiedBody(file, sourceText, oldId, newId) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`复制后的正文读取失败：${err?.message || err}`);
  }
  if (text.includes(oldId)) throw new Error('复制后的正文仍残留旧会话 id，未按成功处理');
  const srcLines = sourceText.split('\n').filter((l) => l.trim()).length;
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length !== srcLines) {
    throw new Error(`复制后的正文行数不一致（期望 ${srcLines}，实际 ${lines.length}），未按成功处理`);
  }
  // 大文件跳过逐行解析：解析一整份 75MB 的 JSONL 要好几秒，而「旧 id 不残留」
  // 已经足以证明替换是完整的（替换只改 id，不改结构）。
  if (text.length <= JSONL_PARSE_LIMIT) {
    let seen = 0;
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        throw new Error('复制后的正文存在无法解析的行，未按成功处理');
      }
      if (obj && typeof obj === 'object' && obj.sessionId !== undefined) {
        if (String(obj.sessionId) !== newId) {
          throw new Error('复制后的正文里有 sessionId 未指向副本，未按成功处理');
        }
        seen++;
      }
    }
    if (seen === 0) throw new Error('复制后的正文里没有任何 sessionId 字段，未按成功处理');
  }
  return fs.statSync(file).size;
}

/** 把源行改写成副本行（身份改写 + 云端同步状态清空） */
function buildCopyRow(sourceRow, { newId, targetUid, now }) {
  const row = { ...sourceRow };
  row.id = newId;
  row.user_id = targetUid;
  row.created_at = now;
  row.updated_at = now;
  if ('last_activity_at' in row) row.last_activity_at = now;
  row.deleted_at = null;
  for (const col of CLEAR_ON_COPY) if (col in row) row[col] = null;
  for (const col of ZERO_ON_COPY) if (col in row) row[col] = 0;
  // 源会话可能正处于 working：副本是「已完成的快照」，留着 working 会让客户端
  // 以为还有未结束的回合而尝试续跑，与源账号抢同一段对话内容。
  if (row.status === 'working') row.status = 'completed';
  return row;
}

/** node:sqlite 不接受布尔值，统一压成 0/1；undefined 压成 null */
function normalizeValue(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function insertSessionRow(db, row) {
  const cols = Object.keys(row);
  const sql = `INSERT INTO sessions (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols
    .map(() => '?')
    .join(', ')})`;
  db.prepare(sql).run(...cols.map((c) => normalizeValue(row[c])));
}

function readRowOwner(db, id) {
  try {
    const r = db.prepare('SELECT user_id, deleted_at FROM sessions WHERE id = ?').get(id);
    if (!r) return null;
    return { user_id: r.user_id == null ? '' : String(r.user_id), deletedAt: r.deleted_at };
  } catch {
    return null;
  }
}

/**
 * 把选中的会话复制给目标账号。
 *
 * @param {object}   opts
 * @param {string}   opts.targetAccountId 目标账号（账号库 id 或 uid）
 * @param {string[]} opts.ids             要复制的源会话 id
 * @param {boolean}  opts.stopApp         WorkBuddy 在运行时是否直接结束它（默认 false＝拒绝）
 * @returns {Promise<object>} 复制报告
 */
export async function copySessions({ targetAccountId, ids, stopApp = false }) {
  const started = Date.now();
  const list = Array.isArray(ids) ? [...new Set(ids.map((s) => String(s || '').trim()).filter(Boolean))] : [];
  if (!list.length) throw new Error('没有选择要复制的会话');

  const target = findAccount(targetAccountId);
  if (!target) throw new Error('账号不存在');
  const variantId = variantOf(target).id;
  const targetUid = String(target.uid || '').trim();
  if (!targetUid) throw new Error('目标账号缺少 uid，无法复制会话');

  const sourceUid = currentUidOfVariant(variantId);
  if (!sourceUid) throw new Error('未读取到本档位的登录态，无法确定来源账号');
  if (sourceUid === targetUid) throw new Error('源账号与目标账号相同，无需复制会话');

  if (!(await sessionCopySupported(variantId))) {
    throw new Error(`该档位（${getVariant(variantId).label}）暂不支持会话复制：缺少 projects/ 目录或 sessions 表`);
  }

  // 写库前必须确认 App 已退出——这是唯一能保证副本不与源会话分叉的前提。
  // stopApp=true 时由本工具直接结束**本档位**客户端的进程（关不掉就抛错中止，不做无法判定的写入）。
  // 档位必须传对：国际版的会话库与国内版是两个目录，去关国内版不会让国际版停止写库。
  const appStop = await ensureAppClosed({ stop: stopApp, variant: variantId });

  const root = sessionDataRoot(variantId);
  const index = indexProjectBodies(variantId);
  const ledger = sessionCopyLedger(variantId, sourceUid, targetUid);
  // 祖先链：查「这份会话当初是从哪一份复制出来的」，**跨全部账号对**。
  // 只反查「目标 → 本账号」这一层是不够的：A→B→C→A 这类接力（或某个会话早先用
  // 别的方式复制过）时单层查不到祖先，会话就被当成新会话又复制一份——实测能复现出
  // 「复制了一模一样的会话」。改成整张账本反查后，由 resolveOrigin 沿链往上找落点。
  const ancestorOf = copyAncestorMap();

  const backupPath = backupSessionDb(variantId);

  const db = await openSessionDb(variantId);
  const copied = [];
  const skipped = [];
  const errors = [];
  const titleSynced = [];
  const contentSynced = [];
  const ledgerAdds = [];
  let totalBytes = 0;

  /**
   * 标题回写：把源会话当前的 title / custom_title 写到目标账号的原会话行上。
   * 只动这两个列，内容一字不碰；字段没变化时不写。返回同步结果或 null（无需同步）。
   */
  const syncTitleBack = (originId, sourceTitle, sourceCustomTitle) => {
    const cur = db.prepare('SELECT title, custom_title FROM sessions WHERE id = ? AND user_id = ?').get(originId, targetUid);
    if (!cur) return null;
    const same =
      String(cur.title ?? '') === String(sourceTitle ?? '') &&
      String(cur.custom_title ?? '') === String(sourceCustomTitle ?? '');
    if (same) return null;
    db.prepare('UPDATE sessions SET title = ?, custom_title = ? WHERE id = ? AND user_id = ?').run(
      sourceTitle ?? null,
      sourceCustomTitle ?? null,
      originId,
      targetUid
    );
    return { originId, title: displayTitle(sourceTitle, sourceCustomTitle) };
  };

  /**
   * 内容增量同步：把 `fromId` 正文里**目标那侧还没有的行**补进 `toId` 正文。
   *
   * 两个方向共用：
   * - 往返（副本 → 原会话）：在目标账号里继续聊出来的新消息补回原会话；
   * - 正向（本账号会话 → 之前复制过去的那份副本）：本账号又聊了新内容时补进旧副本，
   *   否则「已复制过」就只是什么都不做，用户切过去看到的是一份过期的会话。
   *
   * 为什么按「逐行去重」而不是「取最长公共前缀后追加尾部」：
   * 复制时副本正文 = 原正文逐行做 `原id → 副本id` 替换的产物，所以把副本行反向替换回目标视角后，
   * 两边共有的行是**逐字节相等**的。取公共前缀只在「目标侧严格是来源的前缀」时才成立；一旦两侧
   * 都各自新增过内容（用户在两边都聊过），公共前缀会停在复制时刻的快照边界，同一段增量每次重跑
   * 都会被再追加一遍。改成「来源里有、目标里没有的行」没有这个问题：天然幂等，两侧的新内容都
   * 不会丢（每行是一条带唯一消息 id 的 JSON，重复行 == 同一条消息）。
   *
   * 无增量（目标已经是来源的超集）时不做任何写入，返回 null。
   */
  const syncContentTo = (fromId, toId) => {
    const fromPath = index.get(fromId);
    const toPath = index.get(toId);
    if (!fromPath || !toPath) return null; // 任一侧没有正文：只做标题同步，内容无从合并

    const fromText = fs.readFileSync(fromPath, 'utf8');
    const toText = fs.readFileSync(toPath, 'utf8');
    const toTarget = (line) => (fromId === toId ? line : line.split(fromId).join(toId));
    const toLines = toText.split('\n').filter((l) => l.trim());
    const known = new Set(toLines);
    const missing = fromText
      .split('\n')
      .map(toTarget)
      .filter((l) => l.trim() && !known.has(l));

    if (!missing.length) return null;

    // 追加会**修改已有正文**，与只新增文件的复制路径不同——先把落点正文备份下来，
    // 备份失败就中止（宁可不同步，也不无备份地改用户的会话数据）
    fs.mkdirSync(backupPath, { recursive: true });
    fs.copyFileSync(toPath, path.join(backupPath, `${toId}.jsonl`));

    durableAppend(toPath, toText, missing);

    // 写后校验：行数必须精确吻合，且不得残留来源会话 id（追加的是纯归一化文本，出现即说明替换漏了）
    const after = fs.readFileSync(toPath, 'utf8');
    const expect = toLines.length + missing.length;
    const actual = after.split('\n').filter((l) => l.trim()).length;
    if (actual !== expect) {
      throw new Error(`内容同步后行数不一致（期望 ${expect}，实际 ${actual}）`);
    }
    if (after.includes(fromId)) {
      throw new Error('内容同步后的目标正文仍残留来源会话 id');
    }

    // 目标会话行的活动时间推进到两侧较新的值（App 已退出，无并发写）
    const fromRow = db.prepare('SELECT updated_at, last_activity_at FROM sessions WHERE id = ?').get(fromId);
    const toRow = db
      .prepare('SELECT updated_at, last_activity_at FROM sessions WHERE id = ? AND user_id = ?')
      .get(toId, targetUid);
    if (fromRow && toRow) {
      const nextUpdated = Math.max(Number(toRow.updated_at) || 0, Number(fromRow.updated_at) || 0);
      const nextActivity = Math.max(Number(toRow.last_activity_at) || 0, Number(fromRow.last_activity_at) || 0);
      if (nextUpdated > (Number(toRow.updated_at) || 0) || nextActivity > (Number(toRow.last_activity_at) || 0)) {
        db.prepare('UPDATE sessions SET updated_at = ?, last_activity_at = ? WHERE id = ? AND user_id = ?').run(
          nextUpdated,
          nextActivity > 0 ? nextActivity : null,
          toId,
          targetUid
        );
      }
    }

    return { targetId: toId, appendedLines: missing.length, bytes: Buffer.byteLength(missing.join('\n') + '\n', 'utf8') };
  };

  /** 目标账号里这份会话行是否仍然存在且未删除（账本可能记着一份早就被删掉的副本） */
  const rowAlive = (id, uid) =>
    !!db.prepare('SELECT 1 AS k FROM sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, uid);

  /**
   * 把 `fromId` 的增量内容与改名同步到目标账号里的 `toId`。两个方向共用；
   * 失败只记错误，不中断其它会话。
   */
  const syncSessionInto = (fromId, toId) => {
    try {
      const synced = syncContentTo(fromId, toId);
      if (synced) contentSynced.push({ sourceId: fromId, ...synced });
    } catch (err) {
      errors.push({ id: fromId, error: `内容同步失败（本次未复制）：${err?.message || err}` });
    }
    try {
      const row = db.prepare('SELECT title, custom_title FROM sessions WHERE id = ?').get(fromId);
      if (row) {
        const synced = syncTitleBack(toId, row.title, row.custom_title);
        if (synced) titleSynced.push({ sourceId: fromId, ...synced });
      }
    } catch (err) {
      errors.push({ id: fromId, error: `标题同步失败（内容不受影响）：${err?.message || err}` });
    }
  };

  /**
   * 沿祖先链往上找「目标账号里确实存在」的那一份，作为合并落点。
   *
   * 限深 32 且带 visited：账本万一被手工改坏成环也不会死循环。
   * 找不到（这个会话跟目标账号毫无血缘）时返回 null，调用方按普通复制处理。
   */
  const resolveOrigin = (cid) => {
    const seen = new Set([cid]);
    let cur = ancestorOf.get(cid);
    for (let hop = 0; cur && hop < 32 && !seen.has(cur); hop++) {
      if (rowAlive(cur, targetUid)) return cur;
      seen.add(cur);
      cur = ancestorOf.get(cur);
    }
    return null;
  };

  try {
    for (const cid of list) {
      try {
        assertSafeSessionId(cid);
        // 往返识别**优先于一切复制判定**：cid 的血缘上有一份已经落在目标账号里时，
        // 既不能"照旧重新复制"（会产生内容重复的新会话——0.2.2 用户实测踩过，
        // 改名前后的会话都被复制了一份；跨账号接力时单层反查还会漏判），
        // 也不能"只跳过"（新聊的内容会永远留在副本里）。正确动作是原位合并：
        // 内容增量 + 改名都同步到那一份上。
        const originId = resolveOrigin(cid);
        if (originId) {
          assertSafeSessionId(originId);
          syncSessionInto(cid, originId);
          skipped.push({
            id: cid,
            reason: '往返副本：新增内容与改名已同步回原会话，不再重复复制',
            newId: originId,
          });
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(ledger, cid)) {
          // 账本命中的那份副本也可能**已经在目标账号里被删掉了**：此时"跳过"等于用户点了
          // 复制却什么都没发生（真实账本里就有 3 条这种记录），所以只在副本确实还在时才走
          // 同步；否则按未复制处理，重新复制一份并覆盖账本。
          // 副本还在时也不再只是"跳过"：本账号这一侧可能又聊了新内容，要同步过去，
          // 不然用户切过去看到的是一份过期的会话。
          const prevId = String(ledger[cid] || '');
          if (prevId && rowAlive(prevId, targetUid)) {
            assertSafeSessionId(prevId);
            syncSessionInto(cid, prevId);
            skipped.push({ id: cid, reason: '已复制过（账本命中）：本次只同步新增内容与改名', newId: prevId });
            continue;
          }
        }
        const sourcePath = index.get(cid);
        if (!sourcePath) throw new Error('会话正文不存在，未复制');

        const sourceRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(cid);
        if (!sourceRow) throw new Error('数据库中找不到该会话记录，未复制');
        if (String(sourceRow.user_id || '') !== sourceUid) throw new Error('该会话不属于当前登录账号，未复制');
        if (sourceRow.deleted_at != null) throw new Error('该会话已被删除，未复制');
        if (isClawWorkspace(sourceRow.cwd)) throw new Error('Claw 工作区绑定当前账号渠道，不支持复制');

        const sourceText = fs.readFileSync(sourcePath, 'utf8');
        const newId = crypto.randomUUID();
        const dest = targetBodyPath(sourcePath, root, newId);
        if (fs.existsSync(dest)) throw new Error('目标位置已存在同名文件，已停止复制');
        fs.mkdirSync(path.dirname(dest), { recursive: true });

        // 正文：把旧 id 全量替换成副本 id（源文件一个字节都不动）
        durableWrite(dest, sourceText.split(cid).join(newId));
        let writtenBytes;
        try {
          writtenBytes = verifyCopiedBody(dest, sourceText, cid, newId);
        } catch (err) {
          fs.rmSync(dest, { force: true });
          throw err;
        }

        // 元数据：插入副本行（用 INSERT 而非 REPLACE，撞库宁可失败也不覆盖既有会话）
        let inserted = false;
        try {
          insertSessionRow(db, buildCopyRow(sourceRow, { newId, targetUid, now: Date.now() }));
          inserted = true;
          const owner = readRowOwner(db, newId);
          if (!owner) throw new Error('会话记录保存后不可见，未按成功处理');
          if (owner.user_id !== targetUid) {
            throw new Error(`会话记录归属校验失败：期望 ${targetUid}，实际 ${owner.user_id}`);
          }
          if (owner.deletedAt != null) throw new Error('会话记录保存后被标记删除，未按成功处理');
        } catch (err) {
          // 回滚本会话：先删行（若已插入），再删刚写的正文
          if (inserted) {
            try {
              db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(newId, targetUid);
            } catch {
              /* 回滚尽力而为，下面的报错里会带上说明 */
            }
          }
          fs.rmSync(dest, { force: true });
          throw err;
        }

        copied.push({
          id: cid,
          newId,
          title: displayTitle(sourceRow.title, sourceRow.custom_title),
          workspace: workspaceName(sourceRow.cwd),
          bytes: writtenBytes,
        });
        ledgerAdds.push({ sourceId: cid, newId });
        totalBytes += writtenBytes;
      } catch (err) {
        errors.push({ id: cid, error: err?.message || String(err) });
      }
    }
  } finally {
    db.close();
  }

  // 账本在业务完成之后才落盘：写失败只会让下次重复复制（用户能看到重复会话），
  // 而提前记账会让失败的会话被永久跳过（用户看不到副本还以为成功了）。
  try {
    recordCopies(variantId, sourceUid, targetUid, ledgerAdds);
  } catch (err) {
    errors.push({ id: '(账本)', error: `复制账本写入失败（下次可能重复复制）：${err?.message || err}` });
  }

  return {
    ok: errors.length === 0,
    variant: variantId,
    sourceUid,
    targetUid,
    copied,
    skipped,
    errors,
    /** 往返复制时同步回原会话的改名（含会话 id、原会话 id 与新标题） */
    titleSynced,
    /** 往返复制时追加回原会话正文的增量内容（含追加行数与字节数） */
    contentSynced,
    totalBytes,
    backupPath,
    /** 本次是否结束了 WorkBuddy 的进程（供界面提示"客户端已被关闭，需要重新打开"） */
    appStop,
    elapsedMs: Date.now() - started,
  };
}
