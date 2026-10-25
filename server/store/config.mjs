import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** 配置目录：默认 ~/.free-token，可用 FREE_TOKEN_CONFIG_DIR 重定向（隔离测试用） */
export const CONFIG_DIR = process.env.FREE_TOKEN_CONFIG_DIR
  ? path.resolve(process.env.FREE_TOKEN_CONFIG_DIR)
  : path.join(os.homedir(), '.free-token');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const CACHE_DIR = path.join(CONFIG_DIR, 'cache');

/**
 * 手机同步（局域网）：让 fewards 把 refresh_token 推过来、把刷新结果拉回去。
 *
 * **默认关闭**。和 `proxy.enabled` 一样，这属于"对外暴露能力"：一旦打开，同网段的
 * 设备就能向本机提交凭据。必须由用户明确打开，且配了配对码才允许启动。
 */
export const DEFAULT_LANSYNC = {
  enabled: false,
  /** 监听端口；与主服务的 57891 分开，避免把控制台 UI / 反向代理暴露到局域网 */
  port: 57900,
  /** 配对码：空表示未初始化，服务拒绝启动（否则等于无鉴权裸奔） */
  pairCode: '',
  /** 收到推送后是否立刻刷新；关闭时只入库，等用户手动刷 */
  refreshOnPush: false,
};

const DEFAULT_SETTINGS = {
  workbuddyDir: '', // 覆盖默认 ~/.workbuddy
  proxyUrl: '', // 出站代理（如 http://127.0.0.1:7890）；留空自动探测环境变量 / Windows 系统代理
  autoCheckin: true, // 自动签到（仅国内版账号，服务端每小时巡检一次）；默认开启，可在设置里关闭
  // 凭据自动刷新（服务端每 6 小时巡检一次，只在 access/refresh 临期时才动手）；默认开启。
  // 关掉后：既没被切换、也没走过反向代理的账号会一直静默过期，直到需要重新扫码。
  autoRefreshToken: true,
  // 启动时检查有没有新版本（只读 GitHub Release 元数据，是唯一一处访问非官方服务的出站请求）
  autoCheckUpdate: true,
  /**
   * 免费模型页是否列出**全部平台**（含默认收起的地区受限 / 平台禁止外部接入的那几个）。
   * 默认关闭：这些平台的 key 在外部环境调用大概率被拒，列出来只会让人白折腾。
   * 打开后照常可选，但界面上会常驻风险提示——是否接入由用户自己承担。
   */
  unlockAllPlatforms: false,
};

/**
 * 反向代理（让其他 agent 用 OpenAI 协议调用 WorkBuddy 的积分与模型）。
 * 放在 settings 里，随 config.json 一起落盘；apiKey 首次使用时自动生成。
 */
export const DEFAULT_PROXY = {
  enabled: false, // 默认关闭：暴露本地端口属于"对外能力"，要用户明确打开
  apiKey: '', // 调用方鉴权用；为空视为未初始化，首次启用时生成
  /**
   * 参与轮换的账号 id。
   * 语义上必须区分「没配过」与「一个都不选」：
   *   null/非数组 = 全部可用账号；[]（空数组）= 一个都不用（池为空）。
   * 早期版本用 [] 表示"全部"，导致用户在界面上取消最后一个勾选后又被解释成全部。
   */
  accountIds: null,
  /** 非流式请求的整段超时；流式响应只受 60s 首字节超时约束，不会被硬掐 */
  timeoutMs: 120_000,
};

const DEFAULT_CONFIG = {
  version: 1,
  activeKeyId: null, // 兼容字段：openrouter 的活跃 key
  activeKeys: {}, // platform -> 活跃 keyId（如 { openrouter: 'key-xxx', zen: 'key-yyy' }）
  keys: [], // { id, platform, label, key, addedAt, lastStatus }
  settings: { ...DEFAULT_SETTINGS },
  proxy: { ...DEFAULT_PROXY },
};

export function ensureDirs() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

export function atomicWriteJson(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  ensureDirs();
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const cfg = {
      ...structuredClone(DEFAULT_CONFIG),
      ...raw,
      settings: {
        ...DEFAULT_SETTINGS,
        ...(raw.settings || {}),
        // 嵌套对象必须单独合并：直接展开会被 raw 里的半截 lanSync 整个替换，
        // 用户只存了 { enabled: true } 时 port / pairCode 就丢了。
        lanSync: { ...DEFAULT_LANSYNC, ...(raw.settings?.lanSync || {}) },
      },
      activeKeys: { ...(raw.activeKeys || {}) },
      proxy: { ...DEFAULT_PROXY, ...(raw.proxy || {}) },
    };
    // 迁移：旧版 key 不分平台，全部归入 openrouter；activeKeyId 迁移为 activeKeys.openrouter
    let migrated = false;
    for (const k of cfg.keys) {
      if (!k.platform) {
        k.platform = 'openrouter';
        migrated = true;
      }
    }
    if (!cfg.activeKeys.openrouter && cfg.activeKeyId && cfg.keys.some((k) => k.id === cfg.activeKeyId)) {
      cfg.activeKeys.openrouter = cfg.activeKeyId;
      migrated = true;
    }
    // 迁移：accountIds 的语义从"空数组=全部"改为"null=全部、空数组=一个都不选"。
    // 旧配置里留下的 [] 必须翻成 null，否则老用户升级后会发现"账号池突然空了"。
    if (Array.isArray(cfg.proxy?.accountIds) && cfg.proxy.accountIds.length === 0 && cfg.proxy.migratedPool !== true) {
      cfg.proxy.accountIds = null;
      cfg.proxy.migratedPool = true;
      migrated = true;
    }
    if (migrated) saveConfig(cfg);
    return cfg;
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

/** 某平台当前活跃的 key 记录（找不到时回退到该平台第一个 key） */
export function activeKeyFor(cfg, platform) {
  const keys = cfg.keys.filter((k) => k.platform === platform);
  const activeId = cfg.activeKeys?.[platform] || (platform === 'openrouter' ? cfg.activeKeyId : null);
  return keys.find((k) => k.id === activeId) || keys[0] || null;
}

export function saveConfig(cfg) {
  ensureDirs();
  atomicWriteJson(CONFIG_FILE, cfg);
}

export function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
}

/** key 只保留末 4 位用于界面区分，完整值永不返回给前端 */
export function maskKey(key) {
  if (!key || typeof key !== 'string') return '';
  return `••••${key.slice(-4)}`;
}

export function cachePath(name) {
  ensureDirs();
  return path.join(CACHE_DIR, name);
}
