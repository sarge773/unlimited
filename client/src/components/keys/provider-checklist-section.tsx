import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Check, X } from 'lucide-react'
import { useI18n } from '@/i18n'

// Shape of GET /api/keys/providers (#543). Declared inline: the backend owns
// the contract (server/src/routes/keys.ts) and this is the only consumer.
interface ProviderChecklistEntry {
  platform: string
  name: string
  keyless: boolean
  configured: boolean
  keyCount: number
  enabledKeyCount: number
}
interface ProvidersChecklist {
  providers: ProviderChecklistEntry[]
  summary: { total: number; configured: number; unconfigured: number }
}

// At-a-glance list of every built-in provider and whether a key has been added
// yet, so you can see what's left to set up without scrolling the key manager
// below and enumerating by hand (#543).
export function ProviderChecklistSection() {
  const { t } = useI18n()
  const { data, isLoading } = useQuery<ProvidersChecklist>({
    queryKey: ['keys-providers'],
    queryFn: () => apiFetch('/api/keys/providers'),
  })

  if (isLoading) return <TableSkeleton rows={3} />
  if (!data || data.providers.length === 0) return null

  const { providers, summary } = data

  return (
    <div className="mb-8">
      <div className="mb-3">
        <h3 className="text-sm font-medium">{t('keys.checklistTitle')}</h3>
        <p className="text-xs text-muted-foreground">
          {t('keys.checklistSummary', { configured: summary.configured, total: summary.total })}
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {providers.map(p => (
          <div
            key={p.platform}
            className="flex items-center gap-2.5 rounded-xl border bg-card px-3 py-2"
          >
            {p.configured ? (
              <Check className="size-4 flex-shrink-0 text-emerald-500" />
            ) : (
              <X className="size-4 flex-shrink-0 text-muted-foreground" />
            )}
            <span className={`truncate text-sm ${p.configured ? '' : 'text-muted-foreground'}`}>
              {p.name}
            </span>
            {p.keyless && (
              <Badge variant="outline" className="ml-auto">
                {t('keys.checklistKeyless')}
              </Badge>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
