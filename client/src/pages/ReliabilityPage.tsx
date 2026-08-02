import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, Zap, AlertTriangle, CheckCircle2, Clock, TrendingUp, Plug, Server } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { Tooltip } from '@/components/tooltip'
import { useI18n } from '@/i18n'

type TimeRange = '1h' | '24h' | '7d'

// ── Types matching the server's /api/fallback/* responses ──────────────────

interface FallbackStats {
  totalEvents: number
  attemptsByTier: { local: number; cloud: number }
  attemptsByPlatform: Record<string, number>
  outcomes: Record<string, number>
  breakerTransitions: Record<string, { opened: number; closed: number }>
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  meanAttemptsToSuccess: number | null
  cloudHitRate: number | null
}

interface FallbackEvent {
  id: number
  requestId: string | null
  tier: 'local' | 'cloud'
  platform: string | null
  model: string | null
  outcome: string
  latencyMs: number | null
  reason: string | null
  createdAt: number
}

interface BreakerSnapshot {
  platform: string
  state: 'closed' | 'open' | 'half-open'
  failCount: number
  lastFailAt: number
  openedAt?: number
  totalFailures: number
  totalSuccesses: number
  totalOpens: number
}

const rangeToMs: Record<TimeRange, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
}

// ── UI primitives (mirror AnalyticsPage style) ──────────────────────────

function Stat({ label, value, hint, icon: Icon, className }: {
  label: string
  value: string | number
  hint?: string
  icon?: React.ComponentType<{ className?: string }>
  className?: string
}) {
  const card = (
    <div className="rounded-3xl border bg-card px-4 py-3">
      <div className="flex items-center gap-1.5">
        {Icon && <Icon className="size-3.5 text-muted-foreground" />}
        <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      </div>
      <p className={`text-xl font-semibold tabular-nums mt-1 ${className ?? ''}`}>{value}</p>
    </div>
  )
  return hint ? <Tooltip text={hint} side="bottom">{card}</Tooltip> : card
}

function Panel({ title, description, action, children }: {
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="rounded-3xl border bg-card">
      <div className="px-4 py-3 border-b flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          {description && <p className="text-[11px] text-muted-foreground mt-0.5">{description}</p>}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function formatPct(n: number | null): string {
  if (n == null) return '—'
  return `${(n * 100).toFixed(0)}%`
}

function formatMs(n: number | null): string {
  if (n == null) return '—'
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(1)} s`
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return `${Math.max(0, Math.floor(diff / 1000))}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

const outcomeColors: Record<string, string> = {
  attempt_success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20',
  attempt_retryable: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/20',
  attempt_non_retryable: 'bg-red-500/10 text-red-700 dark:text-red-300 ring-red-500/20',
  attempt_skipped: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300 ring-zinc-500/20',
  attempt_empty: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/20',
  tier_switch: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/20',
  chain_exhausted: 'bg-red-500/10 text-red-700 dark:text-red-300 ring-red-500/20',
  breaker_open: 'bg-red-500/10 text-red-700 dark:text-red-300 ring-red-500/20',
  breaker_close: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20',
}

const stateColors: Record<string, string> = {
  closed: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/20',
  open: 'bg-red-500/10 text-red-700 dark:text-red-300 ring-red-500/20',
  'half-open': 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/20',
}

export default function ReliabilityPage() {
  const { t } = useI18n()
  const [range, setRange] = useState<TimeRange>('1h')

  // ── Data fetching (TanStack Query, same pattern as AnalyticsPage) ──
  // Re-fetch every 10s so the activity feed and breaker state stay fresh
  // without spamming the server. The /api/fallback endpoints are all
  // backed by SQLite, so re-render cost is negligible.
  const { data: stats } = useQuery({
    queryKey: ['reliability', 'stats', range],
    queryFn: () => apiFetch<FallbackStats>(`/api/fallback/stats?windowMs=${rangeToMs[range]}`),
    refetchInterval: 10_000,
  })

  const { data: events = [] } = useQuery({
    queryKey: ['reliability', 'events'],
    queryFn: () => apiFetch<FallbackEvent[]>(`/api/fallback/events?limit=50`),
    refetchInterval: 10_000,
  })

  const { data: breakers = [] } = useQuery({
    queryKey: ['reliability', 'breakers'],
    queryFn: () => apiFetch<BreakerSnapshot[]>(`/api/fallback/breakers`),
    refetchInterval: 10_000,
  })

  // Per-platform attempt distribution for the chart. Sort by volume desc.
  const platformData = stats
    ? Object.entries(stats.attemptsByPlatform)
        .map(([platform, count]) => ({ platform, count }))
        .sort((a, b) => b.count - a.count)
    : []

  return (
    <div>
      <PageHeader
        title={t('reliability.title')}
        description={t('reliability.description')}
        actions={
          <div className="flex gap-1 rounded-lg border p-0.5">
            {(['1h', '24h', '7d'] as TimeRange[]).map(r => (
              <Button
                key={r}
                variant={range === r ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setRange(r)}
              >
                {t(r === '1h' ? 'reliability.range1h' : r === '24h' ? 'reliability.range24h' : 'reliability.range7d')}
              </Button>
            ))}
          </div>
        }
      />

      <div className="space-y-6">
        {/* ── KPI cards ──────────────────────────────────────────── */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <Stat
            label={t('reliability.totalEvents')}
            value={stats?.totalEvents ?? 0}
            icon={Activity}
            hint={t('reliability.totalEventsHint')}
          />
          <Stat
            label={t('reliability.p50Latency')}
            value={formatMs(stats?.p50LatencyMs ?? null)}
            icon={Clock}
            hint={t('reliability.p50Hint')}
          />
          <Stat
            label={t('reliability.p95Latency')}
            value={formatMs(stats?.p95LatencyMs ?? null)}
            icon={TrendingUp}
            hint={t('reliability.p95Hint')}
            className={(stats?.p95LatencyMs ?? 0) > 5000 ? 'text-amber-600 dark:text-amber-400' : ''}
          />
          <Stat
            label={t('reliability.meanAttempts')}
            value={stats?.meanAttemptsToSuccess != null ? stats.meanAttemptsToSuccess.toFixed(1) : '—'}
            icon={Zap}
            hint={t('reliability.meanAttemptsHint')}
            className={(stats?.meanAttemptsToSuccess ?? 0) > 3 ? 'text-amber-600 dark:text-amber-400' : ''}
          />
          <Stat
            label={t('reliability.cloudHitRate')}
            value={formatPct(stats?.cloudHitRate ?? null)}
            icon={Plug}
            hint={t('reliability.cloudHitRateHint')}
            className={(stats?.cloudHitRate ?? 0) > 0.2 ? 'text-amber-600 dark:text-amber-400' : ''}
          />
        </div>

        {/* ── Circuit breakers ───────────────────────────────────── */}
        <Panel
          title={t('reliability.breakersTitle')}
          description={t('reliability.breakersDescription')}
        >
          {breakers.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('reliability.breakersEmpty')}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {breakers.map(b => (
                <div key={b.platform} className="rounded-2xl border p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Server className="size-3.5 text-muted-foreground" />
                      <span className="text-xs font-mono">{b.platform}</span>
                    </div>
                    <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${stateColors[b.state]}`}>
                      {b.state === 'closed' && <CheckCircle2 className="size-3" />}
                      {b.state === 'open' && <AlertTriangle className="size-3" />}
                      {b.state === 'half-open' && <Clock className="size-3" />}
                      {b.state}
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">opens</p>
                      <p className="text-sm font-semibold tabular-nums">{b.totalOpens}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">failures</p>
                      <p className="text-sm font-semibold tabular-nums">{b.totalFailures}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase">successes</p>
                      <p className="text-sm font-semibold tabular-nums">{b.totalSuccesses}</p>
                    </div>
                  </div>
                  {b.lastFailAt > 0 && (
                    <p className="text-[10px] text-muted-foreground mt-2">
                      last fail: {formatRelative(b.lastFailAt)}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Panel>

        {/* ── Per-platform attempt distribution ──────────────────── */}
        {platformData.length > 0 && (
          <Panel
            title={t('reliability.platformsTitle')}
            description={t('reliability.platformsDescription')}
          >
            <div className="space-y-1.5">
              {platformData.slice(0, 10).map(({ platform, count }) => {
                const max = platformData[0]?.count ?? 1
                const pct = (count / max) * 100
                return (
                  <div key={platform} className="flex items-center gap-3">
                    <span className="text-[11px] text-muted-foreground w-24 truncate font-mono">{platform}</span>
                    <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                      <div className="h-full rounded-full bg-foreground" style={{ width: `${pct}%` }} />
                    </div>
                    <span className="text-[11px] tabular-nums w-12 text-right text-muted-foreground">{count}</span>
                  </div>
                )
              })}
            </div>
          </Panel>
        )}

        {/* ── Recent activity ────────────────────────────────────── */}
        <Panel
          title={t('reliability.activityTitle')}
          description={t('reliability.activityDescription')}
        >
          {events.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('reliability.activityEmpty')}</p>
          ) : (
            <div className="rounded-xl border overflow-x-auto max-h-[480px] overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b text-left text-[10px] text-muted-foreground uppercase tracking-wider">
                    <th className="px-3 py-2 font-medium">when</th>
                    <th className="px-3 py-2 font-medium">tier</th>
                    <th className="px-3 py-2 font-medium">platform</th>
                    <th className="px-3 py-2 font-medium">model</th>
                    <th className="px-3 py-2 font-medium">outcome</th>
                    <th className="px-3 py-2 font-medium text-right">latency</th>
                    <th className="px-3 py-2 font-medium">reason</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map(e => (
                    <tr key={e.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-1.5 text-muted-foreground tabular-nums whitespace-nowrap">
                        {formatRelative(e.createdAt)}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
                          e.tier === 'cloud'
                            ? 'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/20'
                            : 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300 ring-zinc-500/20'
                        }`}>
                          {e.tier}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground">{e.platform ?? '—'}</td>
                      <td className="px-3 py-1.5 font-mono text-muted-foreground truncate max-w-[200px]">{e.model ?? '—'}</td>
                      <td className="px-3 py-1.5">
                        <span className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${outcomeColors[e.outcome] ?? 'bg-zinc-500/10 text-zinc-700 ring-zinc-500/20'}`}>
                          {e.outcome}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 tabular-nums text-right text-muted-foreground whitespace-nowrap">
                        {e.latencyMs != null ? `${e.latencyMs}ms` : '—'}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground truncate max-w-[280px]" title={e.reason ?? ''}>
                        {e.reason ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
