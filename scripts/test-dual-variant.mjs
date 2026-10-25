/**
 * 国内版 / 国际版登录态分离的回归测试。
 *
 * 两档位本来就写两个文件（`workbuddy-desktop.info` / `workbuddy-desktop-ai.info`），
 * 但历史上"当前账号"只认一个（国内版优先）。于是：
 * - 界面上只能看到一档的"已登录"，另一档像是不存在；
 * - 自动刷新只保护一个 uid，另一个当前账号被当成普通账号刷掉 → 那档直接掉登录；
 * - 删除账号只拦一个，删另一个当前账号同样会掉登录。
 *
 * 这个测试造出"两档各登录一个不同账号"的状态，逐条验收上面三点，并证明
 * **切换国际版不会动国内版的登录态文件**。
 *
 * 隔离：`HOME`（登录态文件路径）+ `WB_SWITCH_HOME`（账号库）都指到临时目录，
 * 且必须在 import 之前设置。
 *
 * 运行：node scripts/test-dual-variant.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-dual-variant-'));
process.env.HOME = tmp;
process.env.WB_SWITCH_HOME = path.join(tmp, 'wb-switch');
process.env.FREE_TOKEN_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.WB_SWITCH_HOME, { recursive: true });
fs.mkdirSync(process.env.FREE_TOKEN_CONFIG_DIR, { recursive: true });

const { authFilePath } = await import('../server/workbuddy/variant.mjs');
const { loadAccounts, saveAccounts } = await import('../server/workbuddy/accounts.mjs');
const {
  detectCurrentAccount,
  detectCurrentAccounts,
  detectCurrentAccountForVariant,
  currentUids,
  deleteAccount,
  switchAccount,
} = await import('../server/workbuddy/auth.mjs');
const { refreshPlan, refreshPlanFor } = await import('../server/workbuddy/tokenRefresh.mjs');

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

const NOW = Date.now();
const HOUR = 3600_000;

/** 写一份登录态文件，模拟"该档位正登录着 uid" */
function writeAuthFile(variantId, uid) {
  const p = authFilePath(variantId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(
    p,
    JSON.stringify(
      {
        account: { uid, nickname: `${variantId}-${uid}` },
        accounts: [{ uid, nickname: `${variantId}-${uid}` }],
        allAccounts: [{ uid, nickname: `${variantId}-${uid}` }],
        auth: {
          accessToken: `AT_${uid}`,
          refreshToken: `RT_${uid}`,
          tokenType: 'Bearer',
          expiresAt: NOW + HOUR,
          lastRefreshTime: NOW - HOUR,
        },
      },
      null,
      2
    )
  );
  return p;
}

/** 账号库：两档各一条，凭据都是明文的，且都"未过期" */
function seedAccounts() {
  saveAccounts([
    {
      id: 'cn-uid',
      uid: 'cn-uid',
      nickname: '国内号',
      note: '国内号',
      variant: 'cn',
      domain: 'https://www.codebuddy.cn',
      access_token: 'AT_cn-uid',
      refresh_token: 'RT_cn-uid',
      expiresAt: NOW + HOUR,
      refreshExpiresAt: NOW + 30 * 24 * HOUR,
      refreshedAt: NOW - HOUR,
      createdAt: NOW - 10 * 24 * HOUR,
    },
    {
      id: 'ai-uid',
      uid: 'ai-uid',
      nickname: '国际号',
      note: '国际号',
      variant: 'ai',
      domain: 'https://www.workbuddy.ai',
      access_token: 'AT_ai-uid',
      refresh_token: 'RT_ai-uid',
      expiresAt: NOW + HOUR,
      refreshExpiresAt: NOW + 30 * 24 * HOUR,
      refreshedAt: NOW - HOUR,
      createdAt: NOW - 10 * 24 * HOUR,
    },
  ]);
}

seedAccounts();
const cnPath = writeAuthFile('cn', 'cn-uid');
const aiPath = writeAuthFile('ai', 'ai-uid');

/* ------------------------------------------------------------------ */
section('1. 两个档位写的是两个文件');
/* ------------------------------------------------------------------ */

check('国内版路径不同', cnPath !== aiPath, [cnPath, aiPath]);
check('国内版文件名含 workbuddy-desktop.info', cnPath.endsWith('workbuddy-desktop.info'), cnPath);
check('国际版文件名含 workbuddy-desktop-ai.info', aiPath.endsWith('workbuddy-desktop-ai.info'), aiPath);
check('两个文件都真实存在', fs.existsSync(cnPath) && fs.existsSync(aiPath));

/* ------------------------------------------------------------------ */
section('2. 分别识别两个档位的当前账号');
/* ------------------------------------------------------------------ */

{
  const all = detectCurrentAccounts();
  check('国内版当前账号 = cn-uid', all.cn.uid === 'cn-uid', all.cn.uid);
  check('国际版当前账号 = ai-uid', all.ai.uid === 'ai-uid', all.ai.uid);
  check('两档都标记为 exists', all.cn.exists && all.ai.exists);
  check('active 走国内版优先（兼容历史行为）', all.active === 'cn', all.active);

  check('单档查询：cn', detectCurrentAccountForVariant('cn').uid === 'cn-uid');
  check('单档查询：ai', detectCurrentAccountForVariant('ai').uid === 'ai-uid');
  check('单档查询：未知档位回落国内版', detectCurrentAccountForVariant('xx').variant === 'cn');

  const uids = currentUids();
  check('currentUids 返回两个', uids.length === 2 && uids.includes('cn-uid') && uids.includes('ai-uid'), uids);
}

/* ------------------------------------------------------------------ */
section('3. 老的单档位接口仍然可用（向后兼容）');
/* ------------------------------------------------------------------ */

{
  const cur = detectCurrentAccount();
  check('detectCurrentAccount 仍返回一个账号', !!cur.account);
  check('国内版优先', cur.uid === 'cn-uid', cur.uid);
  check(
    '提示文案改成"两档可分别切换"',
    typeof cur.warning === 'string' && cur.warning.includes('分别切换'),
    cur.warning
  );
}

/* ------------------------------------------------------------------ */
section('4. 自动刷新必须同时保护两个当前账号');
/* ------------------------------------------------------------------ */

{
  const plans = refreshPlan({ now: NOW });
  const cn = plans.find((p) => p.uid === 'cn-uid');
  const ai = plans.find((p) => p.uid === 'ai-uid');
  check('国内版当前账号标记 current', cn?.current === true, cn?.current);
  check('国际版当前账号也标记 current', ai?.current === true, ai?.current);
  check('两者都不参与自动刷新', cn?.due === false && ai?.due === false, [cn?.due, ai?.due]);
  check('原因都是 current', cn?.reason === 'current' && ai?.reason === 'current', [cn?.reason, ai?.reason]);
}

{
  // 只传一个 uid 时，另一个不该被误标为 current（兼容单值调用）
  const single = refreshPlanFor(
    loadAccounts().find((a) => a.uid === 'ai-uid'),
    { now: NOW, currentUid: 'cn-uid' }
  );
  check('单值 currentUid 不会误伤另一档', single.current === false, single.current);

  const multi = refreshPlanFor(
    loadAccounts().find((a) => a.uid === 'ai-uid'),
    { now: NOW, currentUids: ['cn-uid', 'ai-uid'] }
  );
  check('数组 currentUids 能命中', multi.current === true, multi.current);
}

/* ------------------------------------------------------------------ */
section('5. 两个当前账号都不允许删除');
/* ------------------------------------------------------------------ */

{
  let cnErr = '';
  try {
    deleteAccount('cn-uid');
  } catch (e) {
    cnErr = e.message;
  }
  check('删国内版当前账号被拒', cnErr.includes('国内版'), cnErr);

  let aiErr = '';
  try {
    deleteAccount('ai-uid');
  } catch (e) {
    aiErr = e.message;
  }
  check('删国际版当前账号也被拒', aiErr.includes('国际版'), aiErr);

  check('账号库没有被改动', loadAccounts().length === 2);
}

/* ------------------------------------------------------------------ */
section('6. 切换国际版不影响国内版的登录态文件');
/* ------------------------------------------------------------------ */

{
  const cnBefore = fs.readFileSync(cnPath, 'utf8');
  const result = switchAccount('ai-uid');
  const cnAfter = fs.readFileSync(cnPath, 'utf8');

  check('切换返回 ai 档位', result.variant === 'ai', result.variant);
  check('写入的是国际版文件', result.authFilePath === aiPath, result.authFilePath);
  check('国内版文件逐字节未变', cnBefore === cnAfter);

  const aiDoc = JSON.parse(fs.readFileSync(aiPath, 'utf8'));
  check('国际版文件已换成 ai-uid', aiDoc.account.uid === 'ai-uid' && aiDoc.auth.accessToken === 'AT_ai-uid');

  const after = detectCurrentAccounts();
  check('切换后国内版仍是 cn-uid', after.cn.uid === 'cn-uid', after.cn.uid);
  check('切换后国际版仍是 ai-uid', after.ai.uid === 'ai-uid', after.ai.uid);
}

/* ------------------------------------------------------------------ */
section('7. 再切回国内版同样不影响国际版');
/* ------------------------------------------------------------------ */

{
  const aiBefore = fs.readFileSync(aiPath, 'utf8');
  const result = switchAccount('cn-uid');
  const aiAfter = fs.readFileSync(aiPath, 'utf8');

  check('写入的是国内版文件', result.authFilePath === cnPath, result.authFilePath);
  check('国际版文件逐字节未变', aiBefore === aiAfter);
}

/* ------------------------------------------------------------------ */
section('8. 只有一档登录时，另一档正确显示"未登录"');
/* ------------------------------------------------------------------ */

{
  fs.rmSync(aiPath, { force: true });
  const all = detectCurrentAccounts();
  check('国内版仍登录', all.cn.exists && all.cn.uid === 'cn-uid');
  check('国际版变为未登录', all.ai.exists === false && all.ai.uid === null, all.ai);
  check('active 仍是国内版', all.active === 'cn');
  check('currentUids 只剩一个', currentUids().length === 1, currentUids());
}

/* ------------------------------------------------------------------ */
console.log(`\n${'─'.repeat(56)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log('全部通过 ✓');
}
fs.rmSync(tmp, { recursive: true, force: true });
