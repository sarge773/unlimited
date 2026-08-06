import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { FieldError } from '@/components/ui/field-error'
import { Check, ChevronsUpDown, Search } from 'lucide-react'
import type { ApiKey, Platform } from '../../../../shared/types'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { GetKeyLink, PLATFORMS } from './shared'

// The "Provider key" pane of the Add key dialog: paste a credential for a known
// provider. Extracted verbatim from the old inline KeysPage form so all field
// validation, the keyless/Cloudflare special cases, and the POST /api/keys
// mutation stay identical. On success it toasts and asks the dialog to close.
// `initialPlatform` preselects the provider (checklist-chip entry); the field
// stays editable. The dialog remounts this pane per open, so a plain initial
// state is enough.
export function AddKeyForm({ onSuccess, initialPlatform }: { onSuccess: () => void; initialPlatform?: Platform }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<Platform | ''>(initialPlatform ?? '')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')
  const [addAttempted, setAddAttempted] = useState(false)
  // Several credentials for one provider in one go (#705). Pooling keys is the
  // point of this app, and the only bulk path was the file importer, so anyone
  // holding five Groq keys reopened this dialog five times. Off by default: the
  // single-key field masks what you type, and a textarea cannot.
  const [several, setSeveral] = useState(false)

  // #707: the platform dropdown had no filter, no order, and no way to skip
  // providers that already have keys. Sort alphabetically, filter by the
  // search box, and optionally hide already-added providers. Reuses the same
  // ['keys'] query the Providers tab owns, so this costs no extra request.
  const { data: keys = [] } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })
  const addedPlatforms = useMemo(() => new Set(keys.map(k => k.platform)), [keys])
  const [platformSearch, setPlatformSearch] = useState('')
  const [hideAdded, setHideAdded] = useState(false)
  const [platformOpen, setPlatformOpen] = useState(false)

  const visiblePlatforms = useMemo(() => {
    const q = platformSearch.trim().toLowerCase()
    return [...PLATFORMS]
      .sort((a, b) => a.label.localeCompare(b.label))
      .filter(p =>
        (!hideAdded || !addedPlatforms.has(p.value)) &&
        (q === '' || p.label.toLowerCase().includes(q) || p.value.toLowerCase().includes(q)),
      )
  }, [platformSearch, hideAdded, addedPlatforms])

  const addKey = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch<{ notice?: string | null }>('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['keys-providers'] })
      toast.success(t('keys.keyAdded'))
      // Server notice when the key is for a platform with no models in the
      // current catalog tier yet (#438) — surfaced as a toast now that the
      // dialog closes on success.
      if (data?.notice) toast.info(data.notice)
      onSuccess()
    },
  })

  // Reuses the bulk endpoint the file importer already posts to, which dedupes
  // against every stored key and reports per-key failures.
  const addSeveral = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: { keys: { platform: string; keyName?: string; keyValue: string }[] }) =>
      apiFetch<{ imported: number; total: number; errors: { key: string; error: string }[] }>(
        '/api/keys/import-selected', { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: (data) => {
      for (const key of ['keys', 'health', 'fallback', 'keys-providers']) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      toast.success(t('keys.importResult', { imported: data.imported, failed: data.total - data.imported }))
      onSuccess()
    },
  })

  const needsAccountId = platform === 'cloudflare'
  const isKeyless = PLATFORMS.find(p => p.value === platform)?.keyless ?? false
  // Cloudflare pairs each token with an account id, and keyless providers have
  // nothing to paste, so neither can take a list.
  const canPasteSeveral = !isKeyless && !needsAccountId
  const severalMode = several && canPasteSeveral
  // One per line or comma-separated, deduped, blanks dropped.
  const keyList = severalMode
    ? [...new Set(apiKey.split(/[\n,]+/).map(s => s.trim()).filter(Boolean))]
    : []

  // Field-level validation: the submit stays clickable and reveals what is
  // missing instead of being silently disabled.
  const platformError = !platform ? t('validation.required') : null
  const keyError = severalMode
    ? (keyList.length === 0 ? t('validation.required') : null)
    : (!isKeyless && !apiKey.trim() ? t('validation.required') : null)
  const accountIdError = needsAccountId && !accountId.trim() ? t('validation.required') : null
  const pending = addKey.isPending || addSeveral.isPending

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (platformError || keyError || accountIdError) {
      setAddAttempted(true)
      return
    }
    setAddAttempted(false)
    if (severalMode) {
      addSeveral.mutate({
        keys: keyList.map(keyValue => ({ platform, keyValue, keyName: label || undefined })),
      })
      return
    }
    // Keyless providers submit an empty key; the backend stores a sentinel.
    const key = isKeyless ? '' : (needsAccountId ? `${accountId}:${apiKey}` : apiKey)
    addKey.mutate({ platform, key, label: label || undefined })
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex flex-wrap gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.platform')}</Label>
          <Popover open={platformOpen} onOpenChange={o => { setPlatformOpen(o); if (!o) setPlatformSearch('') }}>
            <PopoverTrigger
              className="flex h-8 w-[220px] items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive dark:bg-input/30"
              aria-invalid={addAttempted && !!platformError}
              aria-label={t('keys.platform')}
            >
              <span className={`truncate ${platform ? '' : 'text-muted-foreground'}`}>
                {PLATFORMS.find(p => p.value === platform)?.label ?? t('keys.selectPlatform')}
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[300px] p-0">
              <div className="flex items-center gap-2 border-b px-3">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  value={platformSearch}
                  onChange={e => setPlatformSearch(e.target.value)}
                  placeholder={t('keys.filterPlaceholder')}
                  aria-label={t('keys.filterPlaceholder')}
                  className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <input
                  id="hide-added-platforms"
                  type="checkbox"
                  checked={hideAdded}
                  onChange={e => setHideAdded(e.target.checked)}
                  className="size-3.5 accent-foreground"
                />
                <label htmlFor="hide-added-platforms" className="text-xs text-muted-foreground">
                  {t('common.hide')} {t('keys.discoverAlreadyAdded')}
                </label>
              </div>
              <div className="max-h-72 overflow-y-auto p-1">
                {visiblePlatforms.length === 0 ? (
                  <div className="px-2 py-6 text-center text-xs text-muted-foreground">{t('keys.noFilterMatch')}</div>
                ) : (
                  visiblePlatforms.map(p => {
                    const added = addedPlatforms.has(p.value)
                    return (
                      <button
                        key={p.value}
                        type="button"
                        onClick={() => { setPlatform(p.value); setPlatformOpen(false); setPlatformSearch('') }}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${p.value === platform ? 'bg-accent/50' : ''}`}
                      >
                        <Check className={`size-4 shrink-0 ${p.value === platform ? 'opacity-100' : 'opacity-0'}`} />
                        <span className="min-w-0 flex-1 truncate">{p.label}</span>
                        {added && (
                          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                            {t('keys.discoverAlreadyAdded')}
                          </span>
                        )}
                      </button>
                    )
                  })
                )}
              </div>
            </PopoverContent>
          </Popover>
          {addAttempted && <FieldError error={platformError} />}
          {(() => {
            const sel = PLATFORMS.find(p => p.value === platform)
            return sel?.url ? <div className="pt-0.5"><GetKeyLink url={sel.url} /></div> : null
          })()}
        </div>
        {needsAccountId && (
          <div className="space-y-1.5">
            <Label className="text-xs">{t('keys.accountId')}</Label>
            <Input
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              placeholder="a1b2c3d4…"
              className="w-[200px] font-mono text-xs"
              aria-invalid={addAttempted && !!accountIdError}
            />
            {addAttempted && <FieldError error={accountIdError} />}
          </div>
        )}
        <div className="space-y-1.5 flex-1 min-w-[240px]">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">{needsAccountId ? t('keys.apiToken') : t('keys.customApiKey')}</Label>
            {canPasteSeveral && (
              <button
                type="button"
                onClick={() => setSeveral(v => !v)}
                className={`text-[11px] underline-offset-2 hover:underline ${severalMode ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t('keys.pasteSeveral')}
              </button>
            )}
          </div>
          {severalMode ? (
            <Textarea
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={'gsk_first…\ngsk_second…'}
              rows={3}
              className="font-mono text-xs"
              aria-invalid={addAttempted && !!keyError}
            />
          ) : (
            <Input
              type="password"
              value={isKeyless ? '' : apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={isKeyless ? t('keys.noKeyNeededPlaceholder') : (needsAccountId ? t('keys.bearerTokenPlaceholder') : t('keys.pasteKeyPlaceholder'))}
              className="font-mono text-xs"
              disabled={isKeyless}
              aria-invalid={addAttempted && !!keyError}
            />
          )}
          {addAttempted && <FieldError error={keyError} />}
          {isKeyless && (
            <p className="text-[11px] text-muted-foreground">
              {t('keys.keylessHint')}
            </p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.label')}</Label>
          <div className="flex flex-wrap items-center space-x-3">
            <Input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder={t('keys.customDisplayNameOptional')}
              className="w-[160px]"
            />
            <Button type="submit" size="sm" disabled={pending}>
              {pending
                ? t('keys.adding')
                : severalMode && keyList.length > 1
                  ? t('keys.importSelected', { count: keyList.length })
                  : isKeyless ? t('keys.enable') : t('keys.addKey')}
            </Button>
          </div>
        </div>
      </form>
      {(addKey.isError || addSeveral.isError) && (
        <p className="text-destructive text-xs mt-2">{((addKey.error ?? addSeveral.error) as Error).message}</p>
      )}
    </div>
  )
}
