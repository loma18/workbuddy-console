import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import {
  loadConfig,
  saveConfig,
  newId,
  maskKey,
  CONFIG_FILE,
  cachePath,
  activeKeyFor,
} from './store/config.mjs';
import { providers, getProvider, listPlatforms, PLATFORM_ORDER } from './providers/registry.mjs';
import { clearModelsCache, modelsCacheFile } from './providers/genericOpenAI.mjs';
import {
  detectWorkbuddyDir,
  detectWorkbuddyProcess,
  isPendingRestart,
  modelsJsonMtime,
  listLoaded,
  loadModels,
  removeModels,
  restartWorkbuddy,
} from './targets/workbuddy.mjs';
import { getStats } from './stats/workbuddyStats.mjs';
import { getProxyUrl } from './proxy.mjs';
import { loadAccounts, accountMeta, findAccount, accountDisplayName } from './workbuddy/accounts.mjs';
import { oauthStart, oauthPoll } from './workbuddy/oauth.mjs';
import {
  switchAccount,
  detectCurrentAccount,
  importLocalAccount,
  deleteAccount,
  updateAccountDisplay,
} from './workbuddy/auth.mjs';
import {
  getCreditStatistics,
  getOfflineCreditProjection,
  getAccountBalances,
  getCreditDetails,
} from './workbuddy/credits.mjs';
import { refreshAccessToken } from './proxy/wb.mjs';
import { VARIANT_LIST, authFilePath, dataRoot } from './workbuddy/variant.mjs';
import { checkinAll, checkinAccount, fetchCheckinStatus, loadCheckinLogs, allCheckedInToday, allGrowthDoneToday } from './workbuddy/checkin.mjs';
import {
  refreshAccounts,
  refreshPlan,
  loadRefreshLogs,
  lastRefreshRun,
  loadCredentialStatus,
  verifyStateOf,
  verifyAccount,
  ACCESS_MIN_HOURS,
  REFRESH_MIN_HOURS,
} from './workbuddy/tokenRefresh.mjs';
import { checkForUpdate, LOCAL_VERSION } from './update.mjs';
import { checkPermissions } from './workbuddy/diagnostics.mjs';
import { listBackups, restoreBackup, deleteBackup, cleanBackups, backupVariants } from './workbuddy/backups.mjs';
import { registerProxyRoutes, refreshModelsCache } from './proxy/index.mjs';
import { stopWorkbuddy, launchWorkbuddy } from './targets/workbuddy.mjs';
import { listSessionsForSwitch, copySessions } from './workbuddy/sessions.mjs';
import { startLanSync, stopLanSync, lanSyncStatus, lanAddresses } from './lansync/server.mjs';
import { pendingSummary, clearPending } from './lansync/state.mjs';
import { generatePairCode, PROTOCOL_VERSION } from './lansync/protocol.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 57891);

const app = express();
// 反向代理的对话请求体可能很长（大上下文 / 工具调用），单独放宽到 12MB；
// 放在全局 1MB 解析器之前，命中的请求不会被后者拦下。
// /v1 与 /v1beta 是两个独立前缀（前者不含后者），Gemini 原生协议走 /v1beta，需单独挂。
app.use('/v1', express.json({ limit: '12mb' }));
app.use('/v1beta', express.json({ limit: '12mb' }));
app.use(express.json({ limit: '1mb' }));

const wrap = (fn) => (req, res) => {
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(`[api] ${req.method} ${req.path}:`, err?.message || err);
    res.status(500).json({ error: err?.message || '服务器内部错误' });
  });
};

/**
 * 只有"确实是我们把 WorkBuddy 关掉的"才重新打开它，并保证**不把用户的应用留在关闭状态**。
 * 重新打开本身失败只回报，不抛错——登录态已经写好，重启失败不该让整个切换算失败。
 */
async function relaunchIfStopped(appStop) {
  if (!appStop?.wasRunning) return null;
  try {
    return launchWorkbuddy(appStop.exePath);
  } catch (err) {
    return { launched: false, error: err?.message || String(err) };
  }
}

const platformFromReq = (req) => {
  const id = String(req.query.platform || req.body?.platform || 'openrouter');
  return getProvider(id);
};

/* ---------------- 健康检查（前端用于探测本地服务是否在线） ---------------- */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    pid: process.pid,
    uptime: Math.round(process.uptime()),
    now: Date.now(),
    // 本机版本号：界面不再硬编码，统一从这里取
    version: LOCAL_VERSION,
    // 运行在 Electron 桌面壳里时为 true：前端据此调整「服务断开」的恢复指引
    desktop: process.env.WB_DESKTOP === '1',
  });
});

/* ---------------- 平台与模型 ---------------- */

app.get('/api/platforms', (req, res) => {
  const cfg = loadConfig();
  // 置灰只是"默认不建议"，不是"不允许"：设置里勾了「显示全部平台」就照常可选，
  // 但把原始限制原因单独作为 restriction 传下去，让界面能常驻风险提示。
  const unlockAll = !!cfg.settings.unlockAllPlatforms;
  const platforms = listPlatforms().map((p) => ({
    ...p,
    restriction: p.uiDisabled || null,
    uiDisabled: unlockAll ? null : p.uiDisabled || null,
    keyCount: cfg.keys.filter((k) => k.platform === p.id).length,
    modelCount: providers[p.id].peek?.()?.count ?? null,
  }));
  res.json({ platforms, unlockAll });
});

app.get(
  '/api/models',
  wrap(async (req, res) => {
    const provider = platformFromReq(req);
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const key = activeKeyFor(loadConfig(), provider.id);
    const data = await provider.getModels({ refresh, apiKey: key?.key || undefined, baseUrl: key?.baseUrl || undefined });
    res.json({ ...data, platform: provider.id, platformName: provider.name, note: provider.note, tutorialUrl: provider.tutorialUrl || null });
  })
);

/* ---------------- 额度（按平台聚合，只查已配置 key 的平台） ---------------- */

app.get(
  '/api/quota',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    const groups = [];
    for (const pid of PLATFORM_ORDER) {
      const provider = providers[pid];
      const keys = cfg.keys.filter((k) => k.platform === pid);
      if (!keys.length) continue;
      const list = await Promise.all(
        keys.map(async (k) => {
          const base = { keyId: k.id, platform: pid, label: k.label || maskKey(k.key), masked: maskKey(k.key) };
          // 无额度接口的平台不发起任何网络请求，仅展示本地保存的 key 状态
          if (!provider.fetchQuotaForKey) {
            const st = k.lastStatus;
            return { ...base, status: st === 'ok' || st === 'invalid' ? st : 'unknown', note: '该平台未提供额度查询接口' };
          }
          try {
            const q = await provider.fetchQuotaForKey(k.key);
            if (!q.ok) return { ...base, status: 'invalid', error: 'Key 无效或已撤销' };
            if (q.unavailable) return { ...base, status: 'ok', unavailable: q.unavailable };
            if (provider.quotaKind === 'balance') {
              return { ...base, status: 'ok', balance: q.balance || null };
            }
            const { key: info, credits } = q;
            return {
              ...base,
              status: 'ok',
              freeModelDailyRequests: info.free_model_daily_requests || null,
              usage: info.usage ?? null,
              usageDaily: info.usage_daily ?? null,
              usageWeekly: info.usage_weekly ?? null,
              usageMonthly: info.usage_monthly ?? null,
              limit: info.limit ?? null,
              limitRemaining: info.limit_remaining ?? null,
              isFreeTier: !!info.is_free_tier,
              expiresAt: info.expires_at || null,
              credits: credits ? { total: credits.total_credits ?? null, used: credits.total_usage ?? null } : null,
            };
          } catch (err) {
            return { ...base, status: 'error', error: err?.message || '查询失败' };
          }
        })
      );
      groups.push({
        platform: pid,
        platformName: provider.name,
        quotaKind: provider.quotaKind,
        note: provider.note,
        tutorialUrl: provider.tutorialUrl || null,
        keys: list,
      });
    }
    res.json({ fetchedAt: Date.now(), activeKeys: cfg.activeKeys || {}, platforms: groups });
  })
);

/* ---------------- Keys 管理（按平台） ---------------- */

app.get('/api/keys', (req, res) => {
  const cfg = loadConfig();
  res.json({
    activeKeys: cfg.activeKeys || {},
    activeKeyId: cfg.activeKeyId,
    keys: cfg.keys.map((k) => ({
      id: k.id,
      platform: k.platform,
      label: k.label || maskKey(k.key),
      masked: maskKey(k.key),
      addedAt: k.addedAt,
      lastStatus: k.lastStatus || null,
      baseUrl: k.baseUrl || null,
    })),
    configFile: CONFIG_FILE,
  });
});

/** 清洗用户粘贴的 Key：去零宽字符、所有空白字符、首尾包裹引号（网页复制的常见污染） */
function cleanKey(raw) {
  return String(raw || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '') // 零宽字符与方向控制符
    .replace(/\s+/g, '') // 空格 / 换行 / 制表符等
    .replace(/^["'`]+|["'`]+$/g, ''); // 首尾引号
}

app.post(
  '/api/keys',
  wrap(async (req, res) => {
    const key = cleanKey(req.body?.key);
    const label = String(req.body?.label || '').trim();
    const provider = getProvider(String(req.body?.platform || 'openrouter'));
    if (provider.keyFormat && !provider.keyFormat.test(key)) {
      const head = key.slice(0, 6);
      return res.status(400).json({
        error:
          `Key 格式不符合 ${provider.name} 的要求（应以 ${provider.keyPlaceholder || '正确前缀'} 开头）。` +
          `检测到粘贴内容以 "${head || '空'}" 开头、共 ${key.length} 个字符，` +
          '请确认复制的是 API Key 本身（不是页面上的其他文本），重新复制后重试',
      });
    }
    const cfg = loadConfig();
    if (cfg.keys.some((k) => k.platform === provider.id && k.key === key)) {
      return res.status(400).json({ error: '这个 Key 已经添加过了' });
    }
    // 先验真伪再入库
    const t = await provider.testKey(key);
    if (!t.ok) {
      const why = t.invalid ? t.error || '平台返回未授权（401），Key 已失效或账户未开通该服务' : t.error || '校验失败';
      return res.status(400).json({ error: `Key 无效：${why}` });
    }
    const item = {
      id: newId('key'),
      platform: provider.id,
      key,
      label: label || t.label || `${provider.name} ${maskKey(key)}`,
      addedAt: Date.now(),
      lastStatus: 'ok',
      // 多节点平台（如 Agnes 双站）：记录该 key 实际鉴权通过的节点，
      // 之后拉模型、载入 WorkBuddy 都走这个节点（key 与签发站点绑定，跨站必 401）
      baseUrl: t.baseUrl || null,
    };
    cfg.keys.push(item);
    cfg.activeKeys = { ...(cfg.activeKeys || {}) };
    if (!cfg.activeKeys[provider.id]) cfg.activeKeys[provider.id] = item.id;
    if (provider.id === 'openrouter') cfg.activeKeyId = item.id;
    saveConfig(cfg);
    res.json({ id: item.id, platform: provider.id, label: item.label, masked: maskKey(key), isFreeTier: t.isFreeTier });
  })
);

app.delete('/api/keys/:id', (req, res) => {
  const cfg = loadConfig();
  const target = cfg.keys.find((k) => k.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Key 不存在' });
  cfg.keys = cfg.keys.filter((k) => k.id !== req.params.id);
  if ((cfg.activeKeys || {})[target.platform] === req.params.id) {
    cfg.activeKeys[target.platform] = cfg.keys.find((k) => k.platform === target.platform)?.id || null;
  }
  if (cfg.activeKeyId === req.params.id) cfg.activeKeyId = cfg.keys.find((k) => k.platform === 'openrouter')?.id || null;
  saveConfig(cfg);
  res.json({ ok: true });
});

app.post('/api/keys/:id/activate', (req, res) => {
  const cfg = loadConfig();
  const target = cfg.keys.find((k) => k.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Key 不存在' });
  cfg.activeKeys = { ...(cfg.activeKeys || {}), [target.platform]: target.id };
  if (target.platform === 'openrouter') cfg.activeKeyId = target.id;
  saveConfig(cfg);
  res.json({ ok: true });
});

app.post(
  '/api/keys/:id/test',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    const k = cfg.keys.find((x) => x.id === req.params.id);
    if (!k) return res.status(404).json({ error: 'Key 不存在' });
    try {
      const t = await getProvider(k.platform).testKey(k.key);
      k.lastStatus = t.ok ? 'ok' : 'invalid';
      // 多节点平台：key 可能被删后换站点重建，重测时同步纠正生效节点
      k.baseUrl = t.baseUrl || null;
      saveConfig(cfg);
      res.json(t.ok ? { ok: true, isFreeTier: t.isFreeTier, baseUrl: t.baseUrl || null } : { ok: false, error: t.error || 'Key 无效' });
    } catch (err) {
      res.status(502).json({ ok: false, error: err?.message || '测试失败' });
    }
  })
);

/* ---------------- WorkBuddy ---------------- */

app.get(
  '/api/workbuddy/status',
  wrap(async (req, res) => {
    const loaded = listLoaded();
    const proc = await detectWorkbuddyProcess();
    res.json({
      ...loaded,
      running: proc.running,
      exePath: proc.exePath || null,
      // 进程探测本身失败（而非"确实没运行"）时透出原因，避免界面给出错误结论
      detectError: proc.error || null,
      detectMethod: proc.method || null,
      processCount: proc.processCount ?? null,
      // 降级探测（tasklist）拿不到启动时间，无法自动判断"配置待重启"
      detectWarning: proc.warning || (proc.startTimeUnknown ? '未能获取进程启动时间，无法自动判断模型配置是否需要重启' : null),
      modelsJsonMtime: modelsJsonMtime(),
      pendingRestart: isPendingRestart(proc), // 配置已变更但运行中的 WorkBuddy 尚未读取
    });
  })
);

app.get('/api/workbuddy/loaded', (req, res) => {
  res.json(listLoaded());
});

app.post(
  '/api/workbuddy/load',
  wrap(async (req, res) => {
    const modelIds = Array.isArray(req.body?.modelIds) ? req.body.modelIds.filter(Boolean) : [];
    const provider = platformFromReq(req);
    if (!modelIds.length) return res.status(400).json({ error: '请先选择要载入的模型' });

    const cfg = loadConfig();
    const keyId = req.body?.keyId || null;
    const target =
      cfg.keys.find((k) => k.platform === provider.id && k.id === keyId) || activeKeyFor(cfg, provider.id);
    if (!target) {
      return res.status(400).json({ error: `尚未配置 ${provider.name} API Key，请先到「免费模型广场 → API Keys」添加` });
    }

    const cached = provider.peek?.();
    if (!cached?.models?.length) {
      return res.status(409).json({ error: `${provider.name} 模型列表尚未加载，请先在模型页查看一次该平台` });
    }
    const index = new Map(cached.models.map((m) => [m.id, m]));

    const entries = [];
    const skipped = [];
    for (const id of modelIds) {
      const m = index.get(id);
      if (!m) {
        skipped.push({ id, reason: '模型列表中未找到' });
        continue;
      }
      if (m.outputKind !== 'text') {
        skipped.push({ id, reason: '图像/视频生成模型暂不支持载入 WorkBuddy' });
        continue;
      }
      if (m.loadable === false) {
        skipped.push({ id, reason: '该模型协议不兼容，不支持载入 WorkBuddy' });
        continue;
      }
      entries.push(provider.buildEntry(m, target.key, target.baseUrl));
    }
    if (!entries.length) {
      return res.status(400).json({ error: '没有可载入的模型', skipped });
    }
    const result = loadModels(entries);
    res.json({ ...result, keyUsed: maskKey(target.key), skipped });
  })
);

/* ---------------- 导出配置（拷给其他 agent 用：不写文件，只读生成条目） ---------------- */

/**
 * 与 /api/workbuddy/load 的区别：这一步**不改任何文件**，只把"如果要配这些模型，
 * 该填什么"算出来给界面展示与复制。
 * API Key 默认只回脱敏尾巴；界面上点「显示」时才带 reveal=1 取明文（本机工具，用户自己的 Key）。
 */
app.post(
  '/api/export/entries',
  wrap(async (req, res) => {
    const modelIds = Array.isArray(req.body?.modelIds) ? req.body.modelIds.filter(Boolean) : [];
    const provider = platformFromReq(req);
    const reveal = req.query.reveal === '1' || req.body?.reveal === true;
    if (!modelIds.length) return res.status(400).json({ error: '请先选择要导出的模型' });

    const cfg = loadConfig();
    const keyId = req.body?.keyId || null;
    const target =
      cfg.keys.find((k) => k.platform === provider.id && k.id === keyId) || activeKeyFor(cfg, provider.id);
    if (!target) {
      return res.status(400).json({ error: `尚未配置 ${provider.name} API Key，请先到「免费模型广场 → API Keys」添加` });
    }

    const cached = provider.peek?.();
    if (!cached?.models?.length) {
      return res.status(409).json({ error: `${provider.name} 模型列表尚未加载，请先在模型广场打开一次该平台` });
    }
    const index = new Map(cached.models.map((m) => [m.id, m]));

    const entries = [];
    const skipped = [];
    for (const id of modelIds) {
      const m = index.get(id);
      if (!m) {
        skipped.push({ id, reason: '模型列表中未找到' });
        continue;
      }
      const entry = provider.buildEntry(m, target.key, target.baseUrl);
      entries.push({
        ...entry,
        // 未点「显示」时不带明文，避免 Key 被无意复制到剪贴板
        apiKey: reveal ? entry.apiKey : null,
        outputKind: m.outputKind || 'text',
      });
    }
    if (!entries.length) return res.status(400).json({ error: '没有可导出的模型', skipped });

    res.json({
      platform: provider.id,
      platformName: provider.name,
      baseUrl: provider.baseUrl || null,
      protocol: 'openai-compatible',
      chatPath: '/chat/completions',
      masked: maskKey(target.key),
      apiKey: reveal ? target.key : null,
      entries,
      skipped,
    });
  })
);

app.post('/api/workbuddy/remove', (req, res) => {
  const ids = Array.isArray(req.body?.modelIds) ? req.body.modelIds.filter(Boolean) : [];
  if (!ids.length) return res.status(400).json({ error: '请选择要移除的模型' });
  res.json(removeModels(ids));
});

app.post(
  '/api/workbuddy/restart',
  wrap(async (req, res) => {
    res.json(await restartWorkbuddy());
  })
);

/* ---------------- 每日签到（仅国内版账号） ---------------- */

/** 各账号的签到状态（只读查询，不写任何东西） */
app.get(
  '/api/workbuddy/checkin/status',
  wrap(async (req, res) => {
    const accounts = loadAccounts().filter((a) => (a?.variant || 'cn') !== 'ai');
    const states = [];
    for (const account of accounts) {
      try {
        const state = await fetchCheckinStatus(account);
        states.push({ account: accountMeta(account), ...state });
      } catch (e) {
        states.push({ account: accountMeta(account), ok: false, todayCheckedIn: false, error: e?.message || '查询失败' });
      }
    }
    res.json({ states, logs: loadCheckinLogs().slice(-20).reverse() });
  })
);

/** 手动签到：带 accountId 签单个，不带则全部 */
app.post(
  '/api/workbuddy/checkin',
  wrap(async (req, res) => {
    const accountId = String(req.body?.accountId || '');
    if (accountId) {
      res.json(await checkinAccount(accountId));
    } else {
      res.json(await checkinAll({ onlyPending: req.body?.onlyPending !== false }));
    }
  })
);

/* ---------------- 登录态与目录权限自检 ---------------- */

app.get(
  '/api/workbuddy/permissions',
  wrap(async (req, res) => {
    res.json(checkPermissions());
  })
);

/* ---------------- 登录态备份管理 ---------------- */

app.get(
  '/api/workbuddy/backups',
  wrap(async (req, res) => {
    res.json({ ...listBackups(), variants: backupVariants() });
  })
);

app.post(
  '/api/workbuddy/backups/restore',
  wrap(async (req, res) => {
    const name = String(req.body?.name || '');
    if (!name) return res.status(400).json({ error: '缺少备份文件名' });
    res.json(restoreBackup(name));
  })
);

app.post(
  '/api/workbuddy/backups/clean',
  wrap(async (req, res) => {
    res.json(cleanBackups(Number(req.body?.keep) || 10));
  })
);

app.delete(
  '/api/workbuddy/backups/:name',
  wrap(async (req, res) => {
    res.json(deleteBackup(decodeURIComponent(req.params.name)));
  })
);

/* ---------------- Token 统计 ---------------- */

app.get(
  '/api/stats',
  wrap(async (req, res) => {
    const range = ['today', '7d', '30d', 'all'].includes(req.query.range) ? req.query.range : '30d';
    const variantQ = String(req.query.variant || '');
    // 档位：cn / ai 只看该档位；其他（含缺省 all）两个档位合并统计
    const variants = variantQ === 'cn' || variantQ === 'ai' ? [variantQ] : ['cn', 'ai'];
    res.json(
      await getStats({
        range,
        model: String(req.query.model || ''),
        force: req.query.force === '1', // 手动刷新时绕过结果缓存强制重扫
        variants,
      })
    );
  })
);

/* ---------------- 账号管理 ---------------- */

/**
 * 账号库 + 当前登录态。
 * accountsFile 指向 ~/.wb-switch/accounts.json（与 workbuddy-switch 共享同一份数据，
 * 两个工具互不干扰地读写，不会互相覆盖）。
 */
app.get('/api/accounts', (req, res) => {
  const accounts = loadAccounts();
  const current = detectCurrentAccount();
  // 附上最近一次验活结论：界面据此把「凭据有效」改成「服务端确认有效 / 已失效」，
  // 而不是只看本地有效期（2026-10-18 反馈：显示有效、切过去却登录过期）
  const verified = loadCredentialStatus();
  res.json({
    accounts: accounts.map((a) => ({ ...accountMeta(a), verify: verified[a.id] || null })),
    current: {
      variant: current.variant,
      uid: current.uid,
      exists: current.exists,
      authFilePath: current.authFilePath,
      account: current.account,
      warning: current.warning || null,
    },
    variants: VARIANT_LIST.map((v) => ({ id: v.id, label: v.label, authFilePath: authFilePath(v.id), dataRoot: dataRoot(v.id) })),
  });
});

/**
 * 切换账号：写登录态文件（内部先备份、失败回滚）。
 *
 * 两个可选动作，都由界面显式传入：
 * - `stopApp`：切换前**直接结束 WorkBuddy 的全部相关进程**（用户不必手动退出）。
 *   运行中的实例会把登录态改写回原账号，所以不关掉的话切换本来就无效；
 *   关进程后还会**重新打开** WorkBuddy，让用户拿到一个已登录新账号的客户端。
 * - `copySessionIds`：切换前把**当前登录账号**的这些会话复制给目标账号。
 *   顺序不能反——来源账号是「当前登录账号」，登录态一旦被改写就再也读不出源账号是谁。
 */
app.post(
  '/api/accounts/switch',
  wrap(async (req, res) => {
    const id = String(req.body?.id || '');
    if (!id) return res.status(400).json({ error: '缺少账号 id' });
    const ids = Array.isArray(req.body?.copySessionIds) ? req.body.copySessionIds : [];
    const stopApp = req.body?.stopApp === true;

    const target = findAccount(id);
    if (!target) return res.status(400).json({ error: '账号不存在' });

    /**
     * 0) 凭据验活兜底：本机「未过期」不代表服务端认可。
     *
     * 验活本身已经由**定时巡检**负责（每 6 小时一次，结论落盘），这里只是切换前的
     * 最后一道门：优先复用 10 分钟内的巡检结论，没有新鲜结论时才现验一次。
     * 明确被拒（401/403）就试一次刷新，仍不行就中止切换并给出可操作提示——
     * 而不是把死 token 写进去，让用户切过去才发现 WorkBuddy「登录已过期」。
     * 网络异常（非鉴权失败）不拦截：不能因为断网就不让用户切号。
     */
    const VERIFY_REUSE_MS = 10 * 60 * 1000;
    if (typeof target.access_token === 'string' && target.access_token) {
      let vs = verifyStateOf(target.id);
      if (!vs || Date.now() - Number(vs.at || 0) > VERIFY_REUSE_MS) {
        try {
          vs = await verifyAccount(target);
        } catch {
          vs = null;
        }
      }
      if (vs && !vs.valid && vs.unauthorized && target.refresh_token) {
        // 试着用 refresh_token 换一份新的（换不到就算了，失败不影响最终判定）
        try {
          await refreshAccessToken(target);
        } catch {
          /* 刷新失败按原判定处理 */
        }
        const fresh = findAccount(id);
        if (fresh) {
          try {
            vs = await verifyAccount(fresh);
          } catch {
            /* 保持原判定 */
          }
        }
      }
      if (vs && !vs.valid && vs.unauthorized) {
        return res.status(400).json({
          error:
            `账号「${accountDisplayName(target)}」的凭据已被服务端判定失效（本机显示未过期不代表服务端认可）。` +
            '请在 WorkBuddy 里重新登录该账号，然后重新导入到控制台再切换',
        });
      }
    }

    // 1) 先退出 WorkBuddy（未运行则空转）
    let appStop = null;
    if (stopApp) {
      try {
        appStop = await stopWorkbuddy();
      } catch (err) {
        return res.status(400).json({ error: `退出 WorkBuddy 失败，已中止切换：${err?.message || err}` });
      }
    }

    // 2) 复制会话（此刻 App 已退出，门禁能直接通过）
    let sessionCopy = null;
    if (ids.length) {
      try {
        sessionCopy = await copySessions({ targetAccountId: id, ids });
      } catch (err) {
        // 会话没复制成功就不要再动登录态了：用户的本意是"把对话带过去"，半途切号更糟
        await relaunchIfStopped(appStop);
        return res.status(400).json({ error: `会话复制失败，已中止切换：${err?.message || err}` });
      }
    }

    // 3) 写登录态；无论成败都不把用户的应用留在"被关掉"的状态
    let result;
    try {
      result = switchAccount(id);
    } catch (err) {
      await relaunchIfStopped(appStop);
      throw err;
    }
    const relaunch = await relaunchIfStopped(appStop);
    res.json({ ...result, sessionCopy, appStop, relaunch });
  })
);

/**
 * 退出 WorkBuddy（结束后台全部相关进程）。供界面上的「退出 WorkBuddy」按钮直接调用。
 * 返回 `{ stopped, wasRunning, killed, forced, exePath }`。
 */
app.post(
  '/api/workbuddy/stop',
  wrap(async (req, res) => {
    res.json(await stopWorkbuddy());
  })
);

/** 导入本机当前登录中的账号到账号库 */
app.post(
  '/api/accounts/import',
  wrap(async (req, res) => {
    const variant = String(req.body?.variant || 'cn');
    res.json(importLocalAccount(variant));
  })
);

/**
 * OAuth 扫码登录：向官方申请 state，返回验证链接（前端渲染二维码）。
 * 轮询 /api/oauth/status 等待用户扫码，成功后自动采集入库。
 */
app.post(
  '/api/oauth/start',
  wrap(async (req, res) => {
    const variant = String(req.body?.variant || 'cn');
    res.json(await oauthStart(variant));
  })
);

/** 轮询扫码登录结果（loginId 由 /api/oauth/start 返回） */
app.post(
  '/api/oauth/status',
  wrap(async (req, res) => {
    const loginId = String(req.body?.loginId || '');
    if (!loginId) return res.status(400).json({ error: '缺少 loginId' });
    res.json(await oauthPoll(loginId));
  })
);

/** 删除账号（当前登录中的账号会被拒绝） */
app.delete('/api/accounts/:id', (req, res) => {
  try {
    res.json(deleteAccount(String(req.params.id)));
  } catch (err) {
    res.status(400).json({ error: err?.message || '删除失败' });
  }
});

/** 修改账号本地备注 / 展示名来源 */
app.patch(
  '/api/accounts/:id',
  wrap(async (req, res) => {
    try {
      res.json(updateAccountDisplay(String(req.params.id), req.body || {}));
    } catch (err) {
      res.status(400).json({ error: err?.message || '保存失败' });
    }
  })
);

/* ---------------- 会话（对话记录）复制 ---------------- */

/**
 * 列出「当前登录账号 → 目标账号」可复制的会话。
 * 只读：不写任何文件、不改数据库；供账号页的会话选择弹窗渲染。
 */
app.get(
  '/api/sessions',
  wrap(async (req, res) => {
    const target = String(req.query.accountId || '');
    if (!target) return res.status(400).json({ error: '缺少 accountId' });
    res.json(await listSessionsForSwitch({ targetAccountId: target }));
  })
);

/**
 * 把选中的会话复制给目标账号（副本用新 UUID，源账号数据不受影响）。
 *
 * `stopApp: true` 时由本工具先结束 WorkBuddy 的进程再复制，并在结束后重新打开它。
 * 进程生命周期放在这一层而不是 `copySessions` 里，是因为只有这里能保证
 * "无论复制成功还是失败都把用户的 WorkBuddy 重新打开"。
 * `copySessions` 内部仍会自查 App 是否已退出（写库前的最后一道门）。
 */
app.post(
  '/api/sessions/copy',
  wrap(async (req, res) => {
    const accountId = String(req.body?.accountId || '');
    if (!accountId) return res.status(400).json({ error: '缺少 accountId' });

    let appStop = null;
    if (req.body?.stopApp === true) {
      try {
        appStop = await stopWorkbuddy();
      } catch (err) {
        return res.status(400).json({ error: `退出 WorkBuddy 失败，已中止复制：${err?.message || err}` });
      }
    }
    try {
      const report = await copySessions({ targetAccountId: accountId, ids: req.body?.ids });
      res.json({ ...report, appStop, relaunch: await relaunchIfStopped(appStop) });
    } catch (err) {
      await relaunchIfStopped(appStop);
      throw err;
    }
  })
);

/* ---------------- 积分统计 ---------------- */

/**
 * 只查积分余额（含积分包明细），供账号页卡片渲染。
 * 不扫用量明细，比 /api/credits 快得多；进程内缓存 2 分钟。
 */
app.get(
  '/api/accounts/credits',
  wrap(async (req, res) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(await getAccountBalances({ refresh }));
  })
);

/**
 * 单账号的逐笔积分明细（官方客户端「积分明细」弹窗的数据源）。
 * 进程内缓存 5 分钟；?refresh=1 强制重打官方接口。
 */
app.get(
  '/api/accounts/credit-details',
  wrap(async (req, res) => {
    const id = String(req.query.id || '').trim();
    if (!id) throw Object.assign(new Error('缺少账号 id'), { status: 400 });
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    res.json(await getCreditDetails({ accountId: id, refresh }));
  })
);

/** 官方逐请求用量投影（按日 / 按模型 / 按账号聚合） */
app.get(
  '/api/credits',
  wrap(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const variant = ['cn', 'ai'].includes(String(req.query.variant)) ? String(req.query.variant) : 'all';
    res.json(await getCreditStatistics({ days, refresh, variant }));
  })
);

/** 本地快照离线投影（官方接口不可用时的兜底） */
app.get('/api/credits/offline', (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  res.json(getOfflineCreditProjection({ days }));
});

/* ---------------- 设置 ---------------- */

function readCacheInfos() {
  return listPlatforms()
    .map((p) => {
      try {
        const raw = JSON.parse(fs.readFileSync(modelsCacheFile(p.id), 'utf8'));
        if (Array.isArray(raw?.models) && raw.models.length) {
          return { platform: p.id, platformName: p.name, fetchedAt: raw.fetchedAt, count: raw.count };
        }
      } catch {
        /* 无缓存 */
      }
      return null;
    })
    .filter(Boolean);
}

app.get(
  '/api/settings',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    res.json({
      workbuddyDir: cfg.settings.workbuddyDir || '',
      proxyUrl: cfg.settings.proxyUrl || '',
      autoCheckin: !!cfg.settings.autoCheckin,
      autoRefreshToken: !!cfg.settings.autoRefreshToken,
      autoCheckUpdate: !!cfg.settings.autoCheckUpdate,
      unlockAllPlatforms: !!cfg.settings.unlockAllPlatforms,
      effectiveProxy: await getProxyUrl(),
      detected: detectWorkbuddyDir(),
      cacheDir: cachePath(''),
      modelsCaches: readCacheInfos(),
    });
  })
);

app.put(
  '/api/settings',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    if (typeof req.body?.workbuddyDir === 'string') {
      cfg.settings.workbuddyDir = req.body.workbuddyDir.trim();
    }
    if (typeof req.body?.proxyUrl === 'string') {
      cfg.settings.proxyUrl = req.body.proxyUrl.trim();
    }
    if (typeof req.body?.autoCheckin === 'boolean') {
      cfg.settings.autoCheckin = req.body.autoCheckin;
    }
    if (typeof req.body?.autoRefreshToken === 'boolean') {
      cfg.settings.autoRefreshToken = req.body.autoRefreshToken;
    }
    if (typeof req.body?.autoCheckUpdate === 'boolean') {
      cfg.settings.autoCheckUpdate = req.body.autoCheckUpdate;
    }
    if (typeof req.body?.unlockAllPlatforms === 'boolean') {
      cfg.settings.unlockAllPlatforms = req.body.unlockAllPlatforms;
    }
    saveConfig(cfg);
    res.json({
      ok: true,
      workbuddyDir: cfg.settings.workbuddyDir,
      proxyUrl: cfg.settings.proxyUrl,
      autoCheckin: !!cfg.settings.autoCheckin,
      autoRefreshToken: !!cfg.settings.autoRefreshToken,
      autoCheckUpdate: !!cfg.settings.autoCheckUpdate,
      unlockAllPlatforms: !!cfg.settings.unlockAllPlatforms,
      effectiveProxy: await getProxyUrl(),
      detected: detectWorkbuddyDir(),
    });
  })
);

// 重新自动检测 WorkBuddy 数据目录（并附带运行状态）
app.get(
  '/api/workbuddy/detect',
  wrap(async (req, res) => {
    const detected = detectWorkbuddyDir();
    const proc = await detectWorkbuddyProcess();
    res.json({
      detected,
      running: proc.running,
      exePath: proc.exePath || null,
      detectError: proc.error || null,
      detectMethod: proc.method || null,
    });
  })
);

app.post('/api/cache/clear', (req, res) => {
  clearModelsCache(String(req.body?.platform || '')); // 空字符串 = 清全部平台
  res.json({ ok: true });
});

/* ---------------- 版本自检 ---------------- */

app.get(
  '/api/app/update',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    // 关掉自动检查时不发起任何出站请求，前端据此只显示版本号、不显示升级按钮
    if (!cfg.settings.autoCheckUpdate) {
      res.json({
        ok: true,
        disabled: true,
        current: LOCAL_VERSION,
        latest: null,
        hasUpdate: false,
        releaseUrl: null,
        downloadUrl: null,
        assetName: null,
        publishedAt: null,
        notes: '',
        checkedAt: null,
        cached: false,
        error: null,
      });
      return;
    }
    res.json(await checkForUpdate({ force: false }));
  })
);

// 手动「检查更新」是一次明确的授权动作，即使关掉了自动检查也照做
app.post(
  '/api/app/update/check',
  wrap(async (req, res) => {
    res.json(await checkForUpdate({ force: true }));
  })
);

/* ---------------- 凭据自动刷新（巡检 + 接口） ---------------- */

/** 巡检间隔：6 小时。判据本身是"临期才动手"，这里只负责定期来看一眼 */
const TOKEN_REFRESH_PATROL_MS = 6 * 60 * 60 * 1000;
let tokenRefreshBusy = false;
let tokenRefreshTimer = null;

app.get(
  '/api/accounts/refresh',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    res.json({
      autoRefreshToken: !!cfg.settings.autoRefreshToken,
      intervalHours: TOKEN_REFRESH_PATROL_MS / 3_600_000,
      accessMinHours: ACCESS_MIN_HOURS,
      refreshMinHours: REFRESH_MIN_HOURS,
      accounts: refreshPlan(),
      lastRun: lastRefreshRun(),
      logs: loadRefreshLogs().slice(0, 30),
    });
  })
);

// 手动刷新：不传 accountId 就处理全部账号；force 跳过临期判定（用户明确要求刷）
app.post(
  '/api/accounts/refresh',
  wrap(async (req, res) => {
    const accountId = req.body?.accountId ? String(req.body.accountId) : '';
    const force = req.body?.force === true || req.body?.force === '1';
    const { results, summary } = await refreshAccounts({
      accountIds: accountId ? [accountId] : null,
      force,
    });
    res.json({ ok: true, results, summary });
  })
);

async function runTokenRefreshPatrol({ silent = false } = {}) {
  if (tokenRefreshBusy) return null;
  if (!loadConfig().settings.autoRefreshToken) return null;
  tokenRefreshBusy = true;
  try {
    const { results, summary } = await refreshAccounts();
    // 平时（没有临期账号）完全静默：这类巡检不该在日志里刷存在感
    if (summary.refreshed || summary.failed || (!silent && summary.dead)) {
      console.log(
        `[refresh] 凭据巡检：验活有效 ${summary.verified ?? 0}、刷新 ${summary.refreshed}、跳过 ${summary.skipped}、失败 ${summary.failed}、需重新登录 ${summary.dead}` +
          ((summary.invalid ?? 0) > 0 ? `（其中 ${summary.invalid} 个被服务端判定失效）` : '')
      );
      for (const r of results.filter((x) => x.action === 'failed')) {
        console.error(`[refresh] 「${r.accountName}」刷新失败：${r.message}`);
      }
    }
    return summary;
  } catch (e) {
    console.error('[refresh] 凭据巡检出错:', e?.message || e);
    return null;
  } finally {
    tokenRefreshBusy = false;
  }
}

/** 启动巡检：先延迟 60 秒（不与启动时的其它初始化抢网络），之后每 6 小时一次 */
function startTokenRefreshPatrol() {
  if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
  setTimeout(() => runTokenRefreshPatrol({ silent: true }), 60_000);
  tokenRefreshTimer = setInterval(runTokenRefreshPatrol, TOKEN_REFRESH_PATROL_MS);
}

startTokenRefreshPatrol();

/* ---------------- 版本定时自检 ---------------- */

/**
 * 版本定时自检：每小时**主动**刷新一次远端版本信息（force，不吃 6 小时缓存）。
 *
 * 早先只有界面挂载时才查一次，控制台常年驻留后台的用户永远等不到升级按钮——
 * 只有下次重启才看得见新版本（2026-10-18 用户反馈）。现在由服务端定时刷新缓存，
 * 界面侧再定时取一次缓存结果，升级按钮不重启也能出现。
 *
 * 限流：GitHub 未认证接口每小时 60 次，这里每小时 1 次，余量充足；
 * 关掉「自动检查更新」后整体不工作，也不发起任何出站请求。
 */
const UPDATE_PATROL_MS = 60 * 60 * 1000;
let updatePatrolBusy = false;
let updatePatrolTimer = null;

async function runUpdatePatrol() {
  if (updatePatrolBusy) return;
  if (!loadConfig().settings.autoCheckUpdate) return;
  updatePatrolBusy = true;
  try {
    const r = await checkForUpdate({ force: true });
    if (r?.ok && r.hasUpdate) {
      console.log(`[update] 发现新版本 v${r.latest}（当前 v${r.current}），升级按钮已就绪`);
    }
  } catch (e) {
    // 网络抖动/限流都算常态，不打扰用户
    console.error('[update] 定时检查出错:', e?.message || e);
  } finally {
    updatePatrolBusy = false;
  }
}

function startUpdatePatrol() {
  if (updatePatrolTimer) clearInterval(updatePatrolTimer);
  // 启动 1 分钟后先查一次（首屏自己也会查，这里让缓存尽快就位），之后每小时一次
  setTimeout(runUpdatePatrol, 60_000);
  updatePatrolTimer = setInterval(runUpdatePatrol, UPDATE_PATROL_MS);
}

startUpdatePatrol();

/* ---------------- 自动签到巡检 ---------------- */

/** 巡检间隔：每小时检查一次，跨天自然覆盖（签到本身幂等，重复调用无副作用） */
const CHECKIN_PATROL_MS = 60 * 60 * 1000;
let checkinPatrolBusy = false;
let checkinPatrolTimer = null;

async function runCheckinPatrol({ ignoreQuietHours = false } = {}) {
  if (checkinPatrolBusy) return;
  const cfg = loadConfig();
  if (!cfg.settings.autoCheckin) return;
  // 小时级巡检只在 06:00–23:00 之间进行，避免深夜反复打扰官方接口；
  // 启动触发的那一次（ignoreQuietHours）不受此限——用户要求启动即领，而不是等到固定时间
  const hour = new Date().getHours();
  if (!ignoreQuietHours && (hour < 6 || hour >= 23)) return;
  checkinPatrolBusy = true;
  try {
    // 两道门禁：签到 + 成长中心（签到早满了也不影响成长中心的旅行/任务/补登/兑换/盲盒）
    if ((await allCheckedInToday()) && allGrowthDoneToday()) return;
    const { summary, results } = await checkinAll({ onlyPending: true, skipGrowthIfDoneToday: true });
    const failed = results.filter((r) => r.action === 'failed');
    console.log(
      `[checkin] 自动巡检完成：签到 ${summary.checked}、已签到 ${summary.already}、失败 ${summary.failed}` +
        (summary.growthCredits ? `、成长中心 +${summary.growthCredits} 积分` : '') +
        (failed.length ? `（${failed.map((f) => f.account?.name || f.account?.uid).join(', ')}）` : '')
    );
  } catch (e) {
    console.error('[checkin] 自动巡检出错:', e?.message || e);
  } finally {
    checkinPatrolBusy = false;
  }
}

/**
 * 启动巡检：先延迟 30 秒（等界面加载完），之后每小时一次。
 *
 * **每次启动必领一次**且不受夜间窗口限制（用户要求 2026-10-17）：
 * 早先那次启动巡检走 06:00–23:00 时间窗，深夜/凌晨启动会被直接跳过，
 * 积分要等到早上 6 点后的某次整点巡检才领到——变成"固定等时间"而不是"启动即领"。
 * 幂等门禁（今天已签到且成长任务已完成就直接返回）保证重复启动不会重复请求。
 */
function startCheckinPatrol() {
  if (checkinPatrolTimer) clearInterval(checkinPatrolTimer);
  setTimeout(() => runCheckinPatrol({ ignoreQuietHours: true }), 30_000);
  checkinPatrolTimer = setInterval(runCheckinPatrol, CHECKIN_PATROL_MS);
}

startCheckinPatrol();

// 反向代理已开启时，启动时预热一次模型缓存（失败不阻塞启动，页面可手动刷新）
if (loadConfig().proxy?.enabled) refreshModelsCache().catch(() => {});

/* ---------------- 手机同步（局域网） ---------------- */

/**
 * 同步服务是**独立进程内实例**，跑在自己的端口上（默认 57900），与主服务互不干扰。
 * 这里只负责"按配置启停"和"给设置页提供状态"。
 */
let lanSyncService = null;

function lanSyncPayload() {
  const s = loadConfig().settings.lanSync;
  const st = lanSyncStatus();
  return {
    ok: true,
    protocol: PROTOCOL_VERSION,
    enabled: !!s.enabled,
    port: s.port,
    refreshOnPush: !!s.refreshOnPush,
    // 配对码必须明文回给界面：用户要照着它输入到手机里
    pairCode: s.pairCode || '',
    running: st.running,
    listeningPort: st.port,
    addresses: st.addresses,
    pending: pendingSummary(),
  };
}

async function applyLanSyncConfig() {
  const s = loadConfig().settings.lanSync;
  // 没开或没配对码：一律不监听。没有配对码就等于无鉴权裸奔，这种状态宁可不启动。
  if (!s.enabled || !s.pairCode) {
    await stopLanSync();
    lanSyncService = null;
    return lanSyncPayload();
  }
  // 端口没变且已在跑：不重启，避免把手机正在用的连接掐断
  if (lanSyncService && lanSyncService.port === s.port) return lanSyncPayload();

  await stopLanSync();
  lanSyncService = null;
  try {
    lanSyncService = await startLanSync({
      port: s.port,
      getPairCode: () => loadConfig().settings.lanSync.pairCode,
      getRefreshOnPush: () => !!loadConfig().settings.lanSync.refreshOnPush,
      onLog: (m) => console.log(`[lansync] ${m}`),
    });
  } catch (err) {
    console.error(`[lansync] 启动失败（端口 ${s.port}）:`, err?.message || err);
    lanSyncService = null;
    return { ...lanSyncPayload(), error: err?.message || String(err) };
  }
  return lanSyncPayload();
}

app.get('/api/lansync/status', (req, res) => {
  res.json(lanSyncPayload());
});

app.put(
  '/api/lansync/settings',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    const s = cfg.settings.lanSync;

    if (typeof req.body?.enabled === 'boolean') s.enabled = req.body.enabled;
    if (req.body?.port !== undefined) {
      const p = Number(req.body.port);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) {
        return res.status(400).json({ error: '端口需在 1024–65535 之间' });
      }
      if (p === PORT) {
        return res.status(400).json({ error: `端口 ${p} 已被控制台主服务占用，请换一个` });
      }
      s.port = p;
    }
    if (typeof req.body?.refreshOnPush === 'boolean') s.refreshOnPush = req.body.refreshOnPush;
    // 首次开启时自动发一个配对码，省得用户面对一个"开了但用不了"的开关
    if (!s.pairCode) s.pairCode = generatePairCode();

    saveConfig(cfg);
    res.json(await applyLanSyncConfig());
  })
);

app.post(
  '/api/lansync/code/rotate',
  wrap(async (req, res) => {
    const cfg = loadConfig();
    cfg.settings.lanSync.pairCode = generatePairCode();
    saveConfig(cfg);
    const payload = await applyLanSyncConfig();
    res.json({ ...payload, pairCode: cfg.settings.lanSync.pairCode });
  })
);

app.post('/api/lansync/pending/clear', (req, res) => {
  const r = clearPending();
  res.json({ ok: !!r.ok, ...lanSyncPayload() });
});

/* ---------------- 反向代理（OpenAI 兼容，供其他 agent 调用） ---------------- */

// 必须挂在静态资源与 SPA 兜底之前，否则 /v1/* 会被 index.html 吃掉
registerProxyRoutes(app, { port: PORT });

/**
 * 按配置启停手机同步服务。失败只影响同步功能，绝不能让控制台起不来——
 * 用户可能只是恰好把端口填成了别的程序在用的值。
 */
applyLanSyncConfig()
  .then((p) => {
    if (p?.error) console.error(`[lansync] 未能启动：${p.error}`);
    else if (p?.running) console.log(`[lansync] 已就绪，等待手机连接 0.0.0.0:${p.listeningPort}`);
  })
  .catch((e) => console.error('[lansync] 初始化异常:', e?.message || e));

/* ---------------- 静态资源 + SPA ---------------- */

app.use(express.static(DIST));
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

const onListening = () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`workbuddy控制台已启动: ${url}`);
  if (process.env.NO_OPEN !== '1') {
    const cmd =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
        : process.platform === 'darwin'
          ? spawn('open', [url], { detached: true, stdio: 'ignore' })
          : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    cmd.unref();
  }
};

app.listen(PORT, '127.0.0.1', onListening);

/*
 * 同时监听 IPv6 环回。
 *
 * 只绑 127.0.0.1 时，把 `localhost` 解析成 `::1` 的客户端（本机 ping localhost 就是
 * ::1）会连不上：实测 `http://[::1]:57891/...` 返回 HTTP 000。现象是「反向代理用不了」，
 * 而且**连一条请求日志都不会有** —— 请求根本没到进程里，最容易被误判成代理坏了。
 *
 * 两个地址都只在环回范围内，不增加对外暴露面。绑不上（机器禁用 IPv6）只提示、不影响 IPv4。
 */
if (process.env.NO_IPV6 !== '1') {
  const server6 = http.createServer(app);
  server6.on('error', (err) => {
    console.warn(`IPv6 环回监听失败（不影响 IPv4 访问）: ${err?.code || err?.message}`);
  });
  server6.listen(PORT, '::1');
}
