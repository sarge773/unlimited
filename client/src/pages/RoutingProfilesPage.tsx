import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Layers3, Plus, TriangleAlert } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmButton } from '@/components/confirm-button'
import { EmptyState } from '@/components/empty-state'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'

// Routing profiles (#1026): named capability groups ("coding", "fast", …)
// clients send AS the model id. The server expands each profile into a strict,
// priority-ordered failover chain across different logical models; this page is
// the operator's editor for those chains.
//
// Strings here are intentionally NOT routed through i18n yet: the repo's
// check-i18n gate requires every key to exist in all 60 locale files, and no
// translations exist for these strings. Hardcoded English keeps that gate
// green with a zero-locale-diff; when translations are contributed, move these
// into src/i18n/locales/*.json under "routingProfiles" and swap in useI18n().
const STR = {
  title: 'Routing Profiles',
  subtitle: 'Named capability groups clients can send as the model id — each expands into a strict, priority-ordered failover chain across different models.',
  empty: 'No routing profiles yet',
  emptyHint: 'Create one (e.g. "coding") and list models in fallback order. Clients then request model: "coding".',
  create: 'New Profile',
  creating: 'Creating…',
  slugLabel: 'Slug (used as the model id)',
  slugHint: 'Use lowercase letters, digits, hyphens and underscores.',
  nameLabel: 'Display name',
  descLabel: 'Description (optional)',
  membersHeading: 'Members (tried in order)',
  addModelPlaceholder: 'model id, group slug or platform:model_id',
  addModel: 'Add',
  moveUp: 'Move up',
  moveDown: 'Move down',
  removeMember: 'Remove member',
  deleteProfile: 'Delete profile',
  unresolvedWarning: (refs: string) => `These members match no model and will be skipped: ${refs}`,
  requestHint: (slug: string) => `Call it with "model": "${slug}"`,
  createFailed: 'Could not create the profile.',
}

interface ProfileModel {
  ref: string
  priority: number
}

interface RoutingProfile {
  slug: string
  name: string
  description: string
  models: ProfileModel[]
  unresolvedRefs?: string[]
}

interface CatalogModel {
  id: number
  modelId: string
  platform: string
  displayName: string
  qualifiedModelId: string | null
}

const SLUG_RE = /^[a-z0-9][a-z0-9-_]*$/

export default function RoutingProfilesPage() {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const profiles = useQuery({
    queryKey: ['routing-profiles'],
    queryFn: () => apiFetch<RoutingProfile[]>('/api/routing-profiles'),
  })
  const models = useQuery({
    queryKey: ['models-for-profiles'],
    queryFn: () => apiFetch<CatalogModel[]>('/api/models'),
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['routing-profiles'] })
  }

  const createMut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/api/routing-profiles', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setSlug(''); setName(''); setDescription(''); setCreating(false); setFormError(null)
      invalidate()
    },
    onError: (e: Error) => setFormError(e.message || STR.createFailed),
  })

  const updateMut = useMutation({
    mutationFn: ({ slug: s, ...body }: { slug: string } & Record<string, unknown>) =>
      apiFetch(`/api/routing-profiles/${encodeURIComponent(s)}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  })

  const deleteMut = useMutation({
    mutationFn: (s: string) =>
      apiFetch(`/api/routing-profiles/${encodeURIComponent(s)}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  const submitCreate = () => {
    if (!SLUG_RE.test(slug)) { setFormError(STR.slugHint); return }
    if (!name.trim()) { setFormError(STR.nameLabel); return }
    createMut.mutate({ slug, name: name.trim(), description: description.trim(), models: [] })
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <ModelsTabs />
      <div className="h-4" />
      <PageHeader
        title={STR.title}
        description={STR.subtitle}
        actions={
          !creating && (
            <Button onClick={() => { setCreating(true); setFormError(null) }}>
              <Plus className="size-4" />{STR.create}
            </Button>
          )
        }
      />

      {creating && (
        <div className="rounded-xl border p-4 mb-4 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-muted-foreground">{STR.slugLabel}</span>
              <Input value={slug} onChange={e => setSlug(e.target.value)} placeholder="coding" className="mt-1" />
              <span className="text-xs text-muted-foreground">{STR.slugHint}</span>
            </label>
            <label className="block text-sm">
              <span className="text-muted-foreground">{STR.nameLabel}</span>
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Coding" className="mt-1" />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-muted-foreground">{STR.descLabel}</span>
            <Input value={description} onChange={e => setDescription(e.target.value)} className="mt-1" />
          </label>
          {formError && <p className="text-sm text-destructive">{formError}</p>}
          <div className="flex gap-2">
            <Button onClick={submitCreate} disabled={createMut.isPending}>
              {createMut.isPending ? STR.creating : STR.create}
            </Button>
            <Button variant="outline" onClick={() => { setCreating(false); setFormError(null) }}>Cancel</Button>
          </div>
        </div>
      )}

      {profiles.isLoading ? null : !profiles.data?.length ? (
        <EmptyState
          icon={Layers3}
          title={STR.empty}
          description={STR.emptyHint}
        />
      ) : (
        <div className="space-y-4">
          {profiles.data.map(profile => (
            <ProfileCard
              key={profile.slug}
              profile={profile}
              models={models.data ?? []}
              onUpdate={body => updateMut.mutate({ slug: profile.slug, ...body })}
              onDelete={() => deleteMut.mutate(profile.slug)}
              saving={updateMut.isPending}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ProfileCard({
  profile,
  models,
  onUpdate,
  onDelete,
  saving,
}: {
  profile: RoutingProfile
  models: CatalogModel[]
  onUpdate: (body: Record<string, unknown>) => void
  onDelete: () => void
  saving: boolean
}) {
  const [ref, setRef] = useState('')
  const members = [...profile.models].sort((a, b) => a.priority - b.priority)

  const addMember = () => {
    const candidate = ref.trim()
    if (!candidate) return
    // Priority slots are spaced by 10 so reordering never collides.
    const nextPriority = members.length ? Math.max(...members.map(m => m.priority)) + 10 : 10
    onUpdate({ models: [...profile.models, { ref: candidate, priority: nextPriority }] })
    setRef('')
  }

  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir
    if (target < 0 || target >= members.length) return
    const next = [...members]
    ;[next[index], next[target]] = [next[target], next[index]]
    onUpdate({ models: next.map((m, i) => ({ ...m, priority: (i + 1) * 10 })) })
  }

  const removeAt = (index: number) => {
    onUpdate({ models: members.filter((_, i) => i !== index).map((m, i) => ({ ...m, priority: (i + 1) * 10 })) })
  }

  return (
    <div className="rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-medium truncate">{profile.name}</h2>
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{profile.slug}</code>
          </div>
          {profile.description && (
            <p className="text-sm text-muted-foreground mt-0.5">{profile.description}</p>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            {STR.requestHint(profile.slug)}
          </p>
        </div>
        <ConfirmButton
          onConfirm={onDelete}
          variant="ghost"
          size="xs"
          className="text-destructive hover:text-destructive"
          aria-label={STR.deleteProfile}
        >
          {STR.deleteProfile}
        </ConfirmButton>
      </div>

      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mt-4 mb-2">
        {STR.membersHeading} {saving && '…'}
      </h3>

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">{STR.empty}</p>
      ) : (
        <ol className="space-y-1">
          {members.map((member, i) => (
            <li key={`${member.ref}-${member.priority}`} className="flex items-center gap-2 rounded-lg border px-3 py-2">
              <span className="w-5 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
              <code className="text-sm truncate min-w-0 flex-1">{member.ref}</code>
              <Button variant="ghost" size="icon-xs" disabled={i === 0} aria-label={STR.moveUp} onClick={() => move(i, -1)}>
                <ArrowUp className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon-xs" disabled={i === members.length - 1} aria-label={STR.moveDown} onClick={() => move(i, 1)}>
                <ArrowDown className="size-3.5" />
              </Button>
              <ConfirmButton onConfirm={() => removeAt(i)} size="xs" aria-label={STR.removeMember}>
                ✕
              </ConfirmButton>
            </li>
          ))}
        </ol>
      )}

      {profile.unresolvedRefs && profile.unresolvedRefs.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <TriangleAlert className="size-3.5 mt-0.5 shrink-0" />
          {STR.unresolvedWarning(profile.unresolvedRefs.join(', '))}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        <Input
          list={`model-refs-${profile.slug}`}
          value={ref}
          onChange={e => setRef(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addMember() }}
          placeholder={STR.addModelPlaceholder}
          className="h-8 text-sm"
        />
        <datalist id={`model-refs-${profile.slug}`}>
          {models.slice(0, 500).map(m => (
            <option key={m.id} value={m.qualifiedModelId || `${m.platform}:${m.modelId}`}>
              {m.displayName}
            </option>
          ))}
        </datalist>
        <Button variant="outline" size="sm" onClick={addMember} disabled={!ref.trim()}>
          {STR.addModel}
        </Button>
      </div>
    </div>
  )
}
