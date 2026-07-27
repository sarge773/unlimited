import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Plus, Trash2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PROFILE_GLYPHS, profileGlyph } from '@/lib/profile-glyph'
import { useProfile, type ApiProfile } from '@/profile-context'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { UnifiedKeySection } from '@/components/keys/unified-key-section'
import { ProxySettingsSection } from '@/components/keys/proxy-settings-section'

function GlyphSelect({
  value,
  onChange,
  label,
  triggerClassName = 'mt-1 w-full',
}: {
  value: string
  onChange: (value: string) => void
  label: string
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={`flex h-8 items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 ${triggerClassName}`}
        aria-label={label}
      >
        <span className="text-lg leading-none">{value}</span>
        <ChevronDown className="size-4 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="mb-2 text-xs font-medium">Choose an icon</div>
        <div className="grid max-h-64 grid-cols-8 gap-1 overflow-y-auto pr-1" role="listbox" aria-label={label}>
          {PROFILE_GLYPHS.map(option => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={value === option.value}
              aria-label={option.label}
              title={option.label}
              className={`flex size-7 items-center justify-center rounded-md text-base leading-none outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring ${value === option.value ? 'bg-accent ring-1 ring-foreground/20' : ''}`}
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.value}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ProfileCard({ profile }: { profile: ApiProfile }) {
  const queryClient = useQueryClient()
  const { active, select } = useProfile()
  const [expanded, setExpanded] = useState(active?.id === profile.id)
  const [name, setName] = useState(profile.name)
  const [slug, setSlug] = useState(profile.slug)
  const [emoji, setEmoji] = useState(profileGlyph(profile))
  useEffect(() => {
    if (active?.id !== profile.id) return
    const timer = window.setTimeout(() => setExpanded(true), 0)
    return () => window.clearTimeout(timer)
  }, [active?.id, profile.id])
  const remove = useMutation({
    mutationFn: () => apiFetch(`/api/profiles/${profile.id}`, {
      method: 'DELETE',
      headers: { 'X-Skip-Profile': '1' },
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profiles'] }),
  })
  const update = useMutation({
    mutationFn: () => apiFetch<ApiProfile>(`/api/profiles/${profile.id}`, {
      method: 'PUT',
      headers: { 'X-Skip-Profile': '1' },
      body: JSON.stringify(profile.type === 'default' ? {} : {
        name: name.trim(),
        slug: slug.trim(),
        emoji,
      }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profiles'] }),
  })
  const baseUrl = `${window.location.origin}${profile.type === 'default' ? '' : `/${profile.slug}`}/v1`
  const detailsId = `profile-${profile.id}-details`
  const isSelected = active?.id === profile.id
  const isUnchanged = name === profile.name && slug === profile.slug && emoji === profileGlyph(profile)

  return (
    <section className={`overflow-hidden rounded-3xl border bg-card transition-colors duration-300 ${expanded ? 'border-foreground/20' : ''}`}>
      <div className={`flex items-center gap-3 p-5 transition-colors duration-300 ${expanded ? 'bg-muted/20' : ''}`}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(value => !value)}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background font-mono text-base">
            {profileGlyph(profile)}
          </span>
          <div className="min-w-0">
            <div className="font-medium">{profile.name}</div>
            <code className="block truncate text-xs text-muted-foreground">{baseUrl}</code>
          </div>
          <ChevronDown className={`ms-auto size-4 shrink-0 text-muted-foreground transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
        </button>
        <Button variant={isSelected ? 'default' : 'outline'} size="sm" onClick={() => {
          select(profile.id)
          setExpanded(true)
        }}>
          {isSelected ? 'Selected' : 'View profile'}
        </Button>
      </div>

      <div
        id={detailsId}
        className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t">
            <section className="border-b bg-muted/10 p-5 sm:p-6">
              <div className="grid gap-3 sm:grid-cols-[7rem_1fr_1fr]">
                <label className="text-xs text-muted-foreground">
                  Icon
                  {profile.type === 'default' ? (
                    <div className="mt-1 flex h-8 items-center rounded-lg border border-input bg-muted/40 px-2.5 font-mono text-base text-foreground">◎</div>
                  ) : (
                    <GlyphSelect value={emoji} onChange={setEmoji} label={`Icon for ${profile.name}`} />
                  )}
                </label>
                <label className="text-xs text-muted-foreground">
                  Name
                  <Input className="mt-1 text-foreground" value={name} disabled={profile.type === 'default'} onChange={e => setName(e.target.value)} />
                </label>
                <label className="text-xs text-muted-foreground">
                  URL slug
                  <Input className="mt-1 font-mono text-foreground" value={slug} disabled={profile.type === 'default'} onChange={e => setSlug(e.target.value.toLowerCase())} />
                </label>
              </div>
              {profile.type !== 'default' && (
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!name.trim() || !slug.trim() || update.isPending || isUnchanged}
                    onClick={() => update.mutate()}
                  >
                    Save profile details
                  </Button>
                  <Button variant="destructive" size="sm" disabled={remove.isPending} onClick={() => {
                    if (confirm(`Delete profile “${profile.name}”? Its API key will stop working immediately.`)) remove.mutate()
                  }}>
                    <Trash2 /> Delete profile
                  </Button>
                </div>
              )}
            </section>

            <div className="divide-y divide-border/70">
              <UnifiedKeySection profile={profile} embedded />
              <ProxySettingsSection profile={profile} embedded />
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

export default function ProfilesPage() {
  const queryClient = useQueryClient()
  const { profiles, active, select } = useProfile()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [emoji, setEmoji] = useState<string>(PROFILE_GLYPHS[0].value)
  const create = useMutation({
    mutationFn: () => apiFetch<ApiProfile>('/api/profiles', {
      method: 'POST',
      headers: { 'X-Skip-Profile': '1' },
      body: JSON.stringify({ name: name.trim(), slug: slug.trim(), emoji, sourceProfileId: active?.id }),
    }),
    onSuccess: profile => {
      setName('')
      setSlug('')
      setEmoji(PROFILE_GLYPHS[0].value)
      void queryClient.invalidateQueries({ queryKey: ['profiles'] })
      localStorage.setItem('freellmapi.activeProfileId', String(profile.id))
      select(profile.id)
    },
  })

  return (
    <div>
      <PageHeader title="Profiles" description="Independent API workspaces with their own URL, key, models, and behavior." />
      <section className="mb-6 grid gap-2 rounded-2xl border bg-card p-4 sm:grid-cols-[7rem_1fr_1fr_auto]">
        <GlyphSelect value={emoji} onChange={setEmoji} label="New profile icon" triggerClassName="w-full" />
        <Input value={name} onChange={e => {
          const next = e.target.value
          setName(next)
          setSlug(next.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40))
        }} placeholder="Profile name, e.g. Coding" />
        <Input className="font-mono" value={slug} onChange={e => setSlug(e.target.value.toLowerCase())} placeholder="URL slug, e.g. coding" />
        <Button disabled={!name.trim() || !slug.trim() || create.isPending} onClick={() => create.mutate()}><Plus /> Create from current</Button>
      </section>
      <div className="space-y-4">{profiles.map(profile => <ProfileCard key={profile.id} profile={profile} />)}</div>
    </div>
  )
}
