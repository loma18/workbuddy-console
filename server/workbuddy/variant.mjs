/**
 * WorkBuddy 档位（国内版 / 国际版）的路径与端点常量。
 *
 * 复刻自 workbuddy-switch 的 variant.rs，但只保留本工具需要的部分。
 * 关键约束（务必遵守）：
 * - 绝不跨档位请求。国内版 token 只打国内域，国际版只打国际域，
 *   混用会污染统计并触发网关一致性校验失败。
 * - 登录态文件按档位分开，不能互相覆盖。
 * - **进程也按档位分开**：两档是两个独立安装的客户端（`WorkBuddy.exe` /
 *   `WorkBuddyAI.exe`），切国内版账号只该重启国内版，切国际版只该重启国际版。
 *   早先"切号 = 结束 WorkBuddy + 重开 WorkBuddy"的写法是跨档的：切国际版账号时
 *   关掉并拉起的是国内版客户端，国际版那份登录态压根没被重新读取（2026-10-26 反馈）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VARIANTS = {
  cn: {
    id: 'cn',
    label: '国内版',
    /** 官方 API 根 */
    apiEndpoint: 'https://www.codebuddy.cn',
    /** 设备码（OAuth 扫码）接口前缀，两档位相同 */
    apiPrefix: '/v2/plugin',
    /** 官方用量接口 */
    usageUrl: 'https://www.codebuddy.cn/billing/meter/get-user-request-usage',
    /** 资源（积分/余额）接口 */
    resourceUrl: 'https://www.codebuddy.cn/billing/meter/get-user-resource-summary',
    /** 数据根目录名 */
    dataRootName: '.workbuddy',
    /** OAuth 申请 state 时的 platform 参数（与 workbuddy-switch 的 WORKBUDDY_PLATFORM 一致） */
    oauthPlatform: 'workbuddy',
    /** 客户端显示名：提示文案里说"退出 / 重新打开 xxx"就用它 */
    appLabel: 'WorkBuddy',
    /**
     * 进程映像名（Windows 按映像名精确匹配；macOS/Linux 按命令行匹配）。
     * `CodeBuddy` 是旧版客户端的进程名，保留以兼容仍装旧版的机器。
     */
    processNames: ['WorkBuddy', 'CodeBuddy'],
    /** Windows 安装目录名（`%LOCALAPPDATA%\Programs\<appDirName>`）与可执行文件名（首个为首选） */
    appDirName: 'WorkBuddy',
    exeNames: ['WorkBuddy.exe', 'CodeBuddy.exe'],
    /** macOS .app 包名候选 */
    macBundles: ['WorkBuddy.app', 'CodeBuddy.app'],
  },
  ai: {
    id: 'ai',
    label: '国际版',
    apiEndpoint: 'https://www.workbuddy.ai',
    apiPrefix: '/v2/plugin',
    usageUrl: 'https://www.workbuddy.ai/billing/meter/get-user-request-usage',
    resourceUrl: 'https://www.workbuddy.ai/billing/meter/get-user-resource-summary',
    dataRootName: '.workbuddy-ai',
    oauthPlatform: 'workbuddy-ai',
    appLabel: 'WorkBuddy AI',
    // 国际版是**另一个客户端**：进程名、安装目录、可执行文件名都与国内版不同
    processNames: ['WorkBuddyAI'],
    appDirName: 'WorkBuddyAI',
    exeNames: ['WorkBuddyAI.exe'],
    macBundles: ['WorkBuddy AI.app', 'WorkBuddyAI.app'],
  },
};

export const VARIANT_LIST = [VARIANTS.cn, VARIANTS.ai];

export function getVariant(id) {
  /**
   * 兼容传对象：`variantOf()` 返回的是 VARIANT 对象而不是 id。
   *
   * 早期 `authFilePath(variant)` / `getVariant(variant)` 这类调用把对象直接传进来，
   * `String(obj)` 得到 "[object Object]" → 查表失败 → **静默回落国内版**。
   * 后果是切换国际版账号时写进了 `workbuddy-desktop.info`，把国内版的登录态覆盖掉，
   * 表现为"两档没法分别切换"。这里把两种入参都接住，避免再出现同类问题。
   */
  if (id && typeof id === 'object') {
    return VARIANTS[String(id.id || '')] || VARIANTS.cn;
  }
  return VARIANTS[String(id || '')] || VARIANTS.cn;
}

/** 归一化账号记录里的档位字段；缺失时按国内版解释（历史数据零迁移） */
export function variantOf(account) {
  const raw = String(account?.variant || '').toLowerCase();
  if (raw === 'ai' || raw === 'workbuddy-ai' || raw === 'intl') return VARIANTS.ai;
  return VARIANTS.cn;
}

/** 两档进程名的并集：只有"退出全部"这种显式动作才用得到 */
export const ALL_PROCESS_NAMES = [...new Set(VARIANT_LIST.flatMap((v) => v.processNames))];

/**
 * 某个档位对应的进程名。
 *
 * 传 `'all'` 返回两档并集（"退出全部"），其余按 {@link getVariant} 归一化——
 * 传对象、传 `undefined` 都安全（undefined → 国内版，与历史默认一致）。
 */
export function processNamesFor(variant) {
  if (String(variant) === 'all') return ALL_PROCESS_NAMES;
  return getVariant(variant).processNames;
}

/** 档位的客户端显示名（'WorkBuddy' / 'WorkBuddy AI'），用于提示文案 */
export function appLabelOf(variant) {
  return getVariant(variant).appLabel;
}

/** 账号所属档位的数据根目录（会话日志所在处） */
export function dataRoot(variant) {
  return path.join(os.homedir(), getVariant(variant).dataRootName);
}

/**
 * 登录态文件的**基名**（= 客户端 product.json 里的 `authentication.id`）。
 * 国内版 `workbuddy-desktop`，国际版 `workbuddy-desktop-ai`。
 */
export function authFileBaseName(variant) {
  return getVariant(variant).id === 'ai' ? 'workbuddy-desktop-ai' : 'workbuddy-desktop';
}

/** 登录态目录候选：桌面端与 CodeBuddy 扩展各一份，按存在性择一 */
function authDirs() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return [
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    ];
  }
  if (process.platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')];
  }
  return [path.join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth')];
}

/**
 * 登录态文件候选路径。两档位**同目录、不同文件**（与 workbuddy-switch 一致）：
 * 国内版 `workbuddy-desktop.info`，国际版 `workbuddy-desktop-ai.info`。
 *
 * 每个档位有两个候选名：基名，以及 `-dev` 变体。
 *
 * ## 为什么会有 `-dev`（2026-10-29 反馈：升级 WorkBuddy AI 5.9.3 后切号只重启不生效）
 *
 * 客户端 5.9.3 的登录态文件名不再是常量，而是
 * `join(getSharedAuthDirectory(), `${authentication.id}.info`)`，而
 * `getWorkbuddyAuthenticationConfiguration()` 在 `NODE_ENV === 'development'` 时
 * 会把 id 追加成 `${id}-dev`（见 app.asar）。控制台用 `spawn(exe, [], {detached:true})`
 * 拉起客户端时**继承了自己的环境**，若控制台本身跑在开发态，客户端就会去读写
 * `workbuddy-desktop-ai-dev.info`——于是控制台写基名文件等于没写。
 * 现在两份都当作候选：读时按最新修改挑（客户端自己刷新只动它在用的那份），
 * 写时见 {@link authWriteTargets}。
 */
export function authFileCandidates(variant) {
  const base = authFileBaseName(variant);
  return authDirs().flatMap((dir) => [
    path.join(dir, `${base}.info`),
    path.join(dir, `${base}-dev.info`),
  ]);
}

/** 该档位的主文件路径（基名，必定是候选列表的第 0 个） */
export function authFilePrimaryPath(variant) {
  return authFileCandidates(variant)[0];
}

function fileMtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * 当前**实际在用**的登录态文件：存在者中 mtime 最新的那个。
 *
 * 客户端自己刷新 token 时只重写它在用的那份，所以最新的是"活的"；
 * 控制台切换会同时写两份（见 {@link authWriteTargets}），不会造成歧义。
 * 都不存在时返回主文件路径（供报错文案使用）。
 */
export function authFilePath(variant) {
  const list = authFileCandidates(variant);
  let best = null;
  let bestMs = -1;
  for (const p of list) {
    const ms = fileMtimeMs(p);
    if (ms > bestMs) {
      bestMs = ms;
      best = p;
    }
  }
  return bestMs >= 0 && best ? best : list[0];
}

/**
 * 切换 / 回写时要写的目标：主文件必写；`-dev` 变体**已存在**时一并写。
 *
 * 只在 `-dev` 已存在时补写，是为了不给一台从没在开发态跑过客户端的机器
 * 凭空造出一个客户端根本不读的文件。
 */
export function authWriteTargets(variant) {
  const list = authFileCandidates(variant);
  const primary = list[0];
  const dev = list.find((p) => p.endsWith('-dev.info'));
  const targets = [primary];
  if (dev && fileMtimeMs(dev) >= 0) targets.push(dev);
  return targets;
}

/**
 * 备份标签：沿用历史命名 `workbuddy-desktop-{cn|ai}`，`-dev` 目标追加后缀，
 * 让 backups.mjs 能把备份归到正确档位。
 */
export function authBackupTag(variant, filePath) {
  const tag = `workbuddy-desktop-${getVariant(variant).id}`;
  return String(filePath || '').endsWith('-dev.info') ? `${tag}-dev` : tag;
}