import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconArrowDown,
  IconCheck,
  IconClock,
  IconCopy,
  IconEdit,
  IconExternalLink,
  IconInfo,
  IconPower,
  IconQrCode,
  IconRefresh,
  IconSearch,
  IconSparkles,
  IconSwitch,
  IconTrash,
  IconUser,
  IconUsers,
  IconWarning,
  Modal,
  Hint,
  SectionHeader,
  Segmented,
  Skeleton,
  Spinner,
  Toolbar,
  useConfirm,
  useToast,
} from '../components/ui';
import { del, get, patch, post, TIMEOUT } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import type {
  AccountBalancesResponse,
  AccountInfo,
  AccountRefreshRunResponse,
  AccountsResponse,
  AppStopResult,
  CreditBalance,
  CreditDetailsResponse,
  CreditPackage,
  LoadedInfo,
  OAuthPollResult,
  OAuthStartResult,
  SessionCopyReport,
  SessionListResponse,
  SwitchAccountResult,
  VariantInfo,
} from '../lib/types';

/** 按 uid 生成稳定的头像色，同一账号每次渲染颜色一致 */
function avatarTone(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const tones = [
    'from-indigo-500 to-violet-600',
    'from-emerald-500 to-teal-600',
    'from-amber-500 to-orange-600',
    'from-sky-500 to-blue-600',
    'from-rose-500 to-pink-600',
    'from-fuchsia-500 to-purple-600',
  ];
  return tones[h % tones.length];
}

/** 积分数额：最多两位小数，千分位 */
function fmtCredits(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(v);
}

/** 积分包到期时刻：10/13 10:31；长期有效不带时刻 */
function fmtPkgExpiry(ts: number | null | undefined): string {
  if (!ts) return '长期有效';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '长期有效';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}`;
}

/** 明细行用的完整时刻：2026/10/15 11:40:29（与官方客户端「积分明细」一致，精确到秒） */
function fmtFullDateTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${hh}:${mm}:${ss}`;
}

/** 余额更新时刻：只到分 */
function fmtClock(ts: number | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function Avatar({ name, seed, size = 'md' }: { name: string; seed: string; size?: 'md' | 'lg' }) {
  const cls = size === 'lg' ? 'w-12 h-12 text-base' : 'w-12 h-12 text-base';
  return (
    <div
      className={`${cls} rounded-full bg-gradient-to-br ${avatarTone(seed)} text-white flex items-center justify-center font-semibold shrink-0 ring-4 ring-white/70 shadow-sm`}
    >
      {name.slice(0, 1).toUpperCase()}
    </div>
  );
}

/**
 * 卡片上展示的积分包：**全部包**（含 0 剩余的），按官方客户端的类别顺序排列，
 * 同类别按到期时间升序。
 *
 * 与官方客户端对齐：客户端会把已用完的「套餐基础积分」（如 0/500）也列出来，
 * 之前在这里过滤掉 0 剩余的包，导致卡片上"看不到套餐基础积分"。
 * 排序遵循客户端的三分类顺序：套餐基础积分 → 平台奖励积分 → 购买积分。
 */
const PACKAGE_CATEGORY_ORDER: Record<string, number> = {
  套餐基础积分: 0,
  平台奖励积分: 1,
  购买积分: 2,
};

function usablePackages(balance: CreditBalance | null | undefined): CreditPackage[] {
  return (balance?.packages || [])
    .slice()
    .sort((a, b) => {
      const ca = PACKAGE_CATEGORY_ORDER[a.name] ?? 3;
      const cb = PACKAGE_CATEGORY_ORDER[b.name] ?? 3;
      if (ca !== cb) return ca - cb;
      const ea = a.expireAt ?? Number.POSITIVE_INFINITY;
      const eb = b.expireAt ?? Number.POSITIVE_INFINITY;
      return ea === eb ? 0 : ea < eb ? -1 : 1;
    });
}

/**
 * 单条积分包：数额徽标 + 名称 + 到期时刻 + 细进度条。
 *
 * `pkg` 缺省时渲染**占位行**——与真实行完全同构（同一套 grid 与间距），
 * 因此两者等高，卡片不会因为积分包数量不同而参差不齐。
 */
function CreditPackageRow({ pkg }: { pkg?: CreditPackage }) {
  if (!pkg) {
    return (
      <div className="min-w-0" aria-hidden="true">
        <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-xs">
          <span className="invisible rounded-lg bg-zinc-100 px-2 py-1">0</span>
          <span className="invisible truncate">占位</span>
          <span className="invisible whitespace-nowrap">占位</span>
        </div>
        <div className="mt-1.5 h-1 rounded-full" />
      </div>
    );
  }

  const ratio = pkg.total > 0 ? Math.min(100, Math.max(0, (pkg.remaining / pkg.total) * 100)) : 0;
  const tone = pkg.expired ? 'bg-red-400' : pkg.expiringSoon ? 'bg-amber-500' : 'bg-indigo-500';
  const expiryTone = pkg.expired ? 'text-red-500' : pkg.expiringSoon ? 'text-amber-600' : 'text-zinc-400';
  const title = `${pkg.name} · 剩余 ${fmtCredits(pkg.remaining)} / ${fmtCredits(pkg.total)}${
    pkg.expireAt ? ` · ${fmtPkgExpiry(pkg.expireAt)} 到期` : ' · 长期有效'
  }`;

  return (
    <div className="min-w-0" title={title}>
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-xs">
        <span className="rounded-lg bg-zinc-100 px-2 py-1 font-medium tabular-nums text-zinc-700">
          {fmtCredits(pkg.remaining)}
        </span>
        <span className="truncate text-zinc-500">{pkg.name}</span>
        <span className={`whitespace-nowrap tabular-nums ${expiryTone}`}>{fmtPkgExpiry(pkg.expireAt)}</span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-100">
        <div className={`h-full rounded-full transition-all duration-500 ${tone}`} style={{ width: `${ratio}%` }} />
      </div>
    </div>
  );
}

/**
 * 状态占位行：与真实积分包行完全同构（同一套 grid、间距、进度条高度），
 * 中间显示状态文案（查询中 / 余额不可用 / 暂无可用积分），
 * 用来替代原来「一行小字」的状态展示——卡片在网格里等高、行与行左右对称对齐。
 */
function StatusPackageRow({ text }: { text: string }) {
  return (
    <div className="min-w-0">
      <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 text-xs">
        <span className="rounded-lg bg-zinc-100 px-2 py-1 tabular-nums text-zinc-300">—</span>
        <span className="truncate text-zinc-400">{text}</span>
        <span className="whitespace-nowrap tabular-nums text-zinc-300">—</span>
      </div>
      <div className="mt-1.5 h-1 rounded-full bg-zinc-100" />
    </div>
  );
}

/** 账号卡片：身份 + 积分余额 + 近期到期 + 操作条 */
function AccountCard({
  account,
  isCurrent,
  busy,
  balance,
  balanceLoading,
  authInvalid,
  onSwitch,
  onSyncSessions,
  onRefreshToken,
  onRename,
  onDelete,
  onShowPackages,
}: {
  account: AccountInfo;
  isCurrent: boolean;
  busy: boolean;
  balance: CreditBalance | null;
  balanceLoading: boolean;
  /** 官方接口已明确拒绝该账号的凭据（401/403）——本地未过期也不算数 */
  authInvalid: boolean;
  onSwitch: () => void;
  onSyncSessions: () => void;
  onRefreshToken: () => void;
  onRename: () => void;
  onDelete: () => void;
  onShowPackages: () => void;
}) {
  /**
   * 凭据状态：以**服务端验活结论**为准（定时巡检每 6 小时刷新一次，结果落盘）。
   * 本地 expiresAt 只说明"没到时间"，不代表官方还认这个 token——早先只看本地时间，
   * 于是出现「面板显示凭据有效、切过去 WorkBuddy 却说登录过期」（2026-10-18 反馈）。
   */
  const vs = account.verify || null;
  const credState = !account.hasPlainToken
    ? account.hasEnvelope
      ? { color: 'amber', text: '加密凭据' }
      : { color: 'red', text: '无可用凭据' }
    : vs?.unauthorized || authInvalid
      ? { color: 'red', text: '凭据已失效' }
      : account.expired
        ? { color: 'red', text: '凭据已过期' }
        : vs?.valid
          ? { color: 'green', text: '凭据有效' }
          : { color: 'gray', text: '待验活' };

  const credTitle = vs?.unauthorized
    ? `服务端于 ${fmtClock(vs.at)} 明确拒绝该凭据（token 已被轮换或吊销）。请重新登录该账号后重新导入`
    : vs?.valid
      ? `服务端于 ${fmtClock(vs.at)} 确认凭据有效`
      : authInvalid
        ? '官方接口已拒绝这个账号的凭据，本地「未过期」不算数。请重新登录该账号后重新导入'
        : !account.hasPlainToken
          ? undefined
          : '尚未验活：凭据巡检每 6 小时自动验一次，也可以点「刷新凭据」立即验证';

  const pkgs = usablePackages(balance).slice(0, 2);
  const pkgTotal = usablePackages(balance).length;

  return (
    <article
      className={`flex min-w-0 flex-col overflow-hidden rounded-2xl border bg-white shadow-[0_1px_2px_rgba(15,23,42,.025),0_10px_28px_rgba(15,23,42,.035)] transition-shadow hover:shadow-[0_2px_4px_rgba(15,23,42,.04),0_14px_34px_rgba(15,23,42,.055)] ${
        isCurrent ? 'border-emerald-200' : 'border-zinc-200'
      }`}
    >
      {/* 卡头：染色随「是否当前登录态」变化，右下角一枚柔光斑 */}
      <header className={`relative border-b px-5 py-4 ${isCurrent ? 'bg-emerald-50/50' : 'bg-zinc-50/60'}`}>
        <div
          className={`pointer-events-none absolute -right-10 -top-16 size-24 rounded-full blur-2xl ${
            isCurrent ? 'bg-emerald-300/35' : 'bg-zinc-300/40'
          }`}
        />
        <div className="relative flex items-center gap-3">
          <Avatar name={account.name} seed={account.uid || account.id} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <h3 className="truncate text-sm font-semibold leading-5 text-zinc-900" title={account.name}>
                {account.name}
              </h3>
              {isCurrent && (
                <Badge color="green" dot>
                  使用中
                </Badge>
              )}
            </div>
            <p className="mt-0.5 truncate font-mono text-xs leading-5 text-zinc-400" title={account.uid}>
              UID {account.uid}
            </p>
            {/* 备注单独显示一行：即使展示名被「手机号/邮箱」占用，改完备注也能立刻看到。
                没有备注时渲染同构的隐形占位行，保证每张卡片的头部等高、信息行对齐 */}
            {account.note ? (
              <p className="mt-1 truncate text-xs leading-5 text-zinc-500" title={`备注：${account.note}`}>
                <IconEdit className="mr-1 inline h-3 w-3 -mt-0.5 text-zinc-300" />
                备注：{account.note}
              </p>
            ) : (
              <p className="mt-1 truncate text-xs leading-5" aria-hidden="true">
                <IconEdit className="mr-1 inline h-3 w-3 -mt-0.5" />
                <span className="invisible">备注：占位</span>
              </p>
            )}
            <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge color="gray">{account.variantLabel}</Badge>
              <span title={credTitle}>
                <Badge color={credState.color}>{credState.text}</Badge>
              </span>
            </div>
          </div>
        </div>
      </header>

      <section className="flex min-w-0 flex-1 flex-col px-5 pb-5 pt-4">
        {/* 三个状态（查询中 / 不可用 / 正常）共用同一套结构：余额行 + 「近期到期」标签 + 两行积分包行。
            没有数据的位置用同构占位行补齐，保证网格里每张卡片等高、信息行对称 */}
        <div className="flex items-baseline gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5">
            <IconSparkles className="w-4 h-4 shrink-0 text-zinc-400" />
            <strong className="text-[22px] font-semibold leading-none tracking-[-0.025em] tabular-nums text-zinc-900">
              {balance ? fmtCredits(balance.remaining) : <span className="text-zinc-300">—</span>}
            </strong>
          </span>
          <span className="text-xs text-zinc-400">{balance ? `${pkgTotal} 个积分包` : '—'}</span>
          <div
            className="ml-auto flex items-center gap-1.5 text-xs text-zinc-400"
            title={
              balanceLoading
                ? '余额查询中'
                : balance
                  ? `共 ${fmtCredits(balance.total)}，已用 ${fmtCredits(balance.used)}`
                  : account.hasPlainToken
                    ? '余额查询失败'
                    : '该账号无可用凭据，无法查询余额'
            }
          >
            {balanceLoading ? <Spinner className="w-3.5 h-3.5" /> : <IconClock className="w-3.5 h-3.5 shrink-0" />}
            <span className="whitespace-nowrap tabular-nums">
              {balanceLoading ? '查询中…' : balance?.updatedAt ? `${fmtClock(balance.updatedAt)} 更新` : '—'}
            </span>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-zinc-400">积分明细</span>
          {balance && pkgTotal > 0 && (
            <button
              type="button"
              onClick={onShowPackages}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 text-[11px] font-medium text-indigo-600 transition-colors hover:text-indigo-500"
            >
              查看全部
              <IconArrowDown className="w-3 h-3 -rotate-90" />
            </button>
          )}
        </div>

        <div className="mt-4 space-y-2.5">
          {balanceLoading ? (
            <>
              <StatusPackageRow text="积分查询中…" />
              <CreditPackageRow />
            </>
          ) : !balance ? (
            <>
              <StatusPackageRow text={account.hasPlainToken ? '余额暂不可用' : '无可用凭据，无法查询余额'} />
              <CreditPackageRow />
            </>
          ) : pkgTotal === 0 ? (
            <>
              <StatusPackageRow text="暂无可用积分" />
              <CreditPackageRow />
            </>
          ) : (
            [0, 1].map((i) => <CreditPackageRow key={i} pkg={pkgs[i]} />)
          )}
        </div>
      </section>

      <footer className="flex flex-wrap items-center gap-2 border-t border-zinc-100 px-5 py-2.5">
        <Button
          variant={isCurrent ? 'subtle' : 'primary'}
          size="sm"
          className="h-7 rounded-full px-2.5 pr-3.5 text-xs"
          disabled={isCurrent || busy || !account.hasPlainToken}
          onClick={onSwitch}
          title={account.hasPlainToken ? '把 WorkBuddy 的登录态切换到这个账号' : '该账号没有可用的明文凭据，无法切换'}
        >
          {isCurrent ? <IconCheck className="w-3.5 h-3.5" /> : <IconSwitch className="w-3.5 h-3.5" />}
          {isCurrent ? '使用中' : '切换账号'}
        </Button>
        <Button size="sm" className="h-7 rounded-full px-2.5 pr-3.5 text-xs" onClick={onRename}>
          <IconEdit className="w-3.5 h-3.5" />
          备注
        </Button>
        <Button
          size="sm"
          className="h-7 rounded-full px-2.5 pr-3.5 text-xs"
          disabled={isCurrent || busy}
          onClick={onSyncSessions}
          title={
            isCurrent
              ? '这就是当前正在使用的账号，源与目标相同，无需复制会话'
              : '把当前登录账号的会话复制给这个账号（新会话 id，源账号数据不受影响）'
          }
        >
          <IconCopy className="w-3.5 h-3.5" />
          同步会话
        </Button>
        <Button
          size="sm"
          className="h-7 rounded-full px-2.5 pr-3.5 text-xs"
          disabled={busy || !account.hasPlainToken}
          onClick={onRefreshToken}
          title={
            account.hasPlainToken
              ? '用 refresh_token 换一份新的 access_token，有效期顺延（账号长期不用时可防止静默失效）'
              : '该账号没有可用的凭据，需重新扫码登录'
          }
        >
          <IconRefresh className="w-3.5 h-3.5" />
          刷新凭据
        </Button>
        <Button
          size="sm"
          variant="danger"
          className="ml-auto h-7 rounded-full px-2.5 text-xs"
          onClick={onDelete}
          disabled={isCurrent || busy}
          title="从账号库删除"
        >
          <IconTrash className="w-3.5 h-3.5" />
        </Button>
      </footer>
    </article>
  );
}

/** 备注编辑弹窗 */
function RenameDialog({
  account,
  onClose,
  onSaved,
}: {
  account: AccountInfo | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [displayField, setDisplayField] = useState<'auto' | 'note' | 'phone'>('auto');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (account) {
      setNote(account.note || '');
      setDisplayField((account.displayField as 'auto' | 'note' | 'phone') || 'auto');
    }
  }, [account]);

  if (!account) return null;

  const save = async () => {
    setSaving(true);
    try {
      await patch(`/api/accounts/${account.id}`, { note, displayField });
      toast('ok', '已保存');
      onSaved();
      onClose();
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title={`编辑「${account.name}」`}
      subtitle="仅修改本地备注，不触碰任何凭据"
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={saving} onClick={save}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1.5">备注</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="例如：主号 / 备用号 / 公司账号"
            maxLength={40}
            className="w-full h-9 px-3 rounded-xl border border-zinc-200 text-sm outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition-all"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-zinc-600 mb-1.5">列表展示名来源</label>
          <div className="space-y-1.5">
            {(
              [
                { v: 'auto', label: '自动（备注 → 邮箱 → 昵称 → UID）' },
                { v: 'note', label: '优先显示备注' },
                { v: 'phone', label: '优先显示官方手机号' },
              ] as const
            ).map((o) => (
              <label key={o.v} className="flex items-center gap-2 text-sm text-zinc-600 cursor-pointer">
                <input type="radio" checked={displayField === o.v} onChange={() => setDisplayField(o.v)} className="accent-indigo-600" />
                {o.label}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-400 leading-relaxed">
            手机号从登录态中的 profile_raw 实时读取，不额外存储一份副本。
          </p>
        </div>
      </div>
    </Modal>
  );
}

/* ---------------- 未完成的扫码请求（跨弹窗/刷新续采） ---------------- */

const PENDING_OAUTH_KEY = 'wbhub.pendingOAuth';
/** 超过该时长视为失效（官方 state 有效期 10 分钟，留一点余量） */
const PENDING_OAUTH_TTL = 12 * 60_000;

interface PendingOAuth {
  loginId: string;
  variant: 'cn' | 'ai';
  at: number;
}

export function readPendingOAuth(): PendingOAuth | null {
  try {
    const raw = localStorage.getItem(PENDING_OAUTH_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (!p?.loginId || Date.now() - Number(p.at || 0) > PENDING_OAUTH_TTL) {
      localStorage.removeItem(PENDING_OAUTH_KEY);
      return null;
    }
    return p as PendingOAuth;
  } catch {
    return null;
  }
}

function savePendingOAuth(p: PendingOAuth) {
  try {
    localStorage.setItem(PENDING_OAUTH_KEY, JSON.stringify(p));
  } catch {
    /* 隐私模式：仅影响"关弹窗后续采"，不影响本次采集 */
  }
}

function clearPendingOAuth() {
  try {
    localStorage.removeItem(PENDING_OAUTH_KEY);
  } catch {
    /* 忽略 */
  }
}

/** 把官方状态码翻译成一句人话，用于提示"卡在哪一步" */
function describeOfficialState(r: OAuthPollResult): string {
  const msg = String(r.message || '');
  if (r.code === 11217 || /login\s*ing/i.test(msg)) return '官方状态：等待手机端确认授权';
  if (r.code == null && !msg) return '官方状态：尚未收到授权结果';
  return `官方状态：${msg || `code ${r.code}`}`;
}

/**
 * 扫码添加账号：OAuth 设备码流程。
 *
 * 打开即向官方申请 state，二维码在**本地渲染**（qrcode 库，验证链接不外传），
 * 随后每 1.5 秒读一次授权结果；成功后自动采集入库并回调父组件刷新。
 * 档位决定链接域名与 platform 参数，服务端按发起档位校验，绝不混档。
 *
 * 重要：真正的轮询在**服务端**跑（手机授权是异步的，用户常关掉弹窗或刷新页面），
 * 前端只负责读状态；未完成的请求会记到 localStorage，重开页面后仍能续上结果。
 */
function ScanAddDialog({
  open,
  variant,
  variantLabel,
  onClose,
  onAdded,
}: {
  open: boolean;
  variant: 'cn' | 'ai';
  variantLabel: string;
  onClose: () => void;
  onAdded: (acc: AccountInfo) => void;
}) {
  const toast = useToast();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<'starting' | 'waiting' | 'done' | 'failed'>('starting');
  const [uri, setUri] = useState('');
  const [loginId, setLoginId] = useState('');
  const [deadline, setDeadline] = useState(0);
  const [remain, setRemain] = useState(0);
  const [result, setResult] = useState<AccountInfo | null>(null);
  const [error, setError] = useState('');
  const [qrFailed, setQrFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 官方接口的原始状态文案，用于解释"卡在哪一步" */
  const [official, setOfficial] = useState('');
  /** 成功回调进 ref：父组件传的是内联函数，直接进 deps 会让轮询效应反复重启 */
  const onAddedRef = useRef(onAdded);
  onAddedRef.current = onAdded;

  const start = useCallback(async () => {
    setPhase('starting');
    setUri('');
    setLoginId('');
    setResult(null);
    setError('');
    setQrFailed(false);
    setOfficial('');
    try {
      const r = await post<OAuthStartResult>('/api/oauth/start', { variant });
      setUri(r.verificationUri);
      setLoginId(r.loginId);
      setDeadline(Date.now() + r.expiresIn * 1000);
      setPhase('waiting');
      // 记录本次请求：弹窗关掉/页面刷新后仍能续上采集结果
      savePendingOAuth({ loginId: r.loginId, variant, at: Date.now() });
    } catch (e: any) {
      setError(e?.message || '发起登录失败');
      setPhase('failed');
    }
  }, [variant]);

  /** 在系统浏览器打开授权页：官方页在浏览器里完成绑定，本页只负责等结果 */
  const openAuthPage = useCallback(() => {
    if (!uri) return;
    const w = window.open(uri, '_blank', 'noopener,noreferrer');
    if (!w) toast('info', '浏览器拦截了新窗口，请点下方链接手动打开，或复制链接到浏览器');
  }, [uri, toast]);

  // 打开弹窗即自动发起，省一次点击
  useEffect(() => {
    if (open) void start();
  }, [open, start]);

  // 有效期倒计时（官方 state 有效期 10 分钟）
  useEffect(() => {
    if (phase !== 'waiting') return;
    const tick = () => setRemain(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [phase, deadline]);

  // 二维码本地渲染：失败时降级为展示链接（不依赖任何第三方二维码服务）
  // deps 带 phase：canvas 在 waiting 态才挂载，仅依赖 uri 会在 canvas 就绪前空跑
  useEffect(() => {
    if (!uri || !canvasRef.current) return;
    let alive = true;
    QRCode.toCanvas(canvasRef.current, uri, {
      width: 208,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#18181b', light: '#ffffff' },
    })
      .then(() => {
        if (alive) setQrFailed(false);
      })
      .catch(() => {
        if (alive) setQrFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [uri, phase]);

  // 轮询授权结果：done=false 继续等，done+result 已入库，done+error 失败/超时
  // 服务端有常驻采集循环，这里只是"读状态"，关掉弹窗也不影响账号入库
  useEffect(() => {
    if (!loginId) return;
    let timer: number | undefined;
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await post<OAuthPollResult>('/api/oauth/status', { loginId });
        if (cancelled) return;
        if (r.done) {
          clearPendingOAuth();
          if (r.result) {
            setResult(r.result);
            setPhase('done');
            onAddedRef.current(r.result);
          } else {
            setError(r.error || '登录失败');
            setPhase('failed');
          }
          return;
        }
        // 未完成：把官方原始状态显示出来，用户能判断是"没扫"还是"官方还在处理"
        setOfficial(describeOfficialState(r));
        timer = window.setTimeout(poll, 1500);
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || '轮询失败');
        setPhase('failed');
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [loginId]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(uri);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast('err', '复制失败，请手动选中链接复制');
    }
  };

  // 过期判定只看 deadline：remain 初始为 0，若用它判断会在 waiting 首帧误判过期，
  // 导致 canvas 来不及挂载、二维码效果空跑（表现为二维码区域永远空白）
  const expired = phase === 'waiting' && deadline > 0 && Date.now() >= deadline;
  const mmss = `${String(Math.floor(remain / 60)).padStart(2, '0')}:${String(remain % 60).padStart(2, '0')}`;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="扫码添加账号"
      subtitle={`${variantLabel} · 授权成功后自动采集入库`}
      footer={
        phase === 'done' ? (
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>取消</Button>
            <Button variant="subtle" onClick={() => void start()} loading={phase === 'starting'}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新二维码
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3.5 text-sm">
        {phase === 'starting' && (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-400">
            <Spinner className="w-4 h-4" />
            正在向官方申请登录凭证…
          </div>
        )}

        {phase === 'waiting' && uri && !expired && (
          <>
            {variant === 'ai' && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800 leading-relaxed">
                <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
                <span>
                  若浏览器已登录 workbuddy.ai，授权页会直接跳到「登录成功」而不会绑定新账号。
                  请复制链接到<strong>无痕（隐私）窗口</strong>打开并完成登录。
                </span>
              </div>
            )}
            {/* 首选：浏览器里完成授权。官方页在浏览器里点「同意」才会绑定 state，
                手机扫码偶发不绑定的情况，走浏览器最稳；二维码保留给手机扫码用户。 */}
            <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-3.5 py-3 space-y-2">
              <div className="text-xs text-indigo-800 leading-relaxed">
                推荐在<strong>浏览器</strong>中完成授权：点下面的按钮打开官方登录页，登录并同意后本页会自动采集账号。
              </div>
              <Button variant="primary" className="w-full" onClick={openAuthPage}>
                <IconExternalLink className="w-4 h-4" />
                在浏览器中打开授权页
              </Button>
            </div>

            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-zinc-100" />
              <span className="text-[11px] text-zinc-400">或用手机扫码</span>
              <span className="h-px flex-1 bg-zinc-100" />
            </div>

            <div className="flex flex-col items-center gap-3">
              {qrFailed ? (
                <div className="text-xs text-zinc-400">二维码渲染失败，请直接打开上方按钮或下方链接完成授权</div>
              ) : (
                <canvas ref={canvasRef} className="rounded-xl border border-zinc-200" width={208} height={208} />
              )}
              <div className="flex items-center gap-1.5 text-xs text-zinc-400 tabular-nums">
                <IconClock className="w-3.5 h-3.5" />
                有效期剩余 {mmss}
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2">
              <a
                href={uri}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 flex-1 truncate font-mono text-[11px] text-indigo-600 hover:underline"
                title="在浏览器中打开验证链接"
              >
                {uri}
              </a>
              <Button size="sm" variant="ghost" onClick={copyLink} title="复制验证链接">
                {copied ? <IconCheck className="w-3.5 h-3.5" /> : <IconCopy className="w-3.5 h-3.5" />}
                {copied ? '已复制' : '复制'}
              </Button>
            </div>
            <p className="text-center text-xs text-zinc-400">
              {variant === 'ai' ? '正在等待 Web 登录授权…' : '正在等待授权，浏览器完成或手机扫码后会自动采集…'}
            </p>
            <p className="text-center text-[11px] text-zinc-300">
              {official || '已提交，正在等待官方返回授权结果'}
            </p>
            <Hint className="justify-center">
              授权由本机服务在后台等待并自动采集：中途关闭这个弹窗不会中断，重新打开「扫码添加账号」会继续等待上一次授权（约 12 分钟内有效）。
            </Hint>
          </>
        )}

        {phase === 'waiting' && expired && (
          <div className="space-y-3 py-4 text-center">
            <div className="text-sm text-zinc-500">二维码已过期（有效期 10 分钟）</div>
            <Button variant="primary" onClick={() => void start()}>
              <IconRefresh className="w-3.5 h-3.5" />
              重新获取
            </Button>
          </div>
        )}

        {phase === 'done' && result && (
          <div className="flex flex-col items-center gap-2.5 py-6">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
              <IconCheck className="w-5 h-5" />
            </div>
            <div className="text-sm text-zinc-700">
              已添加账号「<b className="text-zinc-900">{result.name}</b>」
            </div>
            <div className="text-xs text-zinc-400">已写入账号库，可在下方一键切换</div>
          </div>
        )}

        {phase === 'failed' && (
          <div className="space-y-3 py-2">
            <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700 leading-relaxed">
              <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-red-500" />
              <span>{error || '登录失败'}</span>
            </div>
            <div className="text-center">
              <Button variant="subtle" onClick={() => void start()}>
                <IconRefresh className="w-3.5 h-3.5" />
                重试
              </Button>
            </div>
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-zinc-400">
          扫码链接由官方接口实时生成，仅在本机渲染二维码；授权凭据直接写入本机账号库
          <span className="font-mono"> ~/.wb-switch/accounts.json</span>，不经过任何第三方服务器。
        </p>
      </div>
    </Modal>
  );
}

/**
 * 积分明细弹窗：逐笔列出官方明细接口的发放记录（与官方客户端「积分明细」同形）。
 *
 * 打开时请求 `/api/accounts/credit-details`（服务端缓存 5 分钟）；按
 * 「有效期内 / 已过期」两个 tab 分组，行内展示包名、到期时刻（精确到秒）
 * 与「已使用 x/y」进度条。明细查询失败时回落到汇总包视图并提示原因。
 */
function PackagesDialog({ account, balance, onClose }: { account: AccountInfo | null; balance: CreditBalance | null; onClose: () => void }) {
  const [details, setDetails] = useState<CreditDetailsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** tab：'active' = 有效期内（含长期有效），'expired' = 已过期 */
  const [tab, setTab] = useState<'active' | 'expired'>('active');

  useEffect(() => {
    if (!account) {
      setDetails(null);
      setError(null);
      setTab('active');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetails(null);
    setTab('active');
    get<CreditDetailsResponse>(`/api/accounts/credit-details?id=${encodeURIComponent(account.id)}`, { timeoutMs: TIMEOUT.quota })
      .then((r) => {
        if (!cancelled) setDetails(r);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e?.message || '明细查询失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [account]);

  if (!account) return null;

  const records = details?.records || [];
  const active = records.filter((r) => !r.expired);
  const expired = records.filter((r) => r.expired);
  const shown = tab === 'active' ? active : expired;

  return (
    <Modal
      open={!!account}
      onClose={onClose}
      title="积分明细"
      subtitle={
        balance
          ? `${account.name} · 剩余 ${fmtCredits(balance.remaining)} / 总额 ${fmtCredits(balance.total)} · 已用 ${fmtCredits(balance.used)}`
          : account.name
      }
      footer={<Button onClick={onClose}>关闭</Button>}
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-zinc-400">
          <Spinner className="w-4 h-4" />
          正在获取逐笔明细…
        </div>
      ) : error ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800">
            逐笔明细获取失败：{error}。以下为按包汇总的视图。
          </div>
          <PackagesFallback account={account} balance={balance} />
        </div>
      ) : records.length === 0 ? (
        <div className="py-6 text-center text-sm text-zinc-400">当前没有积分明细记录。</div>
      ) : (
        <div className="min-w-0">
          {/* 分组 tab：与官方客户端一致（有效期内 / 已过期） */}
          <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1">
            {(
              [
                { key: 'active' as const, label: `有效期内 ${active.length}` },
                { key: 'expired' as const, label: `已过期 ${expired.length}` },
              ]
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`h-8 cursor-pointer rounded-lg text-xs font-medium transition-all ${
                  tab === t.key ? 'bg-white text-zinc-900 shadow-sm' : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="max-h-[55vh] min-w-0 space-y-3 overflow-y-auto pr-1">
            {shown.map((r, i) => {
              const ratio = r.total > 0 ? Math.min(100, Math.max(0, (r.used / r.total) * 100)) : 0;
              // 已用完的记录仍列在「有效期内」（客户端同口径），但加标记说明它不再提供额度
              const usedUp = !r.expired && r.remaining <= 0;
              return (
                <div key={`${r.packageCode || 'rec'}-${i}`} className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium text-zinc-800">{r.name}</span>
                    {usedUp && (
                      <span className="shrink-0 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
                        已用完
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex min-w-0 items-baseline justify-between gap-3 text-xs">
                    <span className="shrink-0 text-zinc-500">
                      {r.expireAt ? `到期时间 ${fmtFullDateTime(r.expireAt)}` : '长期有效'}
                    </span>
                    <span className={`shrink-0 tabular-nums ${r.expired || usedUp ? 'text-zinc-400' : 'text-zinc-700'}`}>
                      已使用 {fmtCredits(r.used)}/{fmtCredits(r.total)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-zinc-100">
                    <div
                      className={`h-full rounded-full ${r.expired || usedUp ? 'bg-zinc-300' : 'bg-emerald-500'}`}
                      style={{ width: `${ratio}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {shown.length === 0 && (
              <div className="py-6 text-center text-sm text-zinc-400">
                {tab === 'expired' ? '没有已过期的记录。' : '有效期内没有记录。'}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** 明细接口失败时的回落视图：按包汇总展示（旧「全部积分包」的内容） */
function PackagesFallback({ account, balance }: { account: AccountInfo; balance: CreditBalance | null }) {
  const all = (balance?.packages || [])
    .slice()
    .sort((a, b) => {
      const ca = PACKAGE_CATEGORY_ORDER[a.name] ?? 3;
      const cb = PACKAGE_CATEGORY_ORDER[b.name] ?? 3;
      if (ca !== cb) return ca - cb;
      const ea = a.expireAt ?? Number.POSITIVE_INFINITY;
      const eb = b.expireAt ?? Number.POSITIVE_INFINITY;
      return ea === eb ? 0 : ea < eb ? -1 : 1;
    });

  if (all.length === 0) {
    return <div className="py-6 text-center text-sm text-zinc-400">当前没有可展示的积分包。</div>;
  }
  return (
    <div className="min-w-0 divide-y divide-zinc-100">
      {all.map((p, i) => {
        const ratio = p.total > 0 ? Math.min(100, Math.max(0, (p.remaining / p.total) * 100)) : 0;
        return (
          <div key={`${p.packageCode || 'pkg'}-${i}`} className="min-w-0 py-3 first:pt-0 last:pb-0">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-zinc-800">{p.name}</div>
                <div className="mt-1 text-[11px] text-zinc-400">
                  {p.expired ? '已到期' : p.expireAt ? `到期 ${fmtDateTime(p.expireAt)}` : '长期有效'}
                </div>
              </div>
              <div className="shrink-0 text-right text-xs">
                <div className="font-medium tabular-nums text-zinc-700">
                  {fmtCredits(p.remaining)} / {fmtCredits(p.total)}
                </div>
                <div className="mt-1 text-[11px] text-zinc-400">已用 {fmtCredits(p.used)}</div>
              </div>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-100">
              <div
                className={`h-full rounded-full ${p.expired ? 'bg-red-400/70' : p.expiringSoon ? 'bg-amber-500/80' : 'bg-indigo-500/75'}`}
                style={{ width: `${ratio}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 体积：B → 人类可读；复制会话的体积提示用（单会话可达几十 MB） */
function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** 会话列表一次最多渲染多少行：本机有 3300+ 条，全渲染会明显卡顿，靠搜索收敛 */
const SESSION_RENDER_LIMIT = 200;

/**
 * 「自动退出 WorkBuddy」勾选行（受控纯展示，两处复用）。
 *
 * 勾上后：切换/复制前由服务端结束 WorkBuddy 的全部相关进程，确认退出后才动数据；
 * 切换完成后再把它重新打开（只重开"确实是我们关掉的"那种情况）。
 */
function StopAppRow({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <label
      className={`mt-3 flex items-start gap-2 rounded-xl border px-3 py-2.5 ${
        disabled ? 'cursor-not-allowed border-zinc-200 bg-zinc-50' : 'cursor-pointer border-indigo-200 bg-indigo-50/60'
      }`}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-indigo-600"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-xs leading-relaxed text-indigo-900">
        <b>自动退出 WorkBuddy</b>：由本工具结束后台的全部 WorkBuddy 进程，确认退出后才执行，不再需要你手动关闭。
        {children}
      </span>
    </label>
  );
}

/**
 * 确认弹窗里用的版本：自己持有勾选状态并把值写进外部 ref。
 *
 * 必须这样做：确认弹窗保存的是**调用那一刻的消息节点快照**，
 * 由父组件受控的 checkbox 不会跟着父组件重渲染，勾了也读不到。
 */
function StopAppToggleRef({ flagRef }: { flagRef: { current: boolean } }) {
  const [on, setOn] = useState(true);
  return (
    <StopAppRow
      checked={on}
      onChange={(v) => {
        setOn(v);
        flagRef.current = v;
      }}
    />
  );
}

/**
 * 切换确认框里的「同时复制会话」勾选（同样只能自己持有状态 + 写外部 ref，原因见上）。
 */
function CopyOnSwitchToggle({ flagRef }: { flagRef: { current: boolean } }) {
  const [on, setOn] = useState(false);
  return (
    <label className="mt-2 flex cursor-pointer items-start gap-2 rounded-xl border border-indigo-200 bg-indigo-50/60 px-3 py-2.5">
      <input
        type="checkbox"
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-indigo-600"
        checked={on}
        onChange={(e) => {
          setOn(e.target.checked);
          flagRef.current = e.target.checked;
        }}
      />
      <span className="text-xs leading-relaxed text-indigo-900">
        <b>同时复制会话</b>：把当前账号的会话也带给这个账号。勾选后会先打开会话选择列表，
        由你挑要复制哪些（复制用的是新会话 id，源账号的数据不受影响）。
      </span>
    </label>
  );
}

/**
 * 会话复制弹窗：列出「当前登录账号 → 目标账号」可复制的会话并执行复制。
 *
 * `mode='switch'` 时按钮变成「复制并切换」——先复制会话、再写登录态文件。
 * 顺序不能反：来源账号是「当前登录账号」，登录态一旦被改写就再也读不出源账号是谁。
 */
function SessionCopyDialog({
  open,
  target,
  mode,
  wbRunning,
  onClose,
  onDone,
}: {
  open: boolean;
  target: AccountInfo | null;
  mode: 'copy' | 'switch';
  wbRunning: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [data, setData] = useState<SessionListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState('');
  const [hideCopied, setHideCopied] = useState(true);
  /** 默认勾选：由服务端直接结束 WorkBuddy 进程，用户不必自己动手 */
  const [stopApp, setStopApp] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SessionCopyReport | null>(null);

  const targetId = target?.id || '';

  /** 拉取列表；复制成功后也复用它刷新「已复制」标记 */
  const load = useCallback(async () => {
    if (!targetId) return;
    setLoading(true);
    setLoadError('');
    try {
      setData(await get<SessionListResponse>(`/api/sessions?accountId=${encodeURIComponent(targetId)}`, { timeoutMs: TIMEOUT.stats }));
    } catch (e: any) {
      setLoadError(e?.message || '读取会话列表失败');
    } finally {
      setLoading(false);
    }
  }, [targetId]);

  // 每次打开（或换目标账号）重新拉取：避免看到过期的「已复制」状态
  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setReport(null);
    setQuery('');
    setHideCopied(true);
    setStopApp(true);
    void load();
  }, [open, targetId, load]);

  const sessions = data?.sessions || [];
  const copiedCount = useMemo(() => sessions.filter((s) => s.copied).length, [sessions]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((s) => {
      if (hideCopied && s.copied) return false;
      if (!q) return true;
      return (
        s.title.toLowerCase().includes(q) ||
        s.workspace.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
      );
    });
  }, [sessions, query, hideCopied]);

  const visible = filtered.slice(0, SESSION_RENDER_LIMIT);
  const selectableIds = useMemo(() => filtered.filter((s) => s.hasBody).map((s) => s.id), [filtered]);
  const selectedBytes = useMemo(
    () => sessions.reduce((sum, s) => (selected.has(s.id) ? sum + s.bytes : sum), 0),
    [sessions, selected]
  );

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const run = async () => {
    const ids = [...selected];
    if (!ids.length || !target) return;
    setBusy(true);
    setReport(null);
    try {
      if (mode === 'switch') {
        const r = await post<SwitchAccountResult>(
          '/api/accounts/switch',
          {
            id: target.id,
            copySessionIds: ids,
            stopApp,
          },
          { timeoutMs: TIMEOUT.switch }
        );
        const rep = r?.sessionCopy || null;
        const failed = rep?.errors?.length || 0;
        const reopenFailed = r?.relaunch ? r.relaunch.launched === false : false;
        const tail = reopenFailed ? 'WorkBuddy 已退出但重新打开失败，请手动打开' : 'WorkBuddy 已自动重新打开';
        toast(
          failed || reopenFailed ? 'err' : 'ok',
          `已复制 ${rep?.copied.length || 0} 个会话并切换到「${target.name}」` +
            (failed ? `，其中 ${failed} 个复制失败（见下方明细）` : '') +
            `，${tail}`
        );
        onDone();
        // 失败明细留在弹窗里给用户看；全部成功就直接关掉——登录态已切换，
        // 此时再拉会话列表会因为「源账号 = 目标账号」而报错，所以不做刷新。
        if (failed) setReport(rep);
        else onClose();
        return;
      }
      const rep = await post<SessionCopyReport>(
        '/api/sessions/copy',
        {
          accountId: target.id,
          ids,
          stopApp,
        },
        { timeoutMs: TIMEOUT.switch }
      );
      setReport(rep);
      const reopenFailed = rep.relaunch ? rep.relaunch.launched === false : false;
      const procNote = rep.appStop?.wasRunning
        ? reopenFailed
          ? '；WorkBuddy 已退出，但重新打开失败，请手动打开'
          : '；WorkBuddy 已自动重新打开'
        : '';
      if (rep.ok && !reopenFailed) toast('ok', `已复制 ${rep.copied.length} 个会话到「${target.name}」${procNote}`);
      else
        toast(
          'err',
          `复制完成：成功 ${rep.copied.length} 个，失败 ${rep.errors.length} 个（详见列表下方）${procNote}`
        );
      setSelected(new Set());
      await load();
      onDone();
    } catch (e: any) {
      toast('err', e?.message || '复制失败');
    } finally {
      setBusy(false);
    }
  };

  /** 只有在「运行中且没有授权自动退出」时才真的挡住操作 */
  const blocked = wbRunning && !stopApp;

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      width="max-w-3xl"
      title={mode === 'switch' ? `复制会话并切换到「${target?.name}」` : `把会话复制给「${target?.name}」`}
      subtitle={
        data
          ? `来源：当前登录账号 ${data.sourceUid.slice(0, 8)}… → 目标：${target?.name}（${target?.variantLabel}）`
          : '复制会给每个会话生成新的会话 id，源账号的数据完全不受影响'
      }
      footer={
        <>
          <span className="mr-auto text-xs text-zinc-500">
            已选 <b className="tabular-nums text-zinc-800">{selected.size}</b> 个 · 约{' '}
            <b className="tabular-nums text-zinc-800">{fmtBytes(selectedBytes)}</b>
          </span>
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!selected.size || blocked || loading || !data?.supported}
            onClick={run}
            title={
              blocked
                ? 'WorkBuddy 正在运行：请勾选「自动退出 WorkBuddy」或自己先退出'
                : `${selected.size} 个会话${wbRunning && stopApp ? '（会先自动退出 WorkBuddy）' : ''}`
            }
          >
            <IconCopy className="w-3.5 h-3.5" />
            {mode === 'switch' ? '复制并切换' : '开始复制'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {/* 前置条件与副作用：这两条是用户最容易踩的坑，必须写在最上面 */}
        <div
          className={`flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed ${
            blocked ? 'border-red-200 bg-red-50 text-red-800' : 'border-amber-200 bg-amber-50 text-amber-800'
          }`}
        >
          <IconWarning className={`mt-px w-3.5 h-3.5 shrink-0 ${blocked ? 'text-red-500' : 'text-amber-500'}`} />
          <span>
            {blocked ? (
              <>
                <b>WorkBuddy 正在运行，无法复制。</b>运行中的实例看不到写入，继续对话会让副本与源会话分叉。
                勾选下面的「自动退出 WorkBuddy」，或自己先完全退出后重试。
              </>
            ) : (
              <>
                复制前的写入要求 WorkBuddy 不在运行
                {wbRunning && stopApp ? '——下面已勾选自动退出，由本工具结束后台进程并确认退出' : ''}。
                复制出的会话是独立副本，WorkBuddy 下次启动时会把它们<b>上传到云端</b>，会占用云端空间与流量。
              </>
            )}
          </span>
        </div>

        {wbRunning && <StopAppRow checked={stopApp} onChange={setStopApp} />}

        {loading && (
          <div className="flex items-center gap-2 py-10 text-sm text-zinc-400">
            <Spinner className="w-4 h-4" />
            正在读取会话列表（本机数千个会话，需要索引一次正文目录）…
          </div>
        )}

        {!loading && loadError && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-700">
            <IconWarning className="mt-px w-3.5 h-3.5 shrink-0 text-red-500" />
            <span>{loadError}</span>
          </div>
        )}

        {!loading && !loadError && data && !data.supported && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800">
            该档位暂不支持会话复制：数据根下缺少 <span className="font-mono">projects/</span> 目录或
            <span className="font-mono"> sessions</span> 表。
          </div>
        )}

        {!loading && !loadError && data?.supported && (
          <>
            <Toolbar>
              <div className="relative min-w-[180px] flex-1">
                <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="搜索标题 / 工作区 / 会话 id"
                  className="h-8 w-full rounded-xl border border-zinc-200 bg-white pl-8 pr-3 text-xs text-zinc-700 outline-none transition-colors focus:border-indigo-400"
                />
              </div>
              <Button size="sm" onClick={() => setSelected(new Set(selectableIds))} disabled={!selectableIds.length}>
                全选当前
              </Button>
              <Button size="sm" onClick={() => setSelected(new Set())} disabled={!selected.size}>
                清空
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setHideCopied((v) => !v)}>
                {hideCopied ? `显示已复制的（${copiedCount}）` : '隐藏已复制的'}
              </Button>
            </Toolbar>

            <div className="text-[11px] text-zinc-400 leading-relaxed">
              共 {data.stats.total} 个会话（有正文 {data.stats.withBody} 个，合计 {fmtBytes(data.stats.bytes)}），
              当前筛选出 <b className="tabular-nums text-zinc-600">{filtered.length}</b> 个
              {filtered.length > visible.length ? `，只渲染前 ${SESSION_RENDER_LIMIT} 条，请用搜索缩小范围` : ''}
            </div>

            <div className="max-h-[38vh] space-y-1.5 overflow-y-auto pr-0.5">
              {visible.length === 0 && (
                <div className="py-10 text-center text-xs text-zinc-400">
                  {sessions.length === 0 ? '当前账号没有可复制的会话' : '没有匹配的会话'}
                </div>
              )}
              {visible.map((s) => {
                // 「已复制过」的会话依然可以勾选：目标账号里那份可能已经落后了（本账号又聊了新内容），
                // 再选一次不是重复复制，而是把新增内容与改名同步过去（后端按血缘原位合并）。
                const disabled = !s.hasBody;
                const checked = selected.has(s.id);
                return (
                  <label
                    key={s.id}
                    title={s.cwd || '(无工作区)'}
                    className={`flex items-center gap-3 rounded-xl border px-3 py-2 transition-colors ${
                      disabled
                        ? 'border-zinc-100 bg-zinc-50/60'
                        : checked
                          ? 'cursor-pointer border-indigo-300 bg-indigo-50/50'
                          : 'cursor-pointer border-zinc-200 hover:border-indigo-200 hover:bg-indigo-50/30'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-3.5 w-3.5 shrink-0 accent-indigo-600"
                      checked={checked}
                      disabled={disabled}
                      onChange={(e) => toggle(s.id, e.target.checked)}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className={`truncate text-sm ${disabled ? 'text-zinc-400' : 'font-medium text-zinc-800'}`}>
                          {s.title}
                        </span>
                        {s.isPlayground && <Badge color="violet">任务</Badge>}
                        {s.copied && (
                          <span
                            title={
                              s.copiedScope === 'family'
                                ? '这段对话已经通过其它账号同步到目标账号了（不是这一对账号直接复制的）；勾选也不会产生重复会话，只会把新增内容与改名同步过去'
                                : '目标账号里已经有同一份会话；再勾选复制不会产生重复会话，只会把新增内容与改名同步过去'
                            }
                          >
                            <Badge color="green">已复制</Badge>
                          </span>
                        )}
                        {!s.hasBody && <Badge color="amber">无正文</Badge>}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-x-2.5 text-[11px] text-zinc-400">
                        <span className="truncate">{s.workspace}</span>
                        <span className="shrink-0 tabular-nums">{fmtBytes(s.bytes)}</span>
                        <span className="shrink-0 tabular-nums">{s.updatedAt ? fmtDateTime(s.updatedAt) : '—'}</span>
                      </div>
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}

        {/* 复制结果：成功 / 跳过 / 失败逐条列出，避免"点了没反应" */}
        {report && (
          <div className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50/70 px-3.5 py-3 text-xs">
            <div className="font-medium text-zinc-700">
              复制结果：成功 <b className="tabular-nums text-emerald-600">{report.copied.length}</b> 个 ·
              跳过 <b className="tabular-nums text-zinc-500">{report.skipped.length}</b> 个 ·
              失败 <b className="tabular-nums text-red-600">{report.errors.length}</b> 个 ·
              共 {fmtBytes(report.totalBytes)} · 用时 {(report.elapsedMs / 1000).toFixed(1)}s
            </div>
            {report.backupPath && (
              <div className="truncate font-mono text-[11px] text-zinc-400" title={report.backupPath}>
                复制前已备份会话库：{report.backupPath}
              </div>
            )}
            {!!report.titleSynced?.length && (
              <div className="text-[11px] text-emerald-700">
                改名同步：<b className="tabular-nums">{report.titleSynced.length}</b>{' '}
                个会话的新名字已写到目标账号里同一份会话上（客户端会给导入的副本重新生成自动标题，会话带上固定名后不再被覆盖）。
              </div>
            )}
            {!!report.contentSynced?.length && (
              <div className="text-[11px] text-emerald-700">
                内容同步：<b className="tabular-nums">{report.contentSynced.length}</b>{' '}
                个会话新聊的内容（共{' '}
                <b className="tabular-nums">{report.contentSynced.reduce((s, c) => s + c.appendedLines, 0)}</b> 行）已
                合并进目标账号里同一份会话，不会再重复复制出新会话。
              </div>
            )}
            {report.errors.length > 0 && (
              <ul className="max-h-32 space-y-0.5 overflow-y-auto text-[11px] text-red-600">
                {report.errors.slice(0, 50).map((e) => (
                  <li key={e.id} className="truncate" title={`${e.id}：${e.error}`}>
                    {e.id.slice(0, 8)}… — {e.error}
                  </li>
                ))}
              </ul>
            )}
            {report.skipped.length > 0 && report.copied.length === 0 && report.errors.length === 0 && (
              <div className="text-[11px] text-zinc-500">
                选中的会话在目标账号里已经有同一份了，本次不再重复复制，只把新增的内容与改名同步过去。
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default function AccountsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<AccountsResponse | null>(null);
  const [balances, setBalances] = useState<AccountBalancesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [editing, setEditing] = useState<AccountInfo | null>(null);
  const [pkgTarget, setPkgTarget] = useState<AccountInfo | null>(null);
  /** 扫码添加账号弹窗（OAuth 设备码流程） */
  const [scanOpen, setScanOpen] = useState(false);
  /** 档位筛选：与 workbuddy-switch 一致，两套登录态分开管理 */
  const [variant, setVariant] = useState<'cn' | 'ai'>('cn');
  /** WorkBuddy 进程是否在运行：运行时切换会被它改写回去，需要提前提醒 */
  const [wbRunning, setWbRunning] = useState(false);
  /** 「退出 WorkBuddy」按钮的进行态 */
  const [stopping, setStopping] = useState(false);
  /** 会话复制弹窗的目标账号；`sessionMode` 决定按钮是「开始复制」还是「复制并切换」 */
  const [sessionTarget, setSessionTarget] = useState<AccountInfo | null>(null);
  const [sessionMode, setSessionMode] = useState<'copy' | 'switch'>('copy');
  /** 切换确认框里两个勾选的值（弹窗消息是快照，只能靠 ref 传出来） */
  const copyOnSwitchRef = useRef(false);
  const stopAppRef = useRef(true);

  const load = useCallback(async () => {
    try {
      setData(await get<AccountsResponse>('/api/accounts'));
    } catch (e: any) {
      toast('err', e?.message || '读取账号失败');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  const loadBalances = useCallback(async (refresh = false) => {
    setBalanceLoading(true);
    try {
      setBalances(await get<AccountBalancesResponse>(`/api/accounts/credits${refresh ? '?refresh=1' : ''}`, { timeoutMs: TIMEOUT.quota }));
    } catch {
      /* 余额查询失败不阻塞账号列表，卡片上会显示"余额暂不可用" */
    } finally {
      setBalanceLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    void loadBalances();
    const loadWb = () => get<LoadedInfo>('/api/workbuddy/status').then((i) => setWbRunning(!!i?.running)).catch(() => {});
    loadWb();
    const t = setInterval(loadWb, 30_000);
    return () => clearInterval(t);
  }, [load, loadBalances]);

  // 首次拿到数据后，档位默认跟着当前登录态走
  useEffect(() => {
    const v = data?.current?.variant;
    if (v === 'cn' || v === 'ai') setVariant(v);
  }, [data?.current?.variant]);

  /**
   * 续采：上次扫码没在弹窗里等到结果（关了弹窗 / 刷新了页面 / 去手机上操作太慢），
   * 这里继续读服务端状态，成功了就提示并刷新列表——否则会出现"手机上明明成功了，
   * 页面里却没有账号"这种最让人困惑的情况。
   */
  useEffect(() => {
    const pending = readPendingOAuth();
    if (!pending) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const r = await post<OAuthPollResult>('/api/oauth/status', { loginId: pending.loginId });
        if (stopped) return;
        if (!r.done) return;
        clearPendingOAuth();
        clearInterval(timer);
        if (r.result) {
          toast('ok', `已扫码添加「${r.result.name}」`);
          load();
          void loadBalances(true);
        } else if (r.error) {
          toast('err', `扫码登录未完成：${r.error}`);
        }
      } catch {
        /* 瞬时错误忽略，下个周期再试 */
      }
    }, 3000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 切换账号的收尾：写登录态文件（可先自动退出 WorkBuddy、再复制会话） */
  const switchNow = async (account: AccountInfo, copySessionIds: string[] = [], stopApp = true) => {
    setBusyId(account.id);
    try {
      const r = await post<SwitchAccountResult>(
        '/api/accounts/switch',
        {
          id: account.id,
          copySessionIds: copySessionIds.length ? copySessionIds : undefined,
          stopApp,
        },
        { timeoutMs: TIMEOUT.switch }
      );
      const copied = r?.sessionCopy?.copied.length || 0;
      const wasStopped = !!r?.appStop?.wasRunning;
      const reopenFailed = r?.relaunch ? r.relaunch.launched === false : false;
      const tail = reopenFailed
        ? 'WorkBuddy 已退出但重新打开失败，请手动打开'
        : wasStopped
          ? 'WorkBuddy 已自动重新打开'
          : '请重新打开 WorkBuddy';
      toast(
        reopenFailed ? 'err' : 'ok',
        `已切换到「${account.name}」${copied ? `，并复制了 ${copied} 个会话` : ''}，${tail}`
      );
      if (r?.backupPath) console.info('登录态备份：', r.backupPath);
      setSessionTarget(null);
      load();
    } catch (e: any) {
      toast('err', e?.message || '切换失败');
    } finally {
      setBusyId(null);
    }
  };

  const doSwitch = async (account: AccountInfo) => {
    copyOnSwitchRef.current = false;
    stopAppRef.current = true;
    const ok = await confirm({
      title: '切换账号',
      message: (
        <>
          将把账号「<b>{account.name}</b>」写入 WorkBuddy 登录态文件。
          <div className="mt-2.5 text-xs text-zinc-500 leading-relaxed">
            切换前会自动备份当前登录态（~/.wb-switch/backups/）。
          </div>
          <StopAppToggleRef flagRef={stopAppRef} />
          <CopyOnSwitchToggle flagRef={copyOnSwitchRef} />
          <div className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-zinc-400">
            <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-400" />
            <span>
              取消勾选「自动退出」就必须自己先完全退出 WorkBuddy；否则它会把登录态改写回去，切换不生效。
            </span>
          </div>
        </>
      ),
      confirmText: '开始切换',
    });
    if (!ok) return;
    // 勾了「同时复制会话」就先打开选择列表，由那次操作一并完成退出、复制与切换
    if (copyOnSwitchRef.current) {
      setSessionMode('switch');
      setSessionTarget(account);
      return;
    }
    await switchNow(account, [], stopAppRef.current);
  };

  /**
   * 手动刷新单个账号的凭据。
   *
   * 走 `force=1`：用户是**明确点在这个账号上**的，不必再拿"临期"替他判断。
   * 这与设置页那个批量「检查并刷新」刻意不同——批量动作要保持保守，避免无谓的凭据轮换。
   */
  const doRefreshToken = async (account: AccountInfo) => {
    setBusyId(account.id);
    try {
      const r = await post<AccountRefreshRunResponse>('/api/accounts/refresh', {
        accountId: account.id,
        force: true,
      });
      const row = r.results[0];
      if (row?.ok && row.action === 'refreshed') {
        toast('ok', `「${account.name}」凭据已刷新，有效期已顺延`);
      } else if (row?.ok) {
        // 跳过类结果优先用服务端给出的人话（如当前登录账号不参与自动刷新、失败冷却），
        // 没有 message 时才退回原因码，避免界面上出现 current / failed-cooldown 这种裸标识
        toast('info', row?.message || `「${account.name}」未做刷新（${row.reason}）`);
      } else {
        toast('err', row?.message || '刷新失败');
      }
      await load();
    } catch (e: any) {
      toast('err', e?.message || '刷新失败');
    } finally {
      setBusyId(null);
    }
  };

/** 一键结束后台全部 WorkBuddy 进程（与切换/复制里的自动退出同一条服务端逻辑） */
  const stopNow = async () => {
    const ok = await confirm({
      title: '退出 WorkBuddy',
      message: (
        <>
          将结束后台<b>全部</b> WorkBuddy 相关进程，并确认它们真的退出。
          <div className="mt-2.5 text-xs leading-relaxed text-zinc-500">
            正在进行的对话会<b className="text-red-600">立即中断</b>；关闭前未落盘的内容可能丢失。
            切换账号时勾选「自动退出 WorkBuddy」会自动完成这一步，并在切换后重新打开它。
          </div>
        </>
      ),
      confirmText: '退出',
      danger: true,
    });
    if (!ok) return;
    setStopping(true);
    try {
      const r = await post<AppStopResult>('/api/workbuddy/stop');
      if (r?.wasRunning) {
        toast('ok', `已退出 WorkBuddy（结束 ${r.killed.length} 个进程${r.forced ? '，强制结束' : ''}）`);
      } else {
        toast('ok', 'WorkBuddy 本来就没有在运行');
      }
      setWbRunning(false);
    } catch (e: any) {
      toast('err', e?.message || '退出 WorkBuddy 失败');
    } finally {
      setStopping(false);
    }
  };

  const doDelete = async (account: AccountInfo) => {
    const ok = await confirm({
      title: '删除账号',
      message: (
        <>
          确定从账号库删除「<b>{account.name}</b>」？该操作只删除本工具保存的记录，
          <b>不会影响 WorkBuddy 当前的登录态</b>，也无法撤销。
        </>
      ),
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBusyId(account.id);
    try {
      await del(`/api/accounts/${account.id}`);
      toast('ok', '已删除');
      load();
    } catch (e: any) {
      toast('err', e?.message || '删除失败');
    } finally {
      setBusyId(null);
    }
  };

  const doImport = async (v: VariantInfo) => {
    setImporting(v.id);
    try {
      const acc = await post<AccountInfo>('/api/accounts/import', { variant: v.id });
      toast('ok', `已导入「${acc.name}」`);
      load();
      void loadBalances(true);
    } catch (e: any) {
      toast('err', e?.message || '导入失败');
    } finally {
      setImporting(null);
    }
  };

  const balanceOf = useCallback(
    (id: string): CreditBalance | null => balances?.accounts?.find((r) => r.accountId === id)?.balance ?? null,
    [balances]
  );

  /** 官方已拒绝凭据的账号 id 集合（余额查询结果是目前最可靠的验活信号） */
  const authInvalidIds = useMemo(
    () => new Set((balances?.accounts || []).filter((r) => r.authInvalid).map((r) => r.accountId)),
    [balances]
  );

  const visibleAccounts = useMemo(
    () => (data?.accounts || []).filter((a) => a.variant === variant),
    [data, variant]
  );
  const activeVariant = (data?.variants || []).find((v) => v.id === variant);

  const stats = useMemo(() => {
    const list = data?.accounts || [];
    return {
      total: list.length,
      // 可用 = 有明文凭据、本地未过期、且服务端**没有**拒绝它
      usable: list.filter((a) => a.hasPlainToken && !a.expired && !authInvalidIds.has(a.id)).length,
      needsAuth: list.filter((a) => !a.hasPlainToken || a.expired || authInvalidIds.has(a.id)).length,
    };
  }, [data, authInvalidIds]);

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    );
  }

  const current = data?.current;
  /**
   * 两档位各自的登录态。老版本服务端没有 currents，退回单档位视图，
   * 这样界面不会因为服务端没升级而空白。
   */
  const currents = data?.currents ?? {
    cn: current,
    ai: { ...current, exists: false, account: null, uid: null, authFilePath: null },
    active: current?.variant ?? null,
  };
  const accounts = data?.accounts || [];
  /** 该账号是否是它所属档位的当前登录账号 */
  const isCurrentAccount = (a: AccountInfo) =>
    currents.cn?.account?.id === a.id || currents.ai?.account?.id === a.id;

  return (
    <div className="space-y-5">
      {/* 页头：档位切换 + 运行状态（大标题由顶栏负责，这里不重复） */}
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          value={variant}
          onChange={setVariant}
          options={[
            { value: 'cn', label: '国内版' },
            { value: 'ai', label: '国际版' },
          ]}
        />
        <span className="text-xs text-zinc-400 leading-relaxed">
          两套登录态互相独立，账号库与 workbuddy-switch 共用同一份文件
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {wbRunning ? (
            <Badge color="green" dot>
              <IconPower className="w-3 h-3" />
              WorkBuddy 运行中
            </Badge>
          ) : (
            <Badge color="gray" dot>
              <IconPower className="w-3 h-3" />
              WorkBuddy 未运行
            </Badge>
          )}
        </div>
      </div>

      {/* 添加与迁移账号 */}
      <div className="relative overflow-hidden rounded-2xl border border-zinc-200 bg-zinc-50/80 px-5 py-5 shadow-[0_6px_20px_rgba(15,23,42,.025)]">
        <div className="pointer-events-none absolute -right-12 -top-20 size-44 rounded-full border-[28px] border-zinc-400/[0.06]" />
        <div className="relative flex flex-wrap items-center gap-x-5 gap-y-4">
          <div className="min-w-[200px] flex-1">
            <h2 className="text-sm font-semibold text-zinc-900">添加与迁移账号</h2>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              扫码授权后自动采集账号入库；也可读取本机 WorkBuddy 登录态文件迁移已有账号，已存在的只更新凭据、保留本地备注
            </p>
            {activeVariant && (
              <p className="mt-1.5 truncate font-mono text-[11px] text-zinc-400" title={activeVariant.authFilePath}>
                {activeVariant.authFilePath}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              className="h-9 px-3.5"
              onClick={() => setScanOpen(true)}
              title={`打开官方${variant === 'ai' ? '国际版' : '国内版'}授权页，扫码/登录后自动采集账号入库`}
            >
              <IconQrCode className="w-3.5 h-3.5" />
              扫码添加账号
            </Button>
            <span className="hidden h-6 w-px bg-zinc-200 sm:block" />
            {(data?.variants || []).map((v) => (
              <Button
                key={v.id}
                variant="subtle"
                className="h-9 px-3.5"
                loading={importing === v.id}
                onClick={() => doImport(v)}
                title={`从 ${v.authFilePath} 导入当前登录的账号`}
              >
                <IconArrowDown className="w-3.5 h-3.5" />
                导入{v.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {/* 运行中提醒：WorkBuddy 会把登录态改写回去，这是切换不生效的主因 */}
      {wbRunning && (
        <div className="flex flex-wrap items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800 leading-relaxed">
          <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
          <span className="min-w-[220px] flex-1">
            <b>WorkBuddy 正在运行。</b>此时切换账号会被它改写回原账号。切换 / 复制时勾选
            「自动退出 WorkBuddy」即可由本工具直接结束后台进程，不需要你手动关闭。
          </span>
          <Button size="sm" variant="danger" className="shrink-0" loading={stopping} onClick={stopNow}>
            <IconPower className="w-3.5 h-3.5" />
            退出 WorkBuddy
          </Button>
        </div>
      )}

      {/* 当前登录态 */}
      <Card className="p-4">
        <SectionHeader
          icon={<IconUsers />}
          title="当前登录态"
          desc="切换账号会重写 WorkBuddy 的登录态文件，操作前自动备份，失败自动回滚"
          actions={
            <Button
              size="sm"
              onClick={() => {
                load();
                void loadBalances(true);
              }}
            >
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
          }
        />
        <div className="mt-4 space-y-4">
          {([
            ['cn', '国内版'],
            ['ai', '国际版'],
          ] as const).map(([vid, label]) => {
            const c = currents[vid];
            const loggedIn = !!c?.exists && !!c.account;
            return (
              <div key={vid} className="flex flex-wrap items-center gap-3">
                {loggedIn ? (
                  <>
                    <Avatar name={c.account!.name} seed={c.account!.uid || c.account!.id} />
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-zinc-900">{c.account!.name}</span>
                        <Badge color="green" dot>
                          已登录
                        </Badge>
                        <Badge color="gray">{label}</Badge>
                      </div>
                      <div className="mt-1 text-xs text-zinc-400 font-mono truncate max-w-[520px]">{c.authFilePath}</div>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-full bg-zinc-50 border border-zinc-200 text-zinc-400 flex items-center justify-center shrink-0">
                      <IconUser className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-zinc-500">{label}：未登录</div>
                      <div className="text-xs text-zinc-400 mt-0.5">
                        {c?.uid
                          ? `登录态中的账号（${c.uid.slice(0, 8)}…）尚未导入到账号库`
                          : c?.authFilePath
                            ? '该档位的登录态文件不存在'
                            : 'WorkBuddy 登录态文件不存在或已损坏'}
                      </div>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
        {current?.warning && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2 text-xs text-amber-800">
            <IconWarning className="w-3.5 h-3.5 shrink-0 mt-px text-amber-500" />
            {current.warning}
          </div>
        )}
      </Card>

      {/* 账号列表 */}
      <section className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight text-zinc-900">
              {variant === 'ai' ? '国际版' : '国内版'}账号
            </h2>
            <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-zinc-200 bg-zinc-100 px-1.5 text-[11px] font-medium tabular-nums text-zinc-500">
              {visibleAccounts.length}
            </span>
            {stats.needsAuth > 0 && (
              <span className="text-xs text-zinc-400">
                全部 {stats.total} 个中 {stats.needsAuth} 个需要重新登录
              </span>
            )}
          </div>
          <span className="text-xs text-zinc-400">
            {balanceLoading ? '余额查询中…' : balances?.collectedAt ? `余额更新于 ${fmtClock(balances.collectedAt)}` : ''}
          </span>
        </div>

        {visibleAccounts.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-300 px-4 py-16 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-zinc-100 text-zinc-400">
              <IconUser className="w-5 h-5" />
            </div>
            <p className="text-sm text-zinc-500">暂无{variant === 'ai' ? '国际版' : '国内版'}账号。</p>
            <p className="mt-2 text-xs leading-5 text-zinc-400">
              先用 WorkBuddy 登录一个账号，再点上方「导入{variant === 'ai' ? '国际版' : '国内版'}」加入账号库，之后就能在这里一键切换。
            </p>
          </div>
        ) : (
          <div className="grid min-w-0 gap-5 grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))]">
            {visibleAccounts.map((a) => (
              <AccountCard
                key={a.id}
                account={a}
                isCurrent={isCurrentAccount(a)}
                busy={busyId === a.id}
                balance={balanceOf(a.id)}
                balanceLoading={balanceLoading && !balanceOf(a.id)}
                authInvalid={authInvalidIds.has(a.id)}
                onSwitch={() => doSwitch(a)}
                onSyncSessions={() => {
                  setSessionMode('copy');
                  setSessionTarget(a);
                }}
                onRename={() => setEditing(a)}
                onRefreshToken={() => doRefreshToken(a)}
                onDelete={() => doDelete(a)}
                onShowPackages={() => setPkgTarget(a)}
              />
            ))}
          </div>
        )}
      </section>

      {/* 数据位置脚注：与顶栏副标题呼应，只补充具体路径，不重复导入入口 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 text-[11px] text-zinc-400">
        <span className="inline-flex items-center gap-1.5">
          <IconInfo className="w-3.5 h-3.5 shrink-0" />
          账号库 <span className="font-mono">~/.wb-switch/accounts.json</span> 与 workbuddy-switch 共用，两个工具可同时安装、随时切换
        </span>
        {(data?.variants || []).map((v) => (
          <span key={v.id} className="font-mono truncate" title={v.authFilePath}>
            {v.label}：{v.authFilePath}
          </span>
        ))}
      </div>

      <RenameDialog account={editing} onClose={() => setEditing(null)} onSaved={load} />
      <SessionCopyDialog
        open={!!sessionTarget}
        target={sessionTarget}
        mode={sessionMode}
        wbRunning={wbRunning}
        onClose={() => setSessionTarget(null)}
        onDone={load}
      />
      <PackagesDialog account={pkgTarget} balance={pkgTarget ? balanceOf(pkgTarget.id) : null} onClose={() => setPkgTarget(null)} />
      <ScanAddDialog
        open={scanOpen}
        variant={variant}
        variantLabel={variant === 'ai' ? '国际版' : '国内版'}
        onClose={() => setScanOpen(false)}
        onAdded={(acc) => {
          toast('ok', `已扫码添加「${acc.name}」`);
          load();
          void loadBalances(true);
        }}
      />
    </div>
  );
}
