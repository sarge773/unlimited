import { useState, type FormEvent } from 'react'
import { Copy } from 'lucide-react'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FieldError } from '@/components/ui/field-error'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'

// #705: the list only ever shows a masked key, and the sole way to read one
// back was to export every key to a file. This narrows that to one key, behind
// the same password re-verification the export uses: a live session is not
// enough to turn a stored credential back into plaintext.

export function CopyKeyDialog({
  keyId,
  maskedKey,
  onOpenChange,
}: {
  keyId: number
  maskedKey: string
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  // Mounted only while open, so the field starts empty every time and the
  // password never outlives the dialog.
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const { key } = await apiFetch<{ key: string }>(`/api/keys/${keyId}/reveal`, {
        method: 'POST',
        headers: { 'x-reauth-password': password },
      })
      await navigator.clipboard.writeText(key)
      toast.success(t('keys.copiedKey'))
      onOpenChange(false)
    } catch (err) {
      // Wrong password and a clipboard the browser refused both land here, and
      // both are things to fix in place rather than behind a closed dialog.
      setError((err as Error).message)
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-md">
        <DialogTitle>{t('keys.copyFullKey')}</DialogTitle>
        <code className="mt-2 block font-mono text-[11px] text-muted-foreground">{maskedKey}</code>

        <form onSubmit={submit} className="mt-4 space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs" htmlFor="reveal-password">{t('auth.password')}</Label>
            <Input
              id="reveal-password"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              aria-invalid={!!error}
            />
            <FieldError error={error} />
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!password || busy}>
              <Copy className="size-3.5" />
              {t('keys.copyKey')}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
