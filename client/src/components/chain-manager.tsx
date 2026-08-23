import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Layers, Plus, Trash2 } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Tooltip } from '@/components/tooltip'

// Named fallback chains (#960/#895). Backend /api/profiles CRUD is complete
// and #986 exposes every chain as an `auto:<name>` model in /v1/models; this
// panel is the missing dashboard surface: list chains, create new ones,
// switch the active chain (the fallback table below then edits that chain),
// and delete custom ones.

interface Chain {
  id: number
  name: string
  emoji: string
  color: string
  type: 'default' | 'builtin' | 'custom'
  is_favorite: number
  sort_order: number
  auto_sort: string | null
  layout_config: string | null
  created_at: string
}

export function ChainManager() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [newName, setNewName] = useState('')

  const { data: chains = [] } = useQuery<Chain[]>({
    queryKey: ['profiles'],
    queryFn: () => apiFetch('/api/profiles'),
  })
  const { data: active } = useQuery<{ activeProfileId: number | null }>({
    queryKey: ['profiles', 'active'],
    queryFn: () => apiFetch('/api/profiles/active'),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['profiles'] })
    queryClient.invalidateQueries({ queryKey: ['profiles', 'active'] })
    // The fallback table renders the active chain; refresh it too.
    queryClient.invalidateQueries({ queryKey: ['fallback'] })
    queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] })
  }

  const createChain = useMutation({
    mutationFn: (name: string) =>
      apiFetch('/api/profiles', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: () => {
      invalidate()
      setNewName('')
    },
  })
  const setActive = useMutation({
    mutationFn: (profileId: number) =>
      apiFetch('/api/profiles/active', { method: 'POST', body: JSON.stringify({ profileId }) }),
    onSuccess: invalidate,
  })
  const deleteChain = useMutation({
    mutationFn: (profileId: number) =>
      apiFetch(`/api/profiles/${profileId}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  if (chains.length === 0) return null

  const activeId = active?.activeProfileId ?? null

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Layers className="size-4 text-muted-foreground" />
            {t('chains.title')}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('chains.description')}</p>
        </div>
      </div>

      <div className="space-y-2">
        {chains.map(chain => {
          const isActive = chain.id === activeId
          const isProtected = chain.type === 'default' || chain.type === 'builtin'
          return (
            <div
              key={chain.id}
              className={`flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 ${
                isActive ? 'border-foreground/25 bg-muted/50' : 'border-transparent hover:bg-muted/40'
              }`}
            >
              <span
                className="flex items-center gap-1.5 text-sm font-medium"
                title={chain.name}
              >
                {chain.emoji || <Layers className="size-3.5 text-muted-foreground" />}
                <span className="truncate">{chain.name}</span>
              </span>
              {isActive && (
                <Badge variant="secondary" className="gap-1">
                  <Check className="size-3" />
                  {t('chains.active')}
                </Badge>
              )}
              {isProtected && !isActive && (
                <span className="text-[11px] text-muted-foreground">{t('chains.default')}</span>
              )}
              <span className="flex-1" />
              {!isActive && (
                <Tooltip text={t('chains.activateHint')}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={setActive.isPending}
                    onClick={() => setActive.mutate(chain.id)}
                  >
                    {t('chains.activate')}
                  </Button>
                </Tooltip>
              )}
              {!isProtected && (
                <Tooltip text={t('chains.deleteHint')}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-muted-foreground hover:text-rose-600"
                    disabled={deleteChain.isPending}
                    onClick={() => {
                      if (window.confirm(t('chains.deleteConfirm', { name: chain.name }))) {
                        deleteChain.mutate(chain.id)
                      }
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </Tooltip>
              )}
            </div>
          )
        })}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={e => {
          e.preventDefault()
          const name = newName.trim()
          if (name && !createChain.isPending) createChain.mutate(name)
        }}
      >
        <Input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder={t('chains.createPlaceholder')}
          aria-label={t('chains.createPlaceholder')}
          className="h-8"
        />
        <Button type="submit" size="sm" className="h-8" disabled={!newName.trim() || createChain.isPending}>
          <Plus className="size-3.5" />
          {t('chains.create')}
        </Button>
      </form>
    </section>
  )
}
