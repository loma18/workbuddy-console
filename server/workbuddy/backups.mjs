/**
 * 登录态备份管理。
 *
 * 每次切换账号前都会把当前登录态文件复制到 `~/.wb-switch/backups/`（与
 * workbuddy-switch 共用同一目录）。这里提供列出 / 恢复 / 删除 / 清理旧备份，
 * 让用户能看见并回退到任意一次切换前的状态。
 *
 * 安全约定：
 * - 恢复前先给**当前**文件再备份一次，保证恢复操作本身可回退；
 * - 恢复前校验备份内容是可解析的登录态 JSON（含 auth 对象），否则拒绝写入；
 * - 只操作 BACKUP_DIR 内的文件，文件名做白名单校验，杜绝路径穿越。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, backupAuthFile } from './accounts.mjs';
import { VARIANT_LIST, getVariant, authFilePath, authWriteTargets } from './variant.mjs';

/** 备份文件名可能来自本工具（-cn / -ai / -dev 后缀）或 workbuddy-switch（无 cn 后缀） */
const TAG_TO_VARIANT = [
  // `-dev` 在前：客户端开发态用的 `workbuddy-desktop-ai-dev.info` 也要归到国际版
  { tag: 'workbuddy-desktop-ai-dev', variant: 'ai' },
  { tag: 'workbuddy-desktop-cn-dev', variant: 'cn' },
  { tag: 'workbuddy-desktop-ai', variant: 'ai' },
  { tag: 'workbuddy-desktop-cn', variant: 'cn' },
  { tag: 'workbuddy-desktop', variant: 'cn' },
];

/** 解析备份文件名 → { tag, variant, stamp }；无法识别时 variant 为 null */
function parseName(name) {
  const stem = name.replace(/\.info$/i, '');
  for (const { tag, variant } of TAG_TO_VARIANT) {
    if (stem === tag) return { tag, variant, stamp: '' };
    if (stem.startsWith(`${tag}.`)) return { tag, variant, stamp: stem.slice(tag.length + 1) };
  }
  return { tag: stem, variant: null, stamp: '' };
}

/** stamp 形如 2026-10-12T06-11-22-345Z，还原成可读时间 */
function stampToMs(stamp) {
  if (!stamp) return null;
  const iso = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** 文件名白名单：必须是 BACKUP_DIR 内的 .info 文件，禁止路径分隔符 */
function resolveBackup(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== String(name || '') || !/\.info$/i.test(base)) {
    throw new Error('备份文件名不合法');
  }
  const full = path.join(BACKUP_DIR, base);
  const rel = path.relative(BACKUP_DIR, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('备份文件名不合法');
  if (!fs.existsSync(full)) throw new Error('备份文件不存在（可能已被清理）');
  return { base, full };
}

/** 列出全部备份（最新在前） */
export function listBackups() {
  let entries = [];
  try {
    entries = fs.readdirSync(BACKUP_DIR);
  } catch {
    return { dir: BACKUP_DIR, backups: [] };
  }
  const backups = entries
    .filter((n) => /\.info$/i.test(n))
    .map((name) => {
      const full = path.join(BACKUP_DIR, name);
      let stat = null;
      try {
        stat = fs.statSync(full);
      } catch {
        return null;
      }
      const meta = parseName(name);
      return {
        name,
        path: full,
        size: stat.size,
        mtime: stat.mtimeMs,
        variant: meta.variant,
        variantLabel: meta.variant ? getVariant(meta.variant).label : '未知档位',
        createdAt: stampToMs(meta.stamp) ?? stat.mtimeMs,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
  return { dir: BACKUP_DIR, backups };
}

/** 校验备份内容确实是登录态文件（四段 JSON 里的 auth 对象存在） */
function readAuthContent(full) {
  let raw;
  try {
    raw = fs.readFileSync(full, 'utf8');
  } catch (e) {
    throw new Error(`读取备份失败：${e?.message || e}`);
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('备份内容不是合法 JSON，已拒绝恢复');
  }
  if (!json || typeof json !== 'object' || !json.auth || typeof json.auth !== 'object') {
    throw new Error('备份内容缺少 auth 字段，不像登录态文件，已拒绝恢复');
  }
  return raw;
}

/**
 * 恢复某个备份到对应档位的登录态文件。
 * 返回 { ok, restored, authFilePath, safetyBackup, variant }
 */
export function restoreBackup(name) {
  const { base, full } = resolveBackup(name);
  const meta = parseName(base);
  const variantId = meta.variant || 'cn';
  const variant = getVariant(variantId);
  const raw = readAuthContent(full);

  /**
   * 恢复也要覆盖**客户端真正在读的那份**：主文件 + 已存在的 `-dev` 变体
   * （否则客户端跑在开发态时，恢复了备份也看不到变化）。
   */
  const targets = authWriteTargets(variant.id);
  const target = targets[0] || authFilePath(variant);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // 先把「当前」文件另存一份，恢复本身也可回退
  const safety = backupAuthFile(target, `workbuddy-desktop-${variant.id}`);

  for (const t of targets) {
    const tmp = `${t}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, raw, 'utf8');
      fs.renameSync(tmp, t);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 临时文件可能未生成 */
      }
      throw new Error(`写入登录态文件失败：${e?.message || e}`);
    }
  }

  return {
    ok: true,
    restored: base,
    authFilePath: target,
    authFilePaths: targets,
    safetyBackup: safety,
    variant: { id: variant.id, label: variant.label },
  };
}

/** 删除单个备份 */
export function deleteBackup(name) {
  const { base, full } = resolveBackup(name);
  fs.unlinkSync(full);
  return { ok: true, removed: base };
}

/** 清理旧备份：按创建时间保留最新 keep 个（1..200） */
export function cleanBackups(keep = 10) {
  const n = Math.min(Math.max(Number(keep) || 10, 1), 200);
  const { backups } = listBackups();
  const stale = backups.slice(n);
  const removed = [];
  for (const b of stale) {
    try {
      fs.unlinkSync(b.path);
      removed.push(b.name);
    } catch {
      /* 单个删除失败不影响其余 */
    }
  }
  return { ok: true, keep: n, removed: removed.length, removedNames: removed };
}

/** 供前端展示的可选档位（文案用） */
export function backupVariants() {
  return VARIANT_LIST.map((v) => ({ id: v.id, label: v.label, authFilePath: authFilePath(v) }));
}
