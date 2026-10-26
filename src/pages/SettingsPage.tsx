import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  IconChevronDown,
  IconClock,
  IconCopy,
  IconDatabase,
  IconDownload,
  IconLayers,
  IconPower,
  IconRefresh,
  IconShield,
  IconSliders,
  IconTrash,
  IconWarning,
  PageSection,
  Spinner,
  useConfirm,
  useToast,
} from '../components/ui';
import { del, get, post, put } from '../lib/api';
import { emitUpdateChecked } from '../lib/appUpdate';
import { emitSettingsChanged } from '../lib/appSettings';
import type {
  AccountRefreshResponse,
  AccountRefreshRunResponse,
  AppUpdateInfo,
  BackupEntry,
  BackupsResponse,
  CheckinAllResult,
  CheckinState,
  CheckinStatusResponse,
  DetectResult,
  LanSyncStatus,
  LoadedInfo,
  PermissionCheck,
  PermissionResponse,
  PlatformInfo,
  SettingsInfo,
} from '../lib/types';
import { fmtDate, fmtDateTime, fmtRelative } from '../lib/format';
import { NOTIFICATION_MAX, clearNotifications, readNotifications, type NotificationItem } from '../lib/notify';
import { ERROR_MAX, clearErrors, readErrors, type ErrorItem } from '../lib/errlog';

function MarkerBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge color={ok ? 'green' : 'gray'}>
      {ok ? '✓' : '—'} {label}
    </Badge>
  );
}

/** 设置行：左标签 + 说明，右操作；与参考项目一致的信息层级 */
function Row({
  label,
  desc,
  children,
  className = '',
}: {
  label: React.ReactNode;
  desc?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 ${className}`}>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-zinc-700">{label}</div>
        {desc && <div className="mt-0.5 text-xs text-zinc-400 leading-relaxed">{desc}</div>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 剩余小时数 → 人话；null（账号里没有该有效期字段）与"已过期"必须区分 */
function fmtHours(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return '未知';
  if (h <= 0) return '已过期';
  if (h < 48) return `${h.toFixed(1)} 小时`;
  return `${(h / 24).toFixed(1)} 天`;
}

/** 凭据刷新的判定原因 → 中文（与服务端 tokenRefresh.mjs 的 reason 一一对应） */
const REFRESH_REASON_TEXT: Record<string, string> = {
  ok: '有效期充足',
  'access-expiring': 'access 即将过期',
  'refresh-expiring': 'refresh 即将过期',
  dead: 'refresh 已过期，需重新登录',
  'unknown-expiry': '未记录有效期，暂不处理',
  'no-refresh-token': '无 refresh_token，需重新扫码',
  manual: '手动刷新',
  current: '当前登录账号（由 WorkBuddy 自行续期，不自动刷新）',
  'failed-cooldown': '上次刷新失败，已暂停自动重试',
  'verified-valid': '服务端确认有效',
  'verify-failed': '验活请求失败（网络）',
  'invalid-no-refresh': '服务端已拒绝，且无 refresh_token 可续期',
  'current-invalid': '当前登录账号已被服务端拒绝',
};

export default function SettingsPage() {
  const toast = useToast();
  const confirm = useConfirm();

  /* ---------------- 通用设置 ---------------- */
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [wbDir, setWbDir] = useState('');
  const [savingDir, setSavingDir] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [proxyInput, setProxyInput] = useState('');
  const [savingProxy, setSavingProxy] = useState(false);

  /* ---------------- WorkBuddy 运行状态 ---------------- */
  const [status, setStatus] = useState<LoadedInfo | null>(null);
  const [restarting, setRestarting] = useState(false);

  /* ---------------- 签到 ---------------- */
  const [checkin, setCheckin] = useState<CheckinStatusResponse | null>(null);
  const [checkinLoading, setCheckinLoading] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);

  /* ---------------- 凭据自动刷新 ---------------- */
  const [refreshInfo, setRefreshInfo] = useState<AccountRefreshResponse | null>(null);
  const [refreshingTokens, setRefreshingTokens] = useState(false);

  /* ---------------- 免费模型平台可见性 ---------------- */
  /** 受平台自身限制、默认收起的平台（仅用于在设置里说明"开了会放出哪几个"） */
  const [restrictedPlatforms, setRestrictedPlatforms] = useState<PlatformInfo[]>([]);

  /* ---------------- 版本自检 ---------------- */
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  /* ---------------- 权限自检 ---------------- */
  const [perm, setPerm] = useState<PermissionResponse | null>(null);
  const [permLoading, setPermLoading] = useState(false);

  /* ---------------- 备份 ---------------- */
  const [backups, setBackups] = useState<BackupsResponse | null>(null);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);

  /* ---------------- 本地日志（前端） ---------------- */
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [errors, setErrors] = useState<ErrorItem[]>([]);

  const loadSettings = useCallback(() => {
    get<SettingsInfo>('/api/settings')
      .then((r) => {
        setSettings(r);
        setWbDir(r.workbuddyDir || '');
        setProxyInput(r.proxyUrl || '');
      })
      .catch((e) => toast('err', e.message));
    // 平台限制清单：与开关无关，始终取真实原因（restriction），用来告诉用户「打开后会放出哪几个」
    get<{ platforms: PlatformInfo[] }>('/api/platforms')
      .then((r) => setRestrictedPlatforms((r.platforms || []).filter((p) => !!p.restriction)))
      .catch(() => {
        /* 读不到就只是少一句说明，不影响开关本身 */
      });
  }, [toast]);

  const loadStatus = useCallback(() => {
    get<LoadedInfo>('/api/workbuddy/status')
      .then(setStatus)
      .catch(() => {});
  }, []);

  const loadCheckin = useCallback(
    async (silent = false) => {
      if (!silent) setCheckinLoading(true);
      try {
        setCheckin(await get<CheckinStatusResponse>('/api/workbuddy/checkin/status'));
      } catch (e: any) {
        if (!silent) toast('err', e?.message || '签到状态查询失败');
      } finally {
        setCheckinLoading(false);
      }
    },
    [toast]
  );

  const loadRefreshInfo = useCallback(async () => {
    try {
      setRefreshInfo(await get<AccountRefreshResponse>('/api/accounts/refresh'));
    } catch {
      /* 凭据状态查询失败不打扰用户，列表留空即可 */
    }
  }, []);

  const loadUpdateInfo = useCallback(
    async (force = false) => {
      setCheckingUpdate(true);
      try {
        const info = force
          ? await post<AppUpdateInfo>('/api/app/update/check')
          : await get<AppUpdateInfo>('/api/app/update');
        setUpdateInfo(info);
        // 常驻的左下角版本区是另一个组件：把结果广播过去，否则「这里已显示发现新版本、
        // 左下角却没按钮」（用户 2026-10-18 反馈）
        emitUpdateChecked(info);
      } catch (e: any) {
        if (force) toast('err', e?.message || '检查更新失败');
      } finally {
        setCheckingUpdate(false);
      }
    },
    [toast]
  );

  /**
   * 手动「检查并刷新」：不带 force —— 只刷新已经临期的账号。
   * 不做「点一下全部重刷」，是因为刷新可能轮换 refresh_token，无谓的刷新反而会与
   * WorkBuddy 自己持有的那一份互相踩到（详见 server/workbuddy/tokenRefresh.mjs 的说明）。
   */
  const runTokenRefresh = async () => {
    setRefreshingTokens(true);
    try {
      const r = await post<AccountRefreshRunResponse>('/api/accounts/refresh', {});
      const { summary } = r;
      const failed = r.results.find((x) => x.action === 'failed');
      const dead = r.results.filter((x) => x.action === 'dead');
      if (summary.refreshed) {
        toast('ok', `已刷新 ${summary.refreshed} 个临期账号${summary.failed ? `，${summary.failed} 个失败` : ''}`);
      } else if (summary.failed) {
        toast('err', `刷新失败：${failed?.message || '未知原因'}`);
      } else if (dead.length) {
        toast('info', `${dead.length} 个账号需重新登录：${dead.map((d) => d.accountName).join('、')}`);
      } else {
        toast('ok', '所有账号的有效期都还很充足，未做任何刷新');
      }
      await loadRefreshInfo();
    } catch (e: any) {
      toast('err', e?.message || '刷新失败');
    } finally {
      setRefreshingTokens(false);
    }
  };

  const loadPerm = useCallback(
    async (silent = false) => {
      if (!silent) setPermLoading(true);
      try {
        setPerm(await get<PermissionResponse>('/api/workbuddy/permissions'));
      } catch (e: any) {
        if (!silent) toast('err', e?.message || '权限自检失败');
      } finally {
        setPermLoading(false);
      }
    },
    [toast]
  );

  const loadBackups = useCallback(async () => {
    try {
      setBackups(await get<BackupsResponse>('/api/workbuddy/backups'));
    } catch {
      /* 备份目录不存在时接口返回空列表，这里静默 */
    }
  }, []);

  const loadLocalLogs = useCallback(() => {
    setNotifications(readNotifications());
    setErrors(readErrors());
  }, []);

  useEffect(() => {
    loadSettings();
    loadStatus();
    loadBackups();
    loadLocalLogs();
    void loadPerm(true);
    void loadCheckin(true);
    void loadRefreshInfo();
    void loadUpdateInfo(false);
  }, [loadSettings, loadStatus, loadBackups, loadLocalLogs, loadPerm, loadCheckin, loadRefreshInfo, loadUpdateInfo]);

  /** 重新检测数据目录与运行状态 */
  const redetect = useCallback(
    async (silent = false) => {
      setDetecting(true);
      try {
        const r = await get<DetectResult>('/api/workbuddy/detect');
        setSettings((prev) => (prev ? { ...prev, detected: r.detected } : prev));
        loadStatus();
        if (!silent) {
          if (r.detected.valid) toast('ok', `已检测到 WorkBuddy 数据目录：${r.detected.dir}`);
          else toast('err', '未检测到 WorkBuddy 数据目录，请确认已安装并运行过 WorkBuddy，或手动指定');
          if (!r.running && r.detectError) toast('err', `无法确认 WorkBuddy 运行状态：${r.detectError}`);
        }
      } catch (e: any) {
        if (!silent) toast('err', e?.message || '检测失败');
      } finally {
        setDetecting(false);
      }
    },
    [loadStatus, toast]
  );

  const saveDir = async (dir: string) => {
    setSavingDir(true);
    try {
      const r = await put<{ workbuddyDir: string; detected: SettingsInfo['detected'] }>('/api/settings', { workbuddyDir: dir });
      setSettings((prev) => (prev ? { ...prev, workbuddyDir: r.workbuddyDir, detected: r.detected } : prev));
      setWbDir(r.workbuddyDir);
      if (r.detected.valid) {
        setShowManual(false);
        toast('ok', `已保存，检测到 WorkBuddy 数据：${r.detected.dir}`);
      } else {
        toast('err', '已保存，但该目录未检测到 WorkBuddy 数据特征（models.json / 会话日志等）');
      }
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSavingDir(false);
    }
  };

  const saveProxy = async (url: string) => {
    setSavingProxy(true);
    try {
      const r = await put<{ ok: boolean; proxyUrl: string; effectiveProxy: string | null }>('/api/settings', { proxyUrl: url });
      setSettings((prev) => (prev ? { ...prev, proxyUrl: r.proxyUrl, effectiveProxy: r.effectiveProxy } : prev));
      setProxyInput(r.proxyUrl);
      toast('ok', r.proxyUrl ? `代理已保存，出站请求将走 ${r.effectiveProxy || r.proxyUrl}` : '代理已清空，恢复自动探测（环境变量 / 系统代理）');
    } catch (e: any) {
      toast('err', e?.message || '保存失败');
    } finally {
      setSavingProxy(false);
    }
  };

  const toggleAutoCheckin = async (next: boolean) => {
    const prev = !!settings?.autoCheckin;
    // 乐观更新：勾选立即响应，失败再回滚（否则要等一次本机请求往返，点上去像没反应）
    setSettings((p) => (p ? { ...p, autoCheckin: next } : p));
    try {
      const r = await put<{ autoCheckin: boolean }>('/api/settings', { autoCheckin: next });
      setSettings((p) => (p ? { ...p, autoCheckin: r.autoCheckin } : p));
      toast('ok', r.autoCheckin ? '已开启自动领取：服务端每小时巡检一次，自动补签并领取成长中心奖励' : '已关闭自动领取');
    } catch (e: any) {
      setSettings((p) => (p ? { ...p, autoCheckin: prev } : p));
      toast('err', e?.message || '保存失败');
    }
  };

  /** 其余布尔设置项的统一开关：与自动签到同一套「乐观更新 + 失败回滚」交互 */
  const toggleBoolSetting = async (
    key: 'autoRefreshToken' | 'autoCheckUpdate' | 'unlockAllPlatforms',
    next: boolean,
    hint: { on: string; off: string }
  ) => {
    if (!settings) return;
    const prev = !!settings[key];
    setSettings((p) => (p ? { ...p, [key]: next } : p));
    try {
      const r = await put<Partial<SettingsInfo>>('/api/settings', { [key]: next });
      setSettings((p) => (p ? { ...p, [key]: !!r[key] } : p));
      // 常驻挂载的其它页面不会因为"切回来"重新取数：把变更广播出去（如免费模型页的平台列表）
      emitSettingsChanged({ [key]: !!r[key] });
      toast('ok', next ? hint.on : hint.off);
    } catch (e: any) {
      setSettings((p) => (p ? { ...p, [key]: prev } : p));
      toast('err', e?.message || '保存失败');
    }
  };

  const runCheckin = async (accountId?: string) => {
    setCheckingIn(true);
    try {
      if (accountId) {
        const r = await post<{ ok: boolean; action: string; message: string; growth?: { report: string } }>(
          '/api/workbuddy/checkin',
          { accountId }
        );
        toast(r.ok ? 'ok' : 'err', r.growth?.report ? `${r.message}；${r.growth.report}` : r.message);
      } else {
        const r = await post<CheckinAllResult>('/api/workbuddy/checkin', { onlyPending: true });
        const { summary } = r;
        const parts = [`新签到 ${summary.checked} 个`];
        if (summary.already) parts.push(`已签到 ${summary.already} 个`);
        if (summary.skipped) parts.push(`跳过 ${summary.skipped} 个`);
        if (summary.failed) parts.push(`失败 ${summary.failed} 个`);
        if (summary.growthCredits) parts.push(`成长中心 +${summary.growthCredits} 积分`);
        toast(summary.failed || summary.growthHardFailures ? 'err' : 'ok', `领取完成：${parts.join('，')}`);
      }
      await loadCheckin(true);
    } catch (e: any) {
      toast('err', e?.message || '领取失败');
    } finally {
      setCheckingIn(false);
    }
  };

  const restartWb = async () => {
    const ok = await confirm({
      title: '重启 WorkBuddy',
      message: (
        <>
          将强制结束当前 WorkBuddy 进程并重新启动，使 <span className="font-mono text-xs">models.json</span> 的最新配置生效。
          <br />
          <span className="text-amber-600">正在进行的对话会被中断，请先保存工作。</span>
        </>
      ),
      confirmText: '重启',
      danger: true,
    });
    if (!ok) return;
    setRestarting(true);
    try {
      const r = await post<{ restarted: boolean; exePath?: string }>('/api/workbuddy/restart');
      toast('ok', `WorkBuddy 已重启${r.exePath ? `（${r.exePath}）` : ''}`);
      setTimeout(loadStatus, 2500);
    } catch (e: any) {
      toast('err', e?.message || '重启失败');
    } finally {
      setRestarting(false);
    }
  };

  const restoreBackup = async (b: BackupEntry) => {
    const ok = await confirm({
      title: '恢复登录态备份',
      message: (
        <>
          将用备份 <b className="text-zinc-800">{new Date(b.createdAt).toLocaleString('zh-CN')}</b>（{b.variantLabel}）
          覆盖当前的 {b.variantLabel}登录态文件。
          <br />
          覆盖前会自动再备份一次当前文件，可再次回退。若 WorkBuddy 正在运行，恢复后需重启它才会读取新登录态。
        </>
      ),
      confirmText: '恢复',
      danger: true,
    });
    if (!ok) return;
    setBackupBusy(b.name);
    try {
      const r = await post<{ authFilePath: string; safetyBackup: string | null }>('/api/workbuddy/backups/restore', { name: b.name });
      toast('ok', `已恢复登录态到 ${r.authFilePath}${r.safetyBackup ? '（原文件已另存备份）' : ''}`);
      await loadBackups();
      await loadPerm(true);
    } catch (e: any) {
      toast('err', e?.message || '恢复失败');
    } finally {
      setBackupBusy(null);
    }
  };

  const removeBackup = async (b: BackupEntry) => {
    const ok = await confirm({
      title: '删除备份',
      message: <>确定删除备份 <b className="text-zinc-800">{new Date(b.createdAt).toLocaleString('zh-CN')}</b> 吗？删除后无法恢复。</>,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    setBackupBusy(b.name);
    try {
      await del(`/api/workbuddy/backups/${encodeURIComponent(b.name)}`);
      toast('ok', '备份已删除');
      await loadBackups();
    } catch (e: any) {
      toast('err', e?.message || '删除失败');
    } finally {
      setBackupBusy(null);
    }
  };

  const cleanBackups = async () => {
    const keep = 10;
    const ok = await confirm({
      title: '清理旧备份',
      message: <>将只保留最近 <b className="text-zinc-800">{keep}</b> 份备份，更早的全部删除。删除后无法恢复。</>,
      confirmText: '清理',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await post<{ removed: number; keep: number }>('/api/workbuddy/backups/clean', { keep });
      toast('ok', r.removed ? `已清理 ${r.removed} 份旧备份，保留最近 ${r.keep} 份` : '没有需要清理的备份');
      await loadBackups();
    } catch (e: any) {
      toast('err', e?.message || '清理失败');
    }
  };

  const copyErrors = async () => {
    const text = errors
      .map((e) => `[${new Date(e.at).toLocaleString('zh-CN')}] ${e.kind === 'rejection' ? 'Promise拒绝' : '异常'} ${e.message}${e.source ? ` @ ${e.source}` : ''}${e.detail ? `\n${e.detail}` : ''}`)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('ok', `已复制 ${errors.length} 条错误记录`);
    } catch {
      toast('err', '复制失败，请手动选中复制');
    }
  };

  // 权限项按分组聚合展示
  const permGroups = useMemo(() => {
    const map = new Map<string, PermissionCheck[]>();
    for (const item of perm?.items || []) {
      if (!map.has(item.group)) map.set(item.group, []);
      map.get(item.group)!.push(item);
    }
    return [...map.entries()];
  }, [perm]);

  const cnStates: CheckinState[] = checkin?.states || [];

  return (
    <div className="space-y-6 max-w-4xl">
      {/* WorkBuddy 运行状态 */}
      <PageSection
        icon={<IconPower />}
        title="WorkBuddy 运行状态"
        desc="模型配置是否已生效、进程是否可以重启"
        actions={
          <Button size="sm" variant="subtle" loading={detecting} onClick={() => redetect(false)}>
            <IconRefresh className="w-3.5 h-3.5" />
            重新检测
          </Button>
        }
      >
        <Card className="p-5">
          {!status ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : (
            <>
              <div
                className={`rounded-xl border px-3.5 py-3 ${
                  status.pendingRestart ? 'border-amber-200 bg-amber-50/70' : status.running ? 'border-emerald-200 bg-emerald-50/60' : 'border-zinc-200 bg-zinc-50/70'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge color={status.running ? 'green' : status.detectError ? 'amber' : 'gray'} dot>
                    {status.running ? '运行中' : status.detectError ? '状态未知' : '未运行'}
                  </Badge>
                  {status.pendingRestart && <Badge color="amber">配置待重启生效</Badge>}
                  {status.processCount ? <span className="text-xs text-zinc-400">{status.processCount} 个进程</span> : null}
                  {status.detectMethod && <span className="text-xs text-zinc-300">探测方式：{status.detectMethod}</span>}
                </div>
                <div className="mt-2 space-y-0.5 text-xs text-zinc-500 leading-relaxed">
                  {status.exePath && (
                    <div className="break-all">
                      可执行文件：<span className="font-mono">{status.exePath}</span>
                    </div>
                  )}
                  {status.dir && (
                    <div className="break-all">
                      数据目录：<span className="font-mono">{status.dir}</span>
                    </div>
                  )}
                  {status.modelsJsonMtime ? <div>models.json 最后修改：{fmtDateTime(status.modelsJsonMtime)}</div> : null}
                  {status.detectError && <div className="text-amber-600">无法确认运行状态：{status.detectError}</div>}
                  {status.detectWarning && <div className="text-amber-600">{status.detectWarning}</div>}
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button variant="subtle" loading={restarting} disabled={!status.running} onClick={restartWb} title={status.running ? '结束进程并重新启动' : '当前未检测到运行中的 WorkBuddy'}>
                  <IconPower className="w-4 h-4" />
                  重启 WorkBuddy
                </Button>
                <span className="text-xs text-zinc-400">
                  在 WorkBuddy 运行期间载入的模型需要重启才会生效；工具已自动备份登录态，重启不影响账号。
                </span>
              </div>
            </>
          )}
        </Card>
      </PageSection>

      {/* 每日签到与成长中心 */}
      <PageSection
        icon={<IconClock />}
        title="每日签到与成长中心"
        count={cnStates.length ? `${cnStates.filter((s) => s.todayCheckedIn).length}/${cnStates.length} 今日已签` : undefined}
        desc="签到积分之外，成长中心的旅行礼物、任务、补登、连登兑换、盲盒、Buddy 也一并代领；自动巡检默认开启"
        actions={
          <>
            <Button size="sm" variant="subtle" loading={checkinLoading} onClick={() => loadCheckin(false)}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新状态
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={checkingIn}
              disabled={!cnStates.length}
              onClick={() => runCheckin()}
              title="签到 + 领取成长中心全部可领奖励（旅行礼物/派 Buddy/任务/断登补签/连登兑换/开盲盒/Buddy 盲盒）"
            >
              一键领取
            </Button>
          </>
        }
      >
        <Card className="p-5">
          <div className="divide-y divide-zinc-100 -mx-4 mb-3">
            <Row
              label={
                <span className="flex flex-wrap items-center gap-2">
                  自动领取（签到 + 成长中心）
                  <Badge color={settings?.autoCheckin ? 'green' : 'gray'}>
                    {settings?.autoCheckin ? '已开启（默认）' : '已关闭'}
                  </Badge>
                </span>
              }
              desc={
                <>
                  <b className="text-zinc-600">默认为开启</b>
                  ，服务端每小时巡检一次（06:00–23:00），发现当日未签到会自动补签，并顺带领取成长中心的
                  <b className="text-zinc-600">旅行礼物、派 Buddy、任务奖励、断登补签（消耗补登卡）、连登兑换、开盲盒、Buddy 盲盒</b>
                  （只对国内版账号生效；各接口幂等或由服务端兜底，重复执行无副作用；补登卡每轮最多用 1 张、盲盒每轮最多开 1 次）。
                  巡检依赖控制台处于运行状态：桌面版关闭窗口后会驻留系统托盘，领取不会中断。
                  <br />
                  不需要自动领取可在此关闭；关闭后仍可随时点右上角「一键领取」或单账号「领取」手动执行。
                </>
              }
            >
              <label className="flex items-center gap-2 text-sm text-zinc-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!!settings?.autoCheckin}
                  onChange={(e) => toggleAutoCheckin(e.target.checked)}
                  className="accent-indigo-600 rounded"
                />
                {settings?.autoCheckin ? '已开启自动巡检' : '关闭自动巡检'}
              </label>
            </Row>
          </div>

          {!cnStates.length ? (
            <div className="text-sm text-zinc-400 py-3">暂无国内版账号。签到需要账号具备明文凭据（WorkBuddy 登录后导入）。</div>
          ) : (
            <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/80">
              {cnStates.map((s) => (
                <div key={s.account.id} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5">
                  <div className="min-w-0">
                    <div className="text-sm text-zinc-800 truncate max-w-64">{s.account.name}</div>
                    <div className="text-xs text-zinc-400">
                      {s.ok ? (s.todayCheckedIn ? '今日已签到' : '今日未签到') : s.error || '状态未知'}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-1.5">
                    {s.ok ? (
                      s.todayCheckedIn ? (
                        <Badge color="green">已签到</Badge>
                      ) : (
                        <Badge color="amber">待签到</Badge>
                      )
                    ) : (
                      <Badge color="gray">{s.unsupported ? '不支持' : '查询失败'}</Badge>
                    )}
                    <Button
                      size="sm"
                      variant="subtle"
                      loading={checkingIn}
                      disabled={!s.ok}
                      onClick={() => runCheckin(s.account.id)}
                      title="签到（未签时）+ 领取成长中心全部可领奖励"
                    >
                      领取
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {!!checkin?.logs?.length && (
            <div className="mt-4">
              <div className="text-xs text-zinc-400 mb-1.5">最近领取记录（含成长中心）</div>
              <div className="max-h-48 overflow-y-auto rounded-xl border border-zinc-100 divide-y divide-zinc-50">
                {checkin.logs.map((l, i) => (
                  <div key={`${l.ts}-${i}`} className="px-3 py-1.5 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-zinc-400 tabular-nums">{fmtDateTime(l.ts)}</span>
                      <span className="text-zinc-600 truncate max-w-40">{l.accountName}</span>
                      <span className={l.ok ? 'text-emerald-600' : 'text-red-500'}>{l.message}</span>
                      {l.growth && l.growth.creditsGained > 0 && (
                        <Badge color="green">成长中心 +{l.growth.creditsGained}</Badge>
                      )}
                    </div>
                    {l.growth?.report && (
                      <div className={`mt-0.5 pl-0.5 leading-relaxed ${l.growth.ok ? 'text-zinc-500' : 'text-amber-600'}`}>
                        {l.growth.report}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      </PageSection>

      {/* 账号凭据维护 */}
      <PageSection
        icon={<IconRefresh />}
        title="账号凭据维护"
        desc="凭据不会自己续命：既没被切换过、也没走过反向代理的账号，会一路静默失效，直到只能重新扫码"
      >
        <Card className="p-5">
          <div className="divide-y divide-zinc-100 -mx-4 mb-3">
            <Row
              label={
                <span className="flex flex-wrap items-center gap-2">
                  凭据自动刷新
                  <Badge color={settings?.autoRefreshToken ? 'green' : 'gray'}>
                    {settings?.autoRefreshToken ? '已开启（默认）' : '已关闭'}
                  </Badge>
                </span>
              }
              desc={
                <>
                  服务端每 {refreshInfo?.intervalHours ?? 6} 小时看一次，
                  <b className="text-zinc-600">只在临期时才动手</b>：access_token 剩余不足{' '}
                  {refreshInfo?.accessMinHours ?? 24} 小时，或 refresh_token 剩余不足{' '}
                  {refreshInfo?.refreshMinHours ?? 72} 小时。关掉后，长期不切换、也不走反向代理的账号会一直静默过期。
                </>
              }
            >
              <label className="flex items-center gap-2 text-sm text-zinc-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!!settings?.autoRefreshToken}
                  onChange={(e) =>
                    toggleBoolSetting('autoRefreshToken', e.target.checked, {
                      on: '已开启凭据自动刷新：只在临期时才刷新，不会频繁打扰官方接口',
                      off: '已关闭凭据自动刷新：长期不用的账号可能失效',
                    })
                  }
                  className="accent-indigo-600 rounded"
                />
                {settings?.autoRefreshToken ? '已开启' : '已关闭'}
              </label>
            </Row>

            <Row label="立即检查" desc="只刷新已经临期的账号；有效期充足的保持不动，避免无谓的凭据轮换">
              <Button size="sm" onClick={runTokenRefresh} loading={refreshingTokens}>
                {!refreshingTokens && <IconRefresh className="w-3.5 h-3.5" />}
                检查并刷新
              </Button>
            </Row>
          </div>

          {!refreshInfo ? (
            <div className="py-3 text-sm text-zinc-400">正在读取账号凭据状态…</div>
          ) : !refreshInfo.accounts.length ? (
            <div className="py-3 text-sm text-zinc-400">账号库为空。先在「账号管理」里导入账号。</div>
          ) : (
            <ul className="-mx-4 divide-y divide-zinc-100">
              {refreshInfo.accounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-xs">
                  <span className="font-medium text-zinc-700">{a.name}</span>
                  <Badge color={a.dead ? 'red' : a.due ? 'amber' : 'gray'}>
                    {REFRESH_REASON_TEXT[a.reason] || a.reason}
                  </Badge>
                  {/* 服务端验活结论：本地有效期不算数，这里才是官方真实态度 */}
                  <span
                    title={
                      a.verify
                        ? a.verify.valid
                          ? `服务端于 ${fmtDateTime(a.verify.at)} 确认凭据有效`
                          : `服务端于 ${fmtDateTime(a.verify.at)} 拒绝该凭据${a.verify.message ? `：${a.verify.message}` : ''}`
                        : '尚未验活：每 6 小时自动巡检一次'
                    }
                  >
                    <Badge
                      color={a.verify ? (a.verify.valid ? 'green' : a.verify.unauthorized ? 'red' : 'amber') : 'gray'}
                    >
                      {a.verify
                        ? a.verify.valid
                          ? '已验活·有效'
                          : a.verify.unauthorized
                            ? '已验活·失效'
                            : '验活失败'
                        : '未验活'}
                    </Badge>
                  </span>
                  <span
                    className="ml-auto cursor-help tabular-nums text-zinc-400"
                    title={
                      '两个有效期是独立的两条线：access 到期只需用 refresh 换一份，refresh 到期才是真的没救。\n' +
                      '「未知」= 这条账号记录里没有该有效期字段（扫码接口不返回 refresh 有效期，手机端早期推送也不带），' +
                      '不是读取失败；等它下次被刷新时会补上。'
                    }
                  >
                    access {fmtHours(a.accessHours)} · refresh {fmtHours(a.refreshHours)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {refreshInfo?.lastRun && (
            <div className="mt-3 text-[11px] text-zinc-400">
              最近一次自动巡检：{fmtDateTime(refreshInfo.lastRun.at)}，刷新 {refreshInfo.lastRun.refreshed} 个账号。
            </div>
          )}
        </Card>
      </PageSection>

      {/* 手机同步（局域网） */}
      <LanSyncSection />

      {/* WorkBuddy 数据目录 */}
      <PageSection
        icon={<IconDatabase />}
        title="WorkBuddy 数据目录"
        desc="模型配置与 Token 统计的数据来源"
        actions={
          <Button size="sm" variant="subtle" loading={detecting} onClick={() => redetect(false)}>
            <IconRefresh className="w-3.5 h-3.5" />
            重新检测
          </Button>
        }
      >
        <Card className="p-5">
          {!settings ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : (
            <>
              <div className={`rounded-xl border px-3.5 py-3 ${settings.detected.valid ? 'border-emerald-200 bg-emerald-50/60' : 'border-amber-200 bg-amber-50'}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm text-zinc-800 break-all">{settings.detected.dir}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    {settings.detected.source === 'override' && <Badge color="blue">{settings.detected.sourceLabel}</Badge>}
                    {settings.detected.valid ? <Badge color="green">已检测到</Badge> : <Badge color="amber">未检测到</Badge>}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <MarkerBadge ok={settings.detected.markers.modelsJson} label="models.json" />
                  <MarkerBadge ok={settings.detected.markers.projects} label="会话日志" />
                  <MarkerBadge ok={settings.detected.markers.sessions} label="sessions" />
                  <MarkerBadge ok={settings.detected.markers.db} label="workbuddy.db" />
                </div>
                {!settings.detected.valid && (
                  <div className="mt-2 text-xs text-amber-600">
                    未找到 WorkBuddy 数据特征文件。请先安装并运行一次 WorkBuddy，或展开「手动指定」填写数据目录。
                  </div>
                )}
              </div>

              <div className="mt-3">
                <Button size="sm" variant="ghost" onClick={() => setShowManual((v) => !v)}>
                  <IconChevronDown className={`w-3.5 h-3.5 transition-transform ${showManual ? '' : '-rotate-90'}`} />
                  手动指定
                </Button>
              </div>

              {showManual && (
                <div className="mt-3 rounded-xl border border-zinc-200 p-3.5 animate-fade-in">
                  <div className="text-xs text-zinc-500 mb-2">手动指定数据目录（一般无需修改；留空保存即恢复自动检测）：</div>
                  <div className="flex items-center gap-2">
                    <input
                      value={wbDir}
                      onChange={(e) => setWbDir(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && saveDir(wbDir)}
                      placeholder="例如 C:\Users\你\.workbuddy"
                      className="flex-1 h-9 px-3 rounded-xl border border-zinc-200 text-sm font-mono outline-none focus:border-indigo-400"
                    />
                    <Button variant="primary" loading={savingDir} onClick={() => saveDir(wbDir)}>
                      保存
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </Card>
      </PageSection>

      {/* 登录态与目录权限 */}
      <PageSection
        icon={<IconShield />}
        title="登录态与目录权限"
        desc="切换账号、载入模型都要写这些位置"
        actions={
          <>
            {perm && <Badge color={perm.ok ? 'green' : 'red'}>{perm.ok ? '全部正常' : '存在异常'}</Badge>}
            <Button size="sm" variant="subtle" loading={permLoading} onClick={() => loadPerm(false)}>
              <IconRefresh className="w-3.5 h-3.5" />
              重新自检
            </Button>
          </>
        }
      >
        <Card className="p-5 space-y-4">
          {!perm ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : (
            permGroups.map(([group, items]) => (
              <div key={group}>
                <div className="text-xs font-medium text-zinc-400 mb-1.5">{group}</div>
                <div className="divide-y divide-zinc-100 rounded-xl border border-zinc-200/80">
                  {items.map((item) => (
                    <div key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5">
                      <Badge color={item.ok ? 'green' : 'red'}>{item.ok ? '✓' : '✗'}</Badge>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-zinc-700">{item.label}</div>
                        <div className="text-xs text-zinc-400 font-mono break-all">{item.path}</div>
                        <div className="text-xs text-zinc-400 mt-0.5">{item.hint}</div>
                        {!item.exists && <div className="text-xs text-zinc-400 mt-0.5">尚未创建，首次使用时自动生成。</div>}
                        {item.exists && !item.writable && <div className="text-xs text-red-500 mt-0.5">不可写：可能是只读或被其他程序占用。</div>}
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                        <span className={item.readable ? 'text-emerald-600' : 'text-red-500'}>读</span>
                        <span className="text-zinc-200">/</span>
                        <span className={item.writable ? 'text-emerald-600' : 'text-red-500'}>写</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </Card>
      </PageSection>

      {/* 登录态备份与恢复 */}
      <PageSection
        icon={<IconDatabase />}
        title="登录态备份与恢复"
        count={backups ? `${backups.backups.length} 份` : undefined}
        desc="每次切换账号前自动备份，可随时回退"
        actions={
          <>
            <Button size="sm" variant="subtle" onClick={loadBackups}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
            <Button size="sm" variant="subtle" disabled={!backups?.backups.length} onClick={cleanBackups}>
              <IconTrash className="w-3.5 h-3.5" />
              清理旧备份
            </Button>
          </>
        }
      >
        <Card className="p-5">
          <div className="text-xs text-zinc-400 mb-3 break-all">备份目录：{backups?.dir || '…'}</div>
          {!backups ? (
            <div className="py-6 flex justify-center">
              <Spinner />
            </div>
          ) : backups.backups.length === 0 ? (
            <div className="text-sm text-zinc-400 py-3">还没有备份。切换账号时本工具会自动把切换前的登录态存到这里。</div>
          ) : (
            <div className="max-h-80 overflow-y-auto rounded-xl border border-zinc-200/80 divide-y divide-zinc-100">
              {backups.backups.map((b) => (
                <div key={b.name} className="flex flex-wrap items-center gap-2 px-3.5 py-2.5 hover:bg-zinc-50/70 transition-colors">
                  <div className="min-w-0">
                    <div className="text-sm text-zinc-700 tabular-nums">{new Date(b.createdAt).toLocaleString('zh-CN')}</div>
                    <div className="text-xs text-zinc-400">
                      {b.variantLabel} · {fmtSize(b.size)} · {fmtRelative(b.mtime)}
                    </div>
                  </div>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button size="sm" variant="subtle" loading={backupBusy === b.name} onClick={() => restoreBackup(b)}>
                      恢复
                    </Button>
                    <Button size="sm" variant="danger" loading={backupBusy === b.name} onClick={() => removeBackup(b)}>
                      <IconTrash className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </PageSection>

      {/* 免费模型平台可见性 */}
      <PageSection
        icon={<IconLayers />}
        title="免费模型平台"
        desc="默认只列出能正常接入的平台"
        count={restrictedPlatforms.length ? `默认收起 ${restrictedPlatforms.length} 个` : undefined}
      >
        <Card className="p-5">
          <Row
            label="显示全部平台"
            desc="开启后，免费模型页会把因地区限制、或平台自身禁止外部接入而默认收起的平台一并列出，可自行尝试接入"
          >
            <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-zinc-500">
              <input
                type="checkbox"
                checked={!!settings?.unlockAllPlatforms}
                onChange={(e) =>
                  toggleBoolSetting('unlockAllPlatforms', e.target.checked, {
                    on: '已开放全部平台：这些平台大概率仍会被限制，接不上属于预期结果',
                    off: '已恢复默认：只显示可正常接入的平台',
                  })
                }
                className="rounded accent-indigo-600"
              />
              {settings?.unlockAllPlatforms ? '已开启' : '已关闭'}
            </label>
          </Row>

          {restrictedPlatforms.length > 0 && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-zinc-100 px-4 pt-3 text-xs text-zinc-400">
              <span>受限制的平台：</span>
              {restrictedPlatforms.map((p) => (
                <span key={p.id} className="inline-flex items-center gap-1">
                  <Badge color="gray">{p.name}</Badge>
                  <span className="text-[11px] text-zinc-300">
                    {p.restriction === 'region' ? '地区受限' : '平台禁止外部接入'}
                  </span>
                </span>
              ))}
            </div>
          )}

          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-relaxed text-amber-700">
            <span className="font-medium">风险提示：</span>
            上面这些平台按地区或自身策略限制了外部调用。即使 key 能创建成功，从这里接入后也可能出现
            <b>请求被拒、频繁限流，甚至账号被风控或封禁</b>
            。默认收起正是因为「接进去大概率也用不了」；是否接入请自行判断并承担风险，也请先确认你了解该平台的服务条款。
          </div>
        </Card>
      </PageSection>

      {/* 网络代理 */}
      <PageSection icon={<IconSliders />} title="网络代理" desc="访问 OpenRouter 等海外平台时使用">
        <Card className="p-5">
          <div className="text-xs text-zinc-400 mb-3 leading-relaxed">
            OpenRouter 等海外平台在国内网络下可能无法直连。工具的出站请求默认不走系统代理，此处的代理地址用于访问这些平台；留空时自动探测环境变量（
            <span className="font-mono">HTTPS_PROXY</span>）与 Windows 系统代理，均未命中则直连。
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={proxyInput}
              onChange={(e) => setProxyInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && saveProxy(proxyInput)}
              placeholder="例如 http://127.0.0.1:7890"
              className="flex-1 min-w-56 h-9 px-3 rounded-xl border border-zinc-200 text-sm font-mono outline-none focus:border-indigo-400"
            />
            <Button variant="primary" loading={savingProxy} onClick={() => saveProxy(proxyInput)}>
              保存
            </Button>
          </div>
          <div className="text-xs text-zinc-400 mt-2.5">
            当前出站状态：
            {settings ? (
              settings.effectiveProxy ? (
                <span className="text-emerald-600 font-mono">走代理 {settings.effectiveProxy}</span>
              ) : (
                <span className="text-amber-600">直连（未配置代理，需 VPN 的平台将无法访问）</span>
              )
            ) : (
              '…'
            )}
          </div>
        </Card>
      </PageSection>

      {/* 通知历史 */}
      <PageSection
        icon={<IconClock />}
        title="通知历史"
        count={notifications.length ? `${notifications.length} 条` : undefined}
        desc={`保留最近 ${NOTIFICATION_MAX} 条应用内提示`}
        actions={
          <>
            <Button size="sm" variant="subtle" onClick={loadLocalLogs}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
            <Button
              size="sm"
              variant="subtle"
              disabled={!notifications.length}
              onClick={() => {
                clearNotifications();
                setNotifications([]);
                toast('ok', '通知历史已清空');
              }}
            >
              <IconTrash className="w-3.5 h-3.5" />
              清空
            </Button>
          </>
        }
      >
        <Card className="p-5">
          {notifications.length === 0 ? (
            <div className="text-sm text-zinc-400 py-3">还没有记录到任何提示。</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto divide-y divide-zinc-50 rounded-xl border border-zinc-100">
              {notifications.map((n, i) => (
                <li key={`${n.at}-${i}`} className="px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        n.type === 'ok' ? 'bg-emerald-500' : n.type === 'err' ? 'bg-red-500' : 'bg-zinc-400'
                      }`}
                    />
                    <span>{n.type === 'ok' ? '成功' : n.type === 'err' ? '错误' : '提示'}</span>
                    <span>·</span>
                    <span className="tabular-nums">{fmtDateTime(n.at)}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-zinc-600 leading-5 break-words">{n.text}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageSection>

      {/* 界面错误日志 */}
      <PageSection
        icon={<IconWarning />}
        title="界面错误日志"
        count={errors.length ? `${errors.length} 条` : undefined}
        desc={`捕获界面异常与 Promise 拒绝，保留最近 ${ERROR_MAX} 条`}
        actions={
          <>
            <Button size="sm" variant="subtle" onClick={loadLocalLogs}>
              <IconRefresh className="w-3.5 h-3.5" />
              刷新
            </Button>
            <Button size="sm" variant="subtle" disabled={!errors.length} onClick={copyErrors}>
              <IconCopy className="w-3.5 h-3.5" />
              复制
            </Button>
            <Button
              size="sm"
              variant="subtle"
              disabled={!errors.length}
              onClick={() => {
                clearErrors();
                setErrors([]);
                toast('ok', '错误日志已清空');
              }}
            >
              <IconTrash className="w-3.5 h-3.5" />
              清空
            </Button>
          </>
        }
      >
        <Card className="p-5">
          <div className="text-xs text-zinc-400 mb-3 leading-relaxed">
            界面崩溃与未捕获的错误会记录在这里，反馈问题时可直接复制贴出；只存本机，不含任何 Key 或账号凭据。
          </div>
          {errors.length === 0 ? (
            <div className="text-sm text-emerald-600 py-3">运行正常，未捕获到界面错误。</div>
          ) : (
            <ul className="max-h-72 overflow-y-auto divide-y divide-zinc-50 rounded-xl border border-zinc-100">
              {errors.map((e, i) => (
                <li key={`${e.at}-${i}`} className="px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                    <Badge color="red">{e.kind === 'rejection' ? 'Promise' : '异常'}</Badge>
                    <span className="tabular-nums">{fmtDateTime(e.at)}</span>
                    {e.source && <span className="font-mono break-all">{e.source}</span>}
                  </div>
                  <div className="mt-1 text-xs text-zinc-700 leading-5 break-words">{e.message}</div>
                  {e.detail && (
                    <pre className="mt-1 max-h-32 overflow-auto rounded-lg bg-zinc-50 p-2 text-[10px] leading-4 text-zinc-500 whitespace-pre-wrap break-all">
                      {e.detail}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageSection>

      {/* 关于 */}
      <PageSection icon={<IconShield />} title="关于 workbuddy控制台">
        <Card className="p-5 text-xs text-zinc-400 leading-relaxed space-y-1.5">
          <div className="flex items-center gap-2">
            <div className="font-medium text-zinc-600 text-sm">WorkBuddy 一体化管理工具</div>
            {/* 版本号取自服务端 package.json，前端不再硬编码（发版忘了改这里就再也对不上了） */}
            <Badge color="gray">{updateInfo ? `v${updateInfo.current}` : '版本读取中'}</Badge>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-2.5">
            {updateInfo?.hasUpdate ? (
              <>
                <Badge color="green">发现新版本 v{updateInfo.latest}</Badge>
                <a
                  href={updateInfo.downloadUrl || updateInfo.releaseUrl || '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex h-7 items-center gap-1 rounded-xl border border-indigo-300 px-2.5 text-[11px] font-medium text-indigo-600 transition-colors hover:bg-indigo-50"
                >
                  <IconDownload className="w-3.5 h-3.5" />
                  下载安装包
                </a>
              </>
            ) : (
              <Badge color="gray">{updateInfo?.error ? '版本状态未知' : '已是最新版本'}</Badge>
            )}
            <Button size="sm" onClick={() => loadUpdateInfo(true)} loading={checkingUpdate}>
              {!checkingUpdate && <IconRefresh className="w-3.5 h-3.5" />}
              检查更新
            </Button>
            <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!settings?.autoCheckUpdate}
                onChange={(e) =>
                  toggleBoolSetting('autoCheckUpdate', e.target.checked, {
                    on: '已开启自动检查更新',
                    off: '已关闭自动检查更新（仍可手动点「检查更新」）',
                  })
                }
                className="accent-indigo-600 rounded"
              />
              启动时自动检查
            </label>
          </div>

          {updateInfo?.error && <div className="text-amber-600">{updateInfo.error}</div>}
          {!!updateInfo?.checkedAt && !updateInfo.error && (
            <div className="text-zinc-300">
              上次检查：{fmtDateTime(updateInfo.checkedAt)}
              {updateInfo.cached ? '（本地缓存，6 小时内不重复请求）' : ''}
            </div>
          )}
          <div>
            主要能力：账号管理（扫码登录 / 切换 / 备份恢复）· Token 统计 · 积分统计 ·
            免费模型广场（免费模型 / 平台额度 / API Keys）·
            反向代理（让其他 agent 按 OpenAI / Anthropic / Responses / Gemini 四种协议调用 WorkBuddy 的积分与模型）。
          </div>
          <div>
            目标应用：<span className="text-zinc-500">WorkBuddy</span>（数据目录 {settings?.detected?.dir || '~/.workbuddy'}）。
          </div>
          <div>
            当前可用平台：OpenRouter、Agnes AI、硅基流动、魔搭；地区受限平台（Groq、Google AI Studio、NVIDIA、GitHub Models、OpenCode Zen）仅在免费模型展示，不可浏览与载入。
          </div>
          <div className="flex items-start gap-1.5">
            <IconShield className="w-3.5 h-3.5 mt-px shrink-0 text-emerald-500" />
            <span>隐私：API Key、账号凭据与统计数据均只保存在本机，不经过任何第三方服务器；界面访问仅限 127.0.0.1。</span>
          </div>
          <div className="text-zinc-300">备份与账号库与 workbuddy-switch 共用 ~/.wb-switch，可同时安装、随时切换。</div>
        </Card>
      </PageSection>
    </div>
  );
}

/**
 * 手机同步（局域网）。
 *
 * 与 fewards 手机端配对后：手机把 WorkBuddy 凭据推过来，电脑刷新完把最新凭据回传，
 * 手机下次同步自动取走。这里只管"开关 / 端口 / 配对码 / 待回传条数"，
 * 真正的凭据收发在独立端口上（server/lansync/server.mjs），不经过控制台 UI。
 */
function LanSyncSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const [info, setInfo] = useState<LanSyncStatus | null>(null);
  const [portDraft, setPortDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await get<LanSyncStatus>('/api/lansync/status');
      setInfo(r);
      setPortDraft(String(r.port));
    } catch {
      // 老版本服务端没有这个接口：静默降级，不打扰用户
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const apply = async (patch: { enabled?: boolean; port?: number; refreshOnPush?: boolean }) => {
    setBusy(true);
    try {
      const r = await put<LanSyncStatus>('/api/lansync/settings', patch);
      setInfo(r);
      setPortDraft(String(r.port));
      if (r.error) toast('err', `同步服务启动失败：${r.error}`);
      else if (r.running) toast('ok', `已开启同步，正在监听 ${r.listeningPort} 端口`);
      else toast('ok', '已关闭手机同步');
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    const ok = await confirm({
      title: '重置配对码',
      message: <>重置后，已经配对的手机必须重新输入新配对码才能同步。确定继续吗？</>,
      confirmText: '重置',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await post<LanSyncStatus>('/api/lansync/code/rotate');
      setInfo(r);
      toast('ok', '配对码已更新，请在手机上重新填写');
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string, label: string) => {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(
      () => toast('ok', `已复制${label}`),
      () => toast('err', '复制失败，请手动选中复制')
    );
  };

  const clearQueue = async () => {
    setBusy(true);
    try {
      const r = await post<LanSyncStatus>('/api/lansync/pending/clear');
      setInfo(r);
      toast('ok', '待回传队列已清空');
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 重新读取局域网地址。
   *
   * 地址是服务端每次请求时现读网卡（os.networkInterfaces）得到的，不存在缓存；
   * 但界面里的那份是挂载时取回来的——程序启动后换了 Wi-Fi、插拔了网线、
   * 或 DHCP 重新分配了 IP，界面就会一直显示旧地址，手机按旧地址必然连不上。
   * 所以这里给一个手动重取的入口，并明确告知地址到底是变了还是没变。
   */
  const refreshAddresses = async () => {
    setRefreshing(true);
    const before = (info?.addresses || []).map((a) => a.address).join(',');
    try {
      const r = await get<LanSyncStatus>('/api/lansync/status');
      setInfo(r);
      const after = (r.addresses || []).map((a) => a.address).join(',');
      if (!after) toast('err', '没读到局域网地址，请确认电脑已连上 Wi-Fi');
      else if (after !== before) toast('ok', '局域网地址已更新，请用新地址重新配对');
      else toast('ok', '已刷新，地址没有变化');
    } catch (e) {
      toast('err', (e as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const shownPort = info?.listeningPort || info?.port;

  return (
    <PageSection
      icon={<IconLayers />}
      title="手机同步（局域网）"
      desc="fewards 手机端把 WorkBuddy 凭据推送到这台电脑；电脑刷新凭据后，手机下次同步会自动取回最新值"
      actions={
        <Badge color={info?.running ? 'green' : info?.enabled ? 'amber' : 'gray'}>
          {info?.running ? `监听中 :${info.listeningPort}` : info?.enabled ? '已开启但未运行' : '已关闭'}
        </Badge>
      }
    >
      <Card className="p-5">
        <div className="divide-y divide-zinc-100 -mx-4">
          <Row
            label={
              <span className="flex flex-wrap items-center gap-2">
                启用手机同步
                <Badge color={info?.enabled ? 'green' : 'gray'}>{info?.enabled ? '已开启' : '已关闭'}</Badge>
              </span>
            }
            desc="会单独打开一个局域网端口，只暴露推送 / 拉取凭据的四个接口；控制台界面与反向代理仍然只监听 127.0.0.1。默认关闭。"
          >
            <label className="flex items-center gap-2 text-sm text-zinc-600 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={!!info?.enabled}
                disabled={busy || loading}
                onChange={(e) => apply({ enabled: e.target.checked })}
                className="accent-indigo-600 rounded"
              />
              {info?.enabled ? '已开启' : '已关闭'}
            </label>
          </Row>

          <Row label="监听端口" desc="手机端填这个端口。改完会自动重启监听，正在同步的手机会断开一次。">
            <input
              value={portDraft}
              onChange={(e) => setPortDraft(e.target.value.replace(/\D/g, '').slice(0, 5))}
              disabled={busy || loading}
              className="w-24 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-sm font-mono focus:border-indigo-400 focus:outline-none"
              placeholder="57900"
            />
            <Button
              size="sm"
              variant="subtle"
              disabled={busy || !portDraft || Number(portDraft) === info?.port}
              onClick={() => apply({ port: Number(portDraft) })}
            >
              保存
            </Button>
          </Row>

          <Row label="配对码" desc="手机端必须填同一串。重置后，所有已配对的手机都要重新输入。">
            <code className="rounded-lg bg-zinc-100 px-3 py-1.5 font-mono text-base tracking-[0.18em] text-zinc-800">
              {info?.pairCode || '未生成'}
            </code>
            <Button size="sm" variant="subtle" disabled={!info?.pairCode} onClick={() => copy(info?.pairCode || '', '配对码')}>
              <IconCopy className="w-3.5 h-3.5" />
              复制
            </Button>
            <Button size="sm" variant="subtle" loading={busy} onClick={rotate}>
              重置
            </Button>
          </Row>

          <Row
            label="手机该填的地址"
            desc="手机和电脑要在同一个 Wi-Fi 下（访客网络 / AP 隔离会连不通）。点一下复制；启动后换过 Wi-Fi、重连过网络，IP 会变，点「刷新地址」重新读取。"
          >
            {info?.addresses?.length ? (
              info.addresses.map((a) => (
                <button
                  key={a.address}
                  type="button"
                  onClick={() => copy(`${a.address}:${shownPort}`, '地址')}
                  className="rounded-lg border border-zinc-200 px-2.5 py-1.5 font-mono text-xs text-zinc-700 hover:border-indigo-300 hover:text-indigo-600"
                  title={`网卡 ${a.iface}，点一下复制`}
                >
                  {a.address}:{shownPort}
                  <span className="ml-2 text-[10px] text-zinc-400">{a.iface}</span>
                </button>
              ))
            ) : (
              <span className="text-xs text-zinc-400">没有检测到局域网地址（电脑可能没连网络）</span>
            )}
            <Button
              size="sm"
              variant="subtle"
              loading={refreshing}
              disabled={loading}
              onClick={refreshAddresses}
              title="重新读取本机网卡地址，换网络后用它更新上面的 IP"
            >
              <IconRefresh className="w-3.5 h-3.5" />
              刷新地址
            </Button>
          </Row>

          <Row
            label={
              <span className="flex flex-wrap items-center gap-2">
                待回传凭据
                <Badge color={info?.pending?.count ? 'amber' : 'gray'}>{info?.pending?.count ?? 0}</Badge>
              </span>
            }
            desc="电脑刷新过、手机还没取走的账号记录。手机每次同步会自动取走并确认，正常情况下这里会一直是 0。"
          >
            <Button size="sm" variant="subtle" disabled={busy || !info?.pending?.count} onClick={clearQueue}>
              <IconTrash className="w-3.5 h-3.5" />
              清空
            </Button>
          </Row>
        </div>

        <div className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-700">
          同一账号在任意时刻只应有一端刷新：手机刷新后立刻推送，电脑刷新后手机会自动取回。
          两端各刷一次会让先刷的那份立即失效，表现为「账号突然要重新登录」。
        </div>
      </Card>
    </PageSection>
  );
}
