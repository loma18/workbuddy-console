/**
 * WorkBuddy 档位（国内版 / 国际版）的路径与端点常量。
 *
 * 复刻自 workbuddy-switch 的 variant.rs，但只保留本工具需要的部分。
 * 关键约束（务必遵守）：
 * - 绝不跨档位请求。国内版 token 只打国内域，国际版只打国际域，
 *   混用会污染统计并触发网关一致性校验失败。
 * - 登录态文件按档位分开，不能互相覆盖。
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

/** 账号所属档位的数据根目录（会话日志所在处） */
export function dataRoot(variant) {
  return path.join(os.homedir(), getVariant(variant).dataRootName);
}

/**
 * 登录态文件的候选路径。两档位**同目录、不同文件**（与 workbuddy-switch 一致）：
 * 国内版 `workbuddy-desktop.info`，国际版 `workbuddy-desktop-ai.info`。
 *
 * 桌面端与 CodeBuddy 扩展各有一份，按存在性择一。
 */
export function authFileCandidates(variant) {
  const home = os.homedir();
  const name = getVariant(variant).id === 'ai' ? 'workbuddy-desktop-ai.info' : 'workbuddy-desktop.info';
  if (process.platform === 'win32') {
    return [
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'CodeBuddyExtension', 'Data', 'Public', 'auth', name),
      path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'CodeBuddyExtension', 'Data', 'Public', 'auth', name),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth', name),
    ];
  }
  return [
    path.join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth', name),
  ];
}

/** 返回第一个真实存在的登录态文件；都不存在时返回 Windows 默认路径（供报错文案使用） */
export function authFilePath(variant) {
  const list = authFileCandidates(variant);
  for (const p of list) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* 忽略：继续尝试下一个候选 */
    }
  }
  return list[0];
}