/**
 * 官方登录态文件 `workbuddy-desktop.info` 的读写与账号切换。
 *
 * 该文件是 WorkBuddy 桌面端的登录凭据，结构为四段 JSON：
 * `{ account, accounts, allAccounts, auth }`。
 *
 * 安全约束（切换前必须满足，缺一不可）：
 * 1. 先备份当前文件到 ~/.wb-switch/backups/，切换失败可回滚；
 * 2. token 字段可能是明文也可能是 WorkBuddy 5.6 加密信封，
 *    两种形态都**原样写回**——信封降级为空串会静默毁掉登录态；
 * 3. 写完立即回读校验，解析失败或结构不对就回滚到备份。
 */
import fs from 'node:fs';
import path from 'node:path';
import { authFilePath, authWriteTargets, authBackupTag, authFilePrimaryPath, getVariant, variantOf, VARIANT_LIST } from './variant.mjs';
import {
  findAccount,
  loadAccounts,
  saveAccounts,
  secretValue,
  backupAuthFile,
  isEnvelope,
  accountDisplayName,
  hasPlainToken,
  accountMeta,
} from './accounts.mjs';

/** 读取登录态文件；不存在或解析失败返回 null */
export function readAuthFile(variant) {
  try {
    const p = authFilePath(variant);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 原子写一份登录态文件（tmp → rename），失败不留半成品。
 *
 * 单独抽出来是因为切换与凭据回写都要写**多份**（主文件 + 客户端开发态用的
 * `-dev` 文件），逐个文件重复这段逻辑容易漏掉"临时文件清理"这类边界。
 */
function writeAuthDocFile(target, doc) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件可能未生成 */
    }
    throw new Error(`写入登录态文件失败（${path.basename(target)}）：${err?.message || err}`);
  }
}

/**
 * 写一份目标文件并回读校验；校验不过立刻用备份回滚。
 *
 * 返回 `{ ok, backup }`。`expectedToken` 为明文 token 时做精确比对；
 * 加密信封无法比对，只校验结构（与历史行为一致）。
 */
function writeOneAuthTarget(target, doc, expectedToken, tag) {
  const backup = backupAuthFile(target, tag);
  writeAuthDocFile(target, doc);
  let verify = null;
  try {
    verify = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    verify = null;
  }
  const structOk = !!verify && typeof verify === 'object' && !!verify.auth;
  const tokenOk =
    typeof expectedToken !== 'string' || !expectedToken || verify?.auth?.accessToken === expectedToken;
  if (!structOk || !tokenOk) {
    if (backup && fs.existsSync(backup)) fs.copyFileSync(backup, target);
    return { ok: false, backup, reason: structOk ? 'token-mismatch' : 'bad-structure' };
  }
  return { ok: true, backup };
}

/**
 * 从账号库记录构造官方 `account` 段。
 * 以 profile_raw 为底（保留服务端下发的完整字段），再覆盖关键身份字段。
 */
export function buildAccountObject(account) {
  const obj = {};
  const raw = account?.profile_raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    Object.assign(obj, structuredClone(raw));
  }
  obj.uid = account?.uid || '';
  /**
   * 昵称可能也是加密信封（国际版实测 `account.nickname` 就是信封）。
   * `account.nickname` 只保存可读字符串，信封留在 profile_raw 里；
   * 这里不能拿空串把它覆盖掉，否则切换后客户端里的昵称会丢失。
   */
  if (typeof account?.nickname === 'string' && account.nickname.trim()) {
    obj.nickname = account.nickname;
  } else if (obj.nickname === undefined) {
    obj.nickname = '';
  }
  // 以下字段缺失时补默认值，避免 WorkBuddy 读到不完整结构
  const defaults = {
    type: 'personal',
    accountType: '',
    idp: '',
    oneidAccountId: '',
    areaInfoComplete: false,
    isCurrentOneIdEnterprise: false,
    isCurrentOneIdPersonal: false,
    isFirstLogin: false,
    isCreator: false,
    isAdmin: false,
    uin: '',
    phoneNumber: '',
    lastLogin: true,
    pluginEnabled: true,
    deployStatus: { statusCode: 0, statusMsg: '', detailMsg: '' },
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (obj[k] === undefined) obj[k] = v;
  }
  return obj;
}

/**
 * 从账号库记录构造官方 `auth` 段。
 *
 * 以 auth_raw 的内层为底，保留 scope / sessionState 等服务端字段；
 * token 用 `secretValue` 原样写入（明文字符串或加密信封都保持原形态）。
 */
export function buildAuthObject(account) {
  const obj = {};
  const raw = account?.auth_raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const inner = raw.auth && typeof raw.auth === 'object' ? raw.auth : raw;
    Object.assign(obj, structuredClone(inner));
  }
  const now = Date.now();
  obj.accessToken = secretValue(account, 'access_token') || '';
  obj.refreshToken = secretValue(account, 'refresh_token') || '';
  obj.tokenType = account?.token_type || 'Bearer';
  obj.domain = account?.domain || getVariant(variantOf(account)).apiEndpoint;
  obj.lastRefreshTime = now;
  if (obj.scope === undefined) obj.scope = 'openid profile offline_access email';

  const expiresAt = Number(account?.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    obj.expiresAt = expiresAt;
    obj.expiresIn = Math.max(0, Math.floor((expiresAt - now) / 1000));
    const refreshExpiresAt = Number(account?.refreshExpiresAt) || expiresAt;
    if (obj.refreshExpiresAt === undefined) obj.refreshExpiresAt = refreshExpiresAt;
    obj.refreshExpiresIn = Math.max(0, Math.floor((refreshExpiresAt - now) / 1000));
  } else {
    if (obj.expiresIn === undefined) obj.expiresIn = 0;
    if (obj.refreshExpiresIn === undefined) obj.refreshExpiresIn = 0;
  }
  return obj;
}

/**
 * 把账号库里的**最新凭据**回写到登录态文件（仅当该账号就是当前登录账号时）。
 *
 * ## 为什么必须有这一步（2026-10-18 用户反馈「登录状态莫名失效」）
 *
 * 官方刷新是**轮换式**的：一次刷新成功，旧 refresh_token 立即作废。而同一账号的凭据
 * 同时存在两处——账号库（本工具刷新后更新）与登录态文件（WorkBuddy 自己维护）。
 * 只更新账号库时，WorkBuddy 手里还攥着已经作废的旧 refresh_token，它下一次自己刷新
 * 就会失败 → 用户看到「登录状态莫名其妙失效」。
 *
 * 所以本工具刷新成功后，只要刷新的就是**当前登录账号**，就顺手把新凭据写回登录态文件，
 * 让两边保持一致。写入方式与 `switchAccount` 相同：备份 → 原子写 → 回读校验 → 失败回滚。
 * token 用明文写入（官方客户端接受明文并在自己下次刷新时重新加密），
 * **其余字段（scope/sessionState/notBeforePolicy 等）原样保留**。
 *
 * 非当前账号（或登录态文件不存在/uid 对不上）时不做任何事，返回 `{ synced: false }`。
 */
export function syncTokensToAuthFile(account, { authPath: overridePath = null } = {}) {
  const variant = variantOf(account);
  const authPath = overridePath || authFilePath(variant.id);
  let doc;
  try {
    if (!fs.existsSync(authPath)) return { synced: false, reason: 'no-auth-file' };
    doc = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    return { synced: false, reason: 'auth-file-unreadable' };
  }
  const liveUid = doc?.account?.uid;
  if (!liveUid || !account?.uid || String(liveUid) !== String(account.uid)) {
    return { synced: false, reason: 'not-current-account' };
  }
  const access = secretValue(account, 'access_token');
  const refresh = secretValue(account, 'refresh_token');
  if (typeof access !== 'string' || !access) return { synced: false, reason: 'no-plain-access-token' };

  const auth = doc.auth && typeof doc.auth === 'object' ? doc.auth : {};
  const now = Date.now();
  auth.accessToken = access;
  if (typeof refresh === 'string' && refresh) auth.refreshToken = refresh;
  auth.lastRefreshTime = now;
  const expiresAt = Number(account?.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt > 0) {
    auth.expiresAt = expiresAt;
    auth.expiresIn = Math.max(0, Math.floor((expiresAt - now) / 1000));
  }
  const refreshExpiresAt = Number(account?.refreshExpiresAt);
  if (Number.isFinite(refreshExpiresAt) && refreshExpiresAt > 0) {
    auth.refreshExpiresAt = refreshExpiresAt;
    auth.refreshExpiresIn = Math.max(0, Math.floor((refreshExpiresAt - now) / 1000));
  }
  doc.auth = auth;

  /**
   * 写目标：调用方指定就只写指定的（测试注入临时文件），否则写**全部**在用文件
   * ——主文件，以及客户端开发态下真正在用的 `-dev` 变体。
   */
  const targets = overridePath ? [overridePath] : authWriteTargets(variant.id);
  const backups = [];
  for (const target of targets) {
    const one = writeOneAuthTarget(target, doc, access, `authsync-${variant.id}`);
    if (!one.ok) return { synced: false, reason: `verify-failed: ${path.basename(target)}` };
    backups.push(one.backup);
  }
  return {
    synced: true,
    authFilePath: targets[0],
    authFilePaths: targets,
    backupPath: backups[0] || null,
  };
}

/**
 * 切换账号：把目标账号写入登录态文件。
 *
 * 流程：校验 → 备份 → 原子写 → 回读校验 → 失败回滚。
 * 返回 { ok, backupPath, variant, account }。
 */
export function switchAccount(accountId) {
  const account = findAccount(accountId);
  if (!account) throw new Error('账号不存在');

  const variant = variantOf(account);
  // 没有可用 token 的账号无法建立登录态
  if (!hasPlainToken(account) && !isEnvelope(account?.access_token)) {
    throw new Error(
      `账号「${accountDisplayName(account)}」没有可用的 access_token，` +
        '无法切换。请先用 WorkBuddy 登录该账号，或重新授权导入'
    );
  }

  /**
   * 写目标：主文件 + 客户端在开发态下真正在用的 `-dev` 变体（存在才写）。
   *
   * 只写主文件是不够的：客户端 5.9.3 若跑在 `NODE_ENV=development` 下会改读
   * `workbuddy-desktop-ai-dev.info`，那样"写成功 + 重启"仍然换不了账号
   * （2026-10-29 反馈：升级后点切换只重启、账号不变）。两份内容完全一致，
   * 无论客户端走哪条分支都能读到新账号。
   */
  const targets = authWriteTargets(variant.id);
  const primaryPath = targets[0] || authFilePrimaryPath(variant.id);
  fs.mkdirSync(path.dirname(primaryPath), { recursive: true });

  const accountObj = buildAccountObject(account);
  const authObj = buildAuthObject(account);
  const doc = {
    account: accountObj,
    accounts: [accountObj],
    allAccounts: [accountObj],
    auth: authObj,
  };

  const backups = [];
  for (const target of targets) {
    // 切换前备份（即使当前文件不存在也无妨，返回 null）
    const tag = authBackupTag(variant.id, target);
    const one = writeOneAuthTarget(target, doc, authObj.accessToken, tag);
    if (!one.ok) {
      throw new Error(
        one.reason === 'token-mismatch'
          ? `登录态文件回读校验失败（token 不一致，${path.basename(target)}），已回滚到切换前的备份`
          : `登录态文件回读校验失败（${path.basename(target)}），已回滚到切换前的备份`
      );
    }
    backups.push(one.backup);
  }

  return {
    ok: true,
    backupPath: backups[0] || null,
    /** 主文件（界面与备份文案以它为准） */
    authFilePath: primaryPath,
    /** 实际写入的全部文件，便于诊断"客户端到底读哪份" */
    authFilePaths: targets,
    variant: variant.id,
    account: accountMeta(account),
    /** 切换后需要重启 WorkBuddy 才会生效 */
    needRestart: true,
  };
}

/**
 * 读取**单个档位**的当前登录账号。
 *
 * 两档位的登录态本来就是两个文件（`workbuddy-desktop.info` / `workbuddy-desktop-ai.info`），
 * 所以"国内版在用 A、国际版在用 B"是完全合法的状态，必须能分别读出来。
 */
export function detectCurrentAccountForVariant(variantId) {
  const variant = getVariant(variantId);
  const authPath = authFilePath(variant.id);
  const doc = readAuthFile(variant.id);
  if (!doc) {
    return { variant: variant.id, variantLabel: variant.label, exists: false, uid: null, account: null, authFilePath: authPath };
  }
  // 老版本登录态可能没有 account.uid，退回 sessionState
  const uid = doc?.account?.uid || doc?.auth?.sessionState || null;
  const record = uid ? loadAccounts().find((a) => a?.uid === uid) || null : null;
  return {
    variant: variant.id,
    variantLabel: variant.label,
    exists: true,
    uid: uid ? String(uid) : null,
    // 账号库里没有这条记录时 account 为 null，界面应提示"尚未导入"
    account: record ? accountMeta(record) : null,
    authFilePath: authPath,
  };
}

/**
 * 两个档位各自的当前账号。
 *
 * 返回 `{ cn, ai, active }`：
 * - `cn` / `ai` 互不影响，可以各自是不同账号；
 * - `active` 只表示"界面上默认展示哪一档"，国内版存在时优先（与历史行为一致）。
 */
export function detectCurrentAccounts() {
  const cn = detectCurrentAccountForVariant('cn');
  const ai = detectCurrentAccountForVariant('ai');
  return { cn, ai, active: cn.exists ? 'cn' : ai.exists ? 'ai' : null };
}

/** 两个档位当前账号的 uid 集合（用于"不自动刷新当前账号"的判定） */
export function currentUids() {
  const all = detectCurrentAccounts();
  return [all.cn.uid, all.ai.uid].filter(Boolean).map(String);
}

/**
 * 读取当前登录态对应的账号（用于在界面上标记"当前使用中"）。
 *
 * ⚠️ 这是**单档位视图**，已保留给老调用方；需要同时看两档请用 {@link detectCurrentAccounts}。
 * 登录态文件里的 uid 与账号库比对；比对不上说明该账号尚未导入。
 */
export function detectCurrentAccount() {
  const result = { variant: 'cn', authFilePath: null, exists: false, account: null, uid: null };
  for (const vid of ['cn', 'ai']) {
    const authPath = authFilePath(vid);
    const doc = readAuthFile(vid);
    if (!doc) continue;
    if (!result.exists) {
      result.authFilePath = authPath;
      result.variant = vid;
      result.exists = true;
    }
    // 优先取有明文 token 的档位（国际版与国内版可能同时存在登录态）
    const uid = doc?.account?.uid || doc?.auth?.sessionState || null;
    if (uid && result.uid == null) result.uid = uid;
  }
  if (!result.uid) return result;
  result.account = loadAccounts().find((a) => a?.uid === result.uid) || null;
  if (result.account) {
    result.account = accountMeta(result.account);
    // 同时存在两份登录态时，说明是"两档并行"，而不是谁覆盖了谁
    const bothVariants = ['cn', 'ai'].filter((v) => readAuthFile(v));
    if (bothVariants.length > 1) {
      const active = variantOf(result.account).id;
      result.variant = active;
      result.authFilePath = authFilePath(active);
      result.warning = `国内版与国际版各有一份登录态（当前显示${active === 'cn' ? '国内版' : '国际版'}），两档可分别切换、互不影响`;
    }
  }
  return result;
}

/**
 * 从登录态文件构造一条账号库记录（`importLocalAccount` 与 `rescanLoggedInAccounts` 共用）。
 *
 * token 有两种形态：明文（OAuth 所得）或 WorkBuddy 5.6 加密信封
 * （`{$wbEncrypted: 1, envelope: '...'}`）。**信封必须原样保存**。
 *
 * 早先这里把非字符串一律降级成 `''`，于是「登录态文件只写信封」的档位
 * （实测国际版 `workbuddy-desktop-ai.info` 的 accessToken / refreshToken 都是信封，
 * 国内版升级后同样如此）导入后两个字段都是空串，`isEnvelope()` 也就判不出来——
 * 界面直接落到「无可用凭据」，切换 / 刷新 / 查余额全部失效（2026-10-26 反馈）。
 *
 * 保留信封的语义：
 * - `hasPlainToken()` 依旧为 false（确实取不出明文，发不出带鉴权的请求）；
 * - `isEnvelope()` 为真 → 界面显示「加密凭据」而不是误报「无可用凭据」；
 * - `switchAccount()` 可以原样写回登录态，切换功能可用。
 */
function recordFromAuthDoc(doc, variant, now = Date.now()) {
  const uid = doc?.account?.uid;
  const auth = doc.auth || {};
  const keepSecret = (v) => (typeof v === 'string' && v.trim() ? v : isEnvelope(v) ? v : '');
  return {
    id: uid,
    uid,
    nickname: doc?.account?.nickname && !isEnvelope(doc.account.nickname) ? doc.account.nickname : '',
    email: '',
    domain: auth.domain || variant.apiEndpoint,
    variant: variant.id,
    access_token: keepSecret(auth.accessToken),
    refresh_token: keepSecret(auth.refreshToken),
    token_type: auth.tokenType || 'Bearer',
    expiresAt: Number(auth.expiresAt) || (Number(auth.expiresIn) ? now + Number(auth.expiresIn) * 1000 : 0),
    refreshExpiresAt: Number(auth.refreshExpiresAt) || 0,
    refreshedAt: Number(auth.lastRefreshTime) || now,
    createdAt: now,
    profile_raw: doc?.account || {},
    auth_raw: { auth: auth },
  };
}

/**
 * 从登录态文件导入本机当前账号到账号库（去重：uid 已存在则覆盖 token）。
 */
export function importLocalAccount(variantId = 'cn') {
  const variant = getVariant(variantId);
  const doc = readAuthFile(variant.id);
  if (!doc) throw new Error('未读取到本地 WorkBuddy 登录信息（登录态文件不存在或已损坏）');

  const uid = doc?.account?.uid;
  if (!uid) throw new Error('登录态文件中没有账号标识（uid），无法导入');

  const now = Date.now();
  const record = recordFromAuthDoc(doc, variant, now);

  const accounts = loadAccounts();
  const idx = accounts.findIndex((a) => a?.uid === uid);
  if (idx >= 0) {
    // 已存在：保留原有的备注等本地字段，只更新凭据
    record.note = accounts[idx].note;
    record.displayField = accounts[idx].displayField;
    record.createdAt = accounts[idx].createdAt || now;
    accounts[idx] = { ...accounts[idx], ...record };
  } else {
    accounts.push(record);
  }
  saveAccounts(accounts);
  return accountMeta(record);
}

/** 凭据字段是否是"能直接放进 Authorization 头"的明文字符串 */
function isPlainSecret(value) {
  return typeof value === 'string' && !!value.trim();
}

/**
 * 把重新读到的登录态合并进账号库里已有的一条记录。
 *
 * 与 `importLocalAccount` 的差异（这也是不能直接复用它做"重新获取"的原因）：
 * 1. **不拿加密信封覆盖明文凭据**。扫码入库的账号是明文 token（能验活 / 查余额），
 *    而客户端写登录态时经常只写信封；无脑覆盖会让一个能用的账号退化成「加密凭据」。
 * 2. 登录态文件里取不到的信息（备注、展示名来源、邮箱、企业名）一律保留本地值，
 *    不能被空串抹掉——重新获取账号不该丢用户手填的东西。
 */
function mergeRescannedRecord(prev, fresh, now = Date.now()) {
  const merged = { ...prev, ...fresh };
  // 本地字段：登录态文件里没有这些，必须回填
  merged.note = prev.note;
  merged.displayField = prev.displayField;
  merged.createdAt = prev.createdAt || now;
  if (!merged.email) merged.email = prev.email || '';
  if (!merged.enterpriseName) merged.enterpriseName = prev.enterpriseName;

  const prevAccess = secretValue(prev, 'access_token');
  const fileAccess = secretValue(fresh, 'access_token');
  const keptPlainToken = isPlainSecret(prevAccess) && !isPlainSecret(fileAccess);
  if (keptPlainToken) {
    // 文件只有信封（或空）：凭据与到期时间整套沿用库里那份明文
    merged.access_token = prev.access_token;
    merged.refresh_token = prev.refresh_token;
    merged.token_type = prev.token_type || merged.token_type;
    merged.expiresAt = prev.expiresAt;
    merged.refreshExpiresAt = prev.refreshExpiresAt;
    merged.refreshedAt = prev.refreshedAt;
  } else {
    // 文件里是明文（或库里本来也没有明文）：以文件为准，但空值不覆盖已有值
    if (!merged.access_token) merged.access_token = prev.access_token;
    if (!merged.refresh_token) merged.refresh_token = prev.refresh_token;
  }
  return { record: merged, keptPlainToken };
}

/**
 * 重新获取**两档**当前已登录的账号，并同步进账号库。
 *
 * ## 为什么需要这个动作（2026-10-26 反馈）
 *
 * 用户可能在 `WorkBuddy` / `WorkBuddy AI` 客户端里直接换了账号（登出再登入），
 * 或者手动替换了登录态文件。此时登录态文件已经指向新账号，但账号库里没有它，
 * 「当前登录态」一栏只能显示"尚未导入"，界面上也就拿不到最新登录的那个账号。
 *
 * 这里强制重新读盘（不做任何缓存），逐档给出结论：
 * - `imported`：账号库里没有 → 新增；
 * - `updated`：账号库里已有 → 刷新资料与凭据；
 * - `none`：该档位没有登录态（或文件损坏 / 缺 uid），不算失败，只说明情况。
 *
 * 只读登录态文件、只写账号库，**绝不改动登录态文件本身**——重新获取账号不该影响
 * 客户端当前登录的是谁。
 */
export function rescanLoggedInAccounts() {
  const now = Date.now();
  const accounts = loadAccounts();
  const results = [];
  let dirty = false;

  for (const variant of VARIANT_LIST) {
    const base = {
      variant: variant.id,
      variantLabel: variant.label,
      authFilePath: authFilePath(variant.id),
    };
    const doc = readAuthFile(variant.id);
    if (!doc) {
      results.push({
        ...base,
        exists: false,
        ok: false,
        action: 'none',
        uid: null,
        account: null,
        message: '没有登录态文件（该档位未登录，或文件已损坏）',
      });
      continue;
    }
    // 老版本登录态可能没有 account.uid，退回 sessionState（与 detectCurrentAccountForVariant 同口径）
    const uid = doc?.account?.uid || doc?.auth?.sessionState || null;
    if (!uid) {
      results.push({
        ...base,
        exists: true,
        ok: false,
        action: 'none',
        uid: null,
        account: null,
        message: '登录态里没有账号标识（uid），无法识别账号',
      });
      continue;
    }

    const fresh = recordFromAuthDoc(doc, variant, now);
    const idx = accounts.findIndex((a) => String(a?.uid || '') === String(uid));
    if (idx < 0) {
      accounts.push(fresh);
      dirty = true;
      results.push({
        ...base,
        exists: true,
        ok: true,
        action: 'imported',
        uid: String(uid),
        account: accountMeta(fresh),
        message: `新增「${accountDisplayName(fresh)}」到账号库`,
      });
      continue;
    }

    const { record: merged, keptPlainToken } = mergeRescannedRecord(accounts[idx], fresh, now);
    accounts[idx] = merged;
    dirty = true;
    const name = accountDisplayName(merged);
    results.push({
      ...base,
      exists: true,
      ok: true,
      action: 'updated',
      uid: String(uid),
      account: accountMeta(merged),
      keptPlainToken,
      message: keptPlainToken
        ? `已刷新「${name}」的资料；登录态是加密凭据，账号库里的明文凭据已保留`
        : `已更新「${name}」的凭据与资料`,
    });
  }

  if (dirty) saveAccounts(accounts);

  return {
    results,
    accounts: accounts.map((a) => accountMeta(a)),
    currents: detectCurrentAccounts(),
    at: now,
  };
}

/** 删除账号（按 id）。当前登录中的账号不允许删，避免把用户锁在门外。 */
export function deleteAccount(accountId) {
  const accounts = loadAccounts();
  const target = accounts.find((a) => a?.id === accountId);
  if (!target) throw new Error('账号不存在');
  /**
   * 两档位各有一份登录态，所以"当前账号"可能有两个。
   * 只检查其中一个会放过另一个——删掉之后那个档位的 WorkBuddy 直接掉登录。
   */
  const uids = currentUids();
  if (target.uid && uids.includes(String(target.uid))) {
    const all = detectCurrentAccounts();
    const which = all.cn.uid === String(target.uid) ? '国内版' : '国际版';
    throw new Error(`这是${which}当前正在使用的账号，删除后该档位会失去登录态。请先切换到其他账号再删除`);
  }
  saveAccounts(accounts.filter((a) => a?.id !== accountId));
  return { ok: true };
}

/** 修改账号本地备注（不触碰任何凭据） */
export function updateAccountDisplay(accountId, patch = {}) {
  const accounts = loadAccounts();
  const idx = accounts.findIndex((a) => a?.id === accountId);
  if (idx < 0) throw new Error('账号不存在');
  if (typeof patch.note === 'string') accounts[idx].note = patch.note.trim();
  if (typeof patch.displayField === 'string') {
    // 只接受三种取值，避免写入脏数据导致展示名解析异常
    accounts[idx].displayField = ['auto', 'note', 'phone'].includes(patch.displayField)
      ? patch.displayField
      : 'auto';
  }
  saveAccounts(accounts);
  return accountMeta(accounts[idx]);
}