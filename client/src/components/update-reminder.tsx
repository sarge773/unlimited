import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Sparkles, X } from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogPopup,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Markdown } from '@/components/markdown'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'

const RELEASES_URL = 'https://github.com/tashfeenahmed/freellmapi/releases'
const LATEST_RELEASE_API = 'https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest'

/** How often the dashboard may phone GitHub, so a self-hosted install isn't
 *  making an outbound request on every page load (mirrors the existing
 *  on-demand AppVersionRow: privacy-first, but automatic). */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const STORAGE_KEY = 'freellmapi.update_reminder'

interface LatestRelease {
  tag_name: string
  name: string | null
  body: string | null
  html_url: string
  published_at: string | null
}

interface StoredCheck {
  checkedAt: number
  latestTag: string | null
  dismissedTag: string | null
}

/** Compare two dotted versions; > 0 when `a` is newer. Missing parts read as 0. */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function readStored(): StoredCheck | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) as StoredCheck : null
  } catch {
    return null
  }
}

function writeStored(value: StoredCheck): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch { /* ignore */ }
}

/**
 * Automatic update reminder: checks GitHub's latest release once a day (not on
 * every load), and when a newer version exists shows a small corner pill.
 * Clicking it opens a dialog with the release notes (what's new), a link to
 * the release page, and a per-version dismiss so a release the operator
 * already saw doesn't nag again.
 *
 * Unlike the wordless AppVersionRow, this is an explicit notification the
 * user asked for, so it uses real i18n copy (en is the fallback for every
 * locale, and the release body itself comes untranslated from GitHub).
 */
export function UpdateReminder() {
  const { t } = useI18n()
  const [version, setVersion] = useState<string | null>(null)
  const [release, setRelease] = useState<LatestRelease | null>(null)
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const openRef = useRef(false)
  openRef.current = open

  // Current version: the desktop shell states it outright; a browser or
  // container install asks the server. Both may be empty → no reminder.
  useEffect(() => {
    const shellVersion = typeof window !== 'undefined'
      ? (window as { __FREEAPI_VERSION__?: string | null }).__FREEAPI_VERSION__
      : null
    if (shellVersion) {
      setVersion(shellVersion)
      return
    }
    let cancelled = false
    apiFetch<{ version: string | null }>('/api/settings/version')
      .then(r => { if (!cancelled) setVersion(r.version ?? null) })
      .catch(() => { /* leave hidden */ })
    return () => { cancelled = true }
  }, [])

  // Throttled automatic check. A dialog already open is left alone; otherwise
  // the pill appears only when a genuinely newer release exists.
  useEffect(() => {
    if (!version) return
    let cancelled = false
    const currentVersion = version

    async function check() {
      try {
        const stored = readStored()
        const freshEnough = stored != null
          && Date.now() - stored.checkedAt < CHECK_INTERVAL_MS
          && stored.latestTag != null

        let latestTag = freshEnough ? stored!.latestTag : null
        let body: string | null = null
        let htmlUrl = RELEASES_URL
        let publishedAt: string | null = null

        if (!freshEnough) {
          const res = await fetch(LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } })
          if (!res.ok) return
          const data = await res.json() as LatestRelease
          latestTag = String(data.tag_name ?? '').replace(/^v/, '')
          body = data.body
          htmlUrl = data.html_url || RELEASES_URL
          publishedAt = data.published_at
          writeStored({ checkedAt: Date.now(), latestTag, dismissedTag: stored?.dismissedTag ?? null })
        } else {
          const prev = stored!.latestTag
          // Only refetch the body when the pill is actually tapped; the daily
          // check stays a single lightweight HEAD-equivalent request.
          if (!openRef.current && prev != null && compareVersions(prev, currentVersion) > 0) {
            const res = await fetch(LATEST_RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } })
            if (res.ok) {
              const data = await res.json() as LatestRelease
              body = data.body
              htmlUrl = data.html_url || RELEASES_URL
              publishedAt = data.published_at
            }
          }
        }

        if (!latestTag || compareVersions(latestTag, currentVersion) <= 0) return
        if (cancelled || openRef.current) return
        setDismissed(stored?.dismissedTag ?? null)
        setRelease({ tag_name: latestTag, name: null, body, html_url: htmlUrl, published_at: publishedAt })
      } catch { /* network failure → stay silent */ }
    }

    void check()
    return () => { cancelled = true }
  }, [version])

  if (!release) return null
  if (dismissed === release.tag_name) return null

  const published = release.published_at
    ? new Date(release.published_at).toLocaleDateString()
    : null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 left-4 z-[60] flex max-w-[calc(100vw-2rem)] items-center gap-2 rounded-full border bg-card px-4 py-2 text-sm shadow-lg ring-1 ring-foreground/10 outline-none transition-all duration-150 hover:scale-[1.02] hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 sm:left-6"
      >
        <Sparkles className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="truncate">
          {t('update.available')} <span className="font-semibold tabular-nums">v{version}</span>
          <ArrowUpRight className="ml-1 inline size-3.5" aria-hidden />
          <span className="font-semibold tabular-nums">v{release.tag_name}</span>
        </span>
        <span
          role="button"
          tabIndex={0}
          aria-label={t('update.dismiss')}
          onClick={event => { event.stopPropagation(); setDismissed(release.tag_name) }}
          onKeyDown={event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation()
              setDismissed(release.tag_name)
            }
          }}
          className="ml-1 inline-flex shrink-0 rounded-full text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <X className="size-3.5" aria-hidden />
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup maxWidth="max-w-xl">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <DialogTitle>{t('update.whatsNew', { version: release.tag_name })}</DialogTitle>
              {published && (
                <DialogDescription className="mt-1">{t('update.publishedOn', { date: published })}</DialogDescription>
              )}
            </div>
            <DialogClose className="rounded-full p-1 text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50">
              <X className="size-4" aria-hidden />
            </DialogClose>
          </div>

          {release.body ? (
            <div className="max-h-[45vh] overflow-y-auto rounded-xl border bg-muted/20 p-4">
              <Markdown>{release.body}</Markdown>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('update.noNotes')}</p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <a
              href={release.html_url || RELEASES_URL}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {t('update.openRelease')}
              <ArrowUpRight className="size-4" aria-hidden />
            </a>
            <button
              type="button"
              onClick={() => setDismissed(release.tag_name)}
              className="rounded-lg border px-3.5 py-2 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {t('update.dismissVersion')}
            </button>
          </div>
        </DialogPopup>
      </Dialog>
    </>
  )
}
