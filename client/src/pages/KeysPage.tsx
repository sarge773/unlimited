import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { PageHeader } from '@/components/page-header'
import type { ApiKey, Platform } from '../../../shared/types'
import { Plus, Download } from 'lucide-react'
import { useI18n } from '@/i18n'
import type { HealthData } from '@/components/keys/shared'
import { QuotaSignalsSection } from '@/components/keys/quota-signals-section'
import { UnifiedKeySection } from '@/components/keys/unified-key-section'
import { ClientProfilesSection } from '@/components/keys/client-profiles-section'
import { ProxySettingsSection } from '@/components/keys/proxy-settings-section'
import { BackupsSection } from '@/components/keys/backups-section'
import { ProviderList } from '@/components/keys/provider-list'
import { ProviderChecklistSection } from '@/components/keys/provider-checklist-section'
import { AddKeyDialog } from '@/components/keys/add-key-dialog'
import { ExportKeysDialog } from '@/components/keys/export-keys-dialog'
import { AgentCompatibilitySection } from '@/components/keys/agent-compatibility-section'

type KeysTab = 'providers' | 'quotaSignals' | 'apiKey' | 'anthropic' | 'agents'
const KEYS_TABS: { id: KeysTab; labelKey: string }[] = [
  { id: 'providers', labelKey: 'keys.tabProviders' },
  { id: 'quotaSignals', labelKey: 'keys.tabQuotaSignals' },
  { id: 'apiKey', labelKey: 'keys.tabApiKey' },
  { id: 'anthropic', labelKey: 'keys.tabAnthropic' },
  { id: 'agents', labelKey: 'keys.tabAgents' },
]

type DegradationOverride = 'auto' | 'normal' | 'degraded'

  const queryClient = useQueryClient()
  const [tab, setTab] = useState<KeysTab>('providers')
  const [addOpen, setAddOpen] = useState(false)
  // Provider the Add key dialog opens preselected to, when the add flow was
  // entered from a checklist chip rather than the generic Add key button.
  const [addPlatform, setAddPlatform] = useState<Platform | ''>('')
  const [exportOpen, setExportOpen] = useState(false)

  const openAddKey = (platform: Platform | '' = '') => {
    setAddPlatform(platform)
    setAddOpen(true)
  }

  // Kept at page level for the header's "Check all" gate; ProviderList runs the
  // same query (deduped by react-query) for the list itself.
  const { data: keys = [] } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: 30000,
  })

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  // #952: manual override for the degraded-mode machine. The health pass flips
  // the gateway into degraded mode when a large share of providers fails at
  // once; an operator who has fixed the cause (or whose fleet is too small for
  // the automatic flip) can pin the gateway out of it here.
  const setDegradation = useMutation({
    mutationFn: (override: DegradationOverride) =>
      apiFetch('/api/health/degradation', { method: 'POST', body: JSON.stringify({ override }) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })

  const degradation = healthData?.degradation
  const degradedNow = degradation?.state === 'degraded' || degradation?.override === 'degraded'

            )}
            {tab === 'providers' && (
              <Button size="sm" onClick={() => openAddKey()}>
                <Plus className="size-3.5" />
                {t('keys.addKey')}
              </Button>
            )}
            <SegmentedControl
              value={tadiff3: invalid print range
b}
              onValueChange={setTab}
              options={KEYS_TABS.map(tb => ({ value: tb.id, label: t(tb.labelKey) }))}
              ariaLabel={t('keys.pageTitle')}
            />
          </>
        }
      />

      <div className="space-y-8">
        {degradation && tab === 'providers' && (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                <span className={degradedNow ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}>
                  {degradedNow ? t('keys.degradedActive') : t('keys.degradedNormal')}
                </span>
                {degradation.override !== 'auto' && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    {t('keys.degradedOverride', { mode: degradation.override })}
                  </span>
                )}
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('keys.degradedSummary', {
                  healthy: degradation.healthyProviders,
                  total: degradation.totalProviders,
                  pct: Math.round(degradation.ratio * 100),
                })}
              </p>
            </div>
            <span className="flex-1" />
            <SegmentedControl
              value={degradation.override}
              onValueChange={value => setDegradation.mutate(value as DegradationOverride)}
              disabled={setDegradation.isPending}
              options={[
                { value: 'auto', label: t('keys.degradedAuto') },
                { value: 'normal', label: t('keys.degradedForceNormal') },
                { value: 'degraded', label: t('keys.degradedForceDegraded') },
              ]}
              ariaLabel={t('keys.degradedActive')}
            />
          </div>
        )}

