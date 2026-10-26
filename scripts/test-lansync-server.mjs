/**
 * 手机同步服务端到端测试：起一个真实的 HTTP 实例，用 fetch 模拟手机端。
 *
 * 覆盖的是"单测覆盖不到的那一层"：
 * - 鉴权真的会拦（无 token / 错配对码 / 未配配对码）；
 * - push 真的写盘，且回传的是电脑端最终凭据（一次往返双向对齐）；
 * - pending 队列真的能拉、能 ack，且 ack 之后拉不到；
 * - 异常输入（超大请求体、坏 JSON、空账号列表）返回的是 JSON 而不是 HTML 错误页。
 *
 * 隔离：WB_SWITCH_HOME / FREE_TOKEN_CONFIG_DIR 必须在 import 之前设置——两个目录常量
 * 都是模块加载时算出来的。
 *
 * 运行：node scripts/test-lansync-server.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-lansync-http-'));
process.env.WB_SWITCH_HOME = path.join(tmp, 'wb-switch');
process.env.FREE_TOKEN_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.WB_SWITCH_HOME, { recursive: true });
fs.mkdirSync(process.env.FREE_TOKEN_CONFIG_DIR, { recursive: true });

const ACCOUNTS_FILE = path.join(process.env.WB_SWITCH_HOME, 'accounts.json');
const CONFIG_FILE = path.join(process.env.FREE_TOKEN_CONFIG_DIR, 'config.json');
const PAIR = '12345678';

// 先铺好磁盘状态，再 import（模块会读这些路径）
fs.writeFileSync(
  CONFIG_FILE,
  JSON.stringify({ version: 1, settings: { lanSync: { enabled: true, port: 0, pairCode: PAIR, refreshOnPush: false } } }, null, 2)
);
fs.writeFileSync(
  ACCOUNTS_FILE,
  JSON.stringify(
    [
      {
        id: 'u1',
        uid: 'u1',
        nickname: '账号一',
        note: '账号一',
        variant: 'cn',
        access_token: 'AT_LOCAL_1',
        refresh_token: 'RT_LOCAL_1',
        expiresAt: Date.now() + 3600_000,
        refreshExpiresAt: Date.now() + 30 * 86400_000,
        refreshedAt: Date.now() - 2 * 3600_000,
        createdAt: Date.now() - 10 * 86400_000,
        syncVersion: 2,
      },
    ],
    null,
    2
  )
);

const { startLanSync } = await import('../server/lansync/server.mjs');
const { loadAccounts } = await import('../server/workbuddy/accounts.mjs');
const { notifyTokenRefreshed } = await import('../server/lansync/notify.mjs');
const { listPending, clearPending } = await import('../server/lansync/state.mjs');

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

const svc = await startLanSync({
  port: 0,
  getPairCode: () => PAIR,
  getRefreshOnPush: () => false,
  onLog: () => {},
});
const BASE = `http://127.0.0.1:${svc.port}`;

const post = (p, body, token = PAIR) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const get = (p, token = PAIR) =>
  fetch(BASE + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

const NOW = Date.now();

try {
  /* ------------------------------------------------------------------ */
  section('1. 探测端点（无需配对码）');
  /* ------------------------------------------------------------------ */
  {
    const r = await get('/api/lansync/ping', null);
    const j = await r.json();
    check('ping 200', r.status === 200, r.status);
    check('声明协议版本', j.protocol === 1, j.protocol);
    check('告知已配对', j.paired === true, j.paired);
    check('不泄漏配对码', !JSON.stringify(j).includes(PAIR), JSON.stringify(j));
  }

  /* ------------------------------------------------------------------ */
  section('2. 鉴权');
  /* ------------------------------------------------------------------ */
  {
    const noToken = await post('/api/lansync/push', { version: 1, accounts: [] }, null);
    check('无 Authorization → 401', noToken.status === 401, noToken.status);

    const bad = await post('/api/lansync/push', { version: 1, accounts: [] }, '00000000');
    check('配对码错误 → 401', bad.status === 401, bad.status);
    check('错误响应是 JSON', (bad.headers.get('content-type') || '').includes('json'));

    const pendingNoAuth = await get('/api/lansync/pending', null);
    check('pending 也要鉴权', pendingNoAuth.status === 401, pendingNoAuth.status);
  }

  /* ------------------------------------------------------------------ */
  section('3. 推送：新建账号');
  /* ------------------------------------------------------------------ */
  let createdUid = '';
  {
    const r = await post('/api/lansync/push', {
      version: 1,
      device: { name: 'Pixel-Test' },
      mode: 'merge',
      accounts: [
        {
          uid: 'u-new',
          label: '手机新号',
          accessToken: 'AT_PHONE',
          refreshToken: 'RT_PHONE',
          // a 端是「秒」
          expiresAt: Math.floor((NOW + 3600_000) / 1000),
          // refresh 的有效期也要跟着走：早先协议漏了这个字段，
          // 手机推过来的账号在电脑端永远显示「refresh 未知」
          refreshExpiresAt: Math.floor((NOW + 14 * 86400_000) / 1000),
          obtainedAt: NOW - 60_000,
        },
      ],
    });
    const j = await r.json();
    check('push 200', r.status === 200, r.status);
    check('动作为 create', j.results?.[0]?.action === 'create', j.results?.[0]?.action);
    check('回传 account 非空', !!j.results?.[0]?.account, j.results?.[0]);

    const acc = j.results?.[0]?.account || {};
    check('回传用 a 的字段名 token', acc.token === 'AT_PHONE', acc.token);
    check('回传 expiresAt 是秒', acc.expiresAt === Math.floor((NOW + 3600_000) / 1000), acc.expiresAt);

    const onDisk = loadAccounts().find((a) => a.uid === 'u-new');
    check('真的写进账号库了', !!onDisk);
    check('落库的 expiresAt 是毫秒', onDisk?.expiresAt > 1e12, onDisk?.expiresAt);
    check(
      '落库的 refreshExpiresAt 也是毫秒（14 天）',
      Math.abs((onDisk?.refreshExpiresAt || 0) - (NOW + 14 * 86400_000)) < 60_000,
      onDisk?.refreshExpiresAt
    );
    check('回传 refreshExpiresAt 给手机', acc.refreshExpiresAt === Math.floor((NOW + 14 * 86400_000) / 1000), acc.refreshExpiresAt);
    check('落库的 syncVersion = 1', onDisk?.syncVersion === 1, onDisk?.syncVersion);
    createdUid = onDisk?.uid || '';
  }

  /* ------------------------------------------------------------------ */
  section('4. 推送：同一条链幂等');
  /* ------------------------------------------------------------------ */
  {
    const r = await post('/api/lansync/push', {
      version: 1,
      accounts: [
        {
          uid: 'u-new',
          label: '手机新号',
          accessToken: 'AT_PHONE',
          refreshToken: 'RT_PHONE',
          expiresAt: Math.floor((NOW + 3600_000) / 1000),
          obtainedAt: NOW - 60_000,
        },
      ],
    });
    const j = await r.json();
    check('动作为 same', j.results?.[0]?.action === 'same', j.results?.[0]?.action);
    check('版本没有被无意义地推高', loadAccounts().find((a) => a.uid === 'u-new')?.syncVersion === 1);
  }

  /* ------------------------------------------------------------------ */
  section('5. 推送：电脑端更新时拒绝回退');
  /* ------------------------------------------------------------------ */
  {
    // 模拟"电脑刚刷新过"：本地版本更高、时间更新
    const accounts = loadAccounts();
    const idx = accounts.findIndex((a) => a.uid === 'u-new');
    accounts[idx] = {
      ...accounts[idx],
      access_token: 'AT_DESKTOP_NEW',
      refresh_token: 'RT_DESKTOP_NEW',
      refreshedAt: NOW - 60_000,
      syncVersion: 5,
    };
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));

    // 手机手里还是旧的
    const r = await post('/api/lansync/push', {
      version: 1,
      accounts: [
        {
          uid: 'u-new',
          label: '手机新号',
          accessToken: 'AT_PHONE',
          refreshToken: 'RT_PHONE',
          expiresAt: Math.floor((NOW + 3600_000) / 1000),
          obtainedAt: NOW - 3 * 3600_000,
        },
      ],
    });
    const j = await r.json();
    check('动作为 keep-local', j.results?.[0]?.action === 'keep-local', j.results?.[0]?.action);
    check('回传的是电脑端新凭据', j.results?.[0]?.account?.token === 'AT_DESKTOP_NEW', j.results?.[0]?.account?.token);
    check('账号库没有被旧值覆盖', loadAccounts().find((a) => a.uid === 'u-new')?.refresh_token === 'RT_DESKTOP_NEW');
  }

  /* ------------------------------------------------------------------ */
  section('6. 推送：手机重新扫码后覆盖电脑端');
  /* ------------------------------------------------------------------ */
  {
    const r = await post('/api/lansync/push', {
      version: 1,
      mode: 'force',
      accounts: [
        {
          uid: 'u-new',
          label: '手机新号',
          accessToken: 'AT_RESCAN',
          refreshToken: 'RT_RESCAN',
          expiresAt: Math.floor((NOW + 3600_000) / 1000),
          obtainedAt: NOW,
        },
      ],
    });
    const j = await r.json();
    check('force 下动作为 adopt', j.results?.[0]?.action === 'adopt', j.results?.[0]?.action);
    check('落库换成新 token', loadAccounts().find((a) => a.uid === 'u-new')?.refresh_token === 'RT_RESCAN');
    check('版本继续单调递增', (loadAccounts().find((a) => a.uid === 'u-new')?.syncVersion || 0) > 5);
    // 本次推送没带 refreshExpiresAt（模拟旧版手机）：不能把电脑端已知的有效期抹成 0
    const after = loadAccounts().find((a) => a.uid === 'u-new');
    check(
      '缺字段时不抹掉已知的 refreshExpiresAt',
      Math.abs((after?.refreshExpiresAt || 0) - (NOW + 14 * 86400_000)) < 60_000,
      after?.refreshExpiresAt
    );
  }

  /* ------------------------------------------------------------------ */
  section('7. 请求体异常');
  /* ------------------------------------------------------------------ */
  {
    const empty = await post('/api/lansync/push', { version: 1, accounts: [] });
    check('空账号列表 → 400', empty.status === 400, empty.status);

    const badJson = await post('/api/lansync/push', '{not json');
    check('坏 JSON → 400', badJson.status === 400, badJson.status);
    check('坏 JSON 也返回 JSON 错误体', (badJson.headers.get('content-type') || '').includes('json'));

    const tooBig = await post('/api/lansync/push', {
      version: 1,
      accounts: [{ uid: 'x', refreshToken: 'R'.repeat(600 * 1024) }],
    });
    check('超大请求体 → 413', tooBig.status === 413, tooBig.status);
  }

  /* ------------------------------------------------------------------ */
  section('8. 只读取凭据（fetch，不写盘）');
  /* ------------------------------------------------------------------ */
  {
    // 手机端「从电脑同步凭据」走这里：只读，绝不改电脑端账号库
    const before = JSON.stringify(loadAccounts());

    const r = await post('/api/lansync/fetch', { uids: ['u1'] });
    const j = await r.json();
    const live = loadAccounts().find((a) => a.uid === 'u1');
    check('fetch 200', r.status === 200, r.status);
    check('按 uid 命中 1 个', j.count === 1, j.count);
    check('回传 a 的字段名', j.accounts?.[0]?.token === live.access_token, j.accounts?.[0]?.token ? 'set' : 'empty');
    check('回传秒级过期时间', typeof j.accounts?.[0]?.expiresAt === 'number' && j.accounts[0].expiresAt < 1e11);
    check('回传刷新版本', j.accounts?.[0]?.version === (Number(live.syncVersion) || 0), j.accounts?.[0]?.version);
    check('明文账号标记 encrypted=false', j.accounts?.[0]?.encrypted === false, j.accounts?.[0]?.encrypted);
    check('一行都没写盘', JSON.stringify(loadAccounts()) === before);

    const miss = await post('/api/lansync/fetch', { uids: ['不存在的账号'] });
    check('未命中返回空数组', (await miss.json()).count === 0);

    const all = await post('/api/lansync/fetch', {});
    check('不传 uids 返回全部', (await all.json()).count === loadAccounts().length);

    const badShape = await post('/api/lansync/fetch', { uids: 'u1' });
    check('uids 非数组 → 400', badShape.status === 400, badShape.status);

    const noAuth = await post('/api/lansync/fetch', { uids: ['u1'] }, null);
    check('fetch 也要鉴权', noAuth.status === 401, noAuth.status);
  }

  /* ------------------------------------------------------------------ */
  section('9. 待同步队列：入队 → 拉取 → ack');
  /* ------------------------------------------------------------------ */
  {
    clearPending();
    // 模拟"电脑刷新成功后入队"（真实路径是 proxy/wb.mjs 里的钩子）
    const q = notifyTokenRefreshed(
      { uid: 'u1', access_token: 'AT_PUSH_BACK', refresh_token: 'RT_PUSH_BACK', expiresAt: NOW + 3600_000, syncVersion: 3 },
      { source: 'refresh' }
    );
    check('刷新结果成功入队', q.ok === true, q);

    const r = await get('/api/lansync/pending');
    const j = await r.json();
    check('拉取到 1 条', j.count === 1, j.count);
    check('条目带 a 的字段名', j.items?.[0]?.token === 'AT_PUSH_BACK', j.items?.[0]?.token);
    check('条目带秒级过期时间', typeof j.items?.[0]?.expiresAt === 'number' && j.items[0].expiresAt < 1e11);

    const id = j.items?.[0]?.id;
    const ack = await post('/api/lansync/ack', { ids: [id] });
    const ackJson = await ack.json();
    check('ack 成功出队', ackJson.removed === 1 && ackJson.remaining === 0, ackJson);

    const r2 = await get('/api/lansync/pending');
    check('再拉为空', (await r2.json()).count === 0);
    check('队列文件已清空', listPending().length === 0);
  }

  /* ------------------------------------------------------------------ */
  section('10. 未启用同步时不入队');
  /* ------------------------------------------------------------------ */
  {
    // 直接改配置为关闭，钩子应跳过
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfg.settings.lanSync.enabled = false;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    clearPending();
    const q = notifyTokenRefreshed({ uid: 'u1', access_token: 'A', refresh_token: 'R' });
    check('关闭时跳过入队', q.skipped === true, q);
    check('队列仍为空', listPending().length === 0);

    cfg.settings.lanSync.enabled = true;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  }
} finally {
  await svc.close();
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
