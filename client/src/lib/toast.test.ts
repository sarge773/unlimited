import { describe, expect, it } from 'vitest'
import { getToasts, toast } from './toast'

const EXPLICIT_TOAST_DURATION_MS = 2_500

describe('toast defaults', () => {
  it('keeps non-error notifications visible until the user dismisses them', () => {
    const id = toast.success('Saved settings')
    const item = getToasts().find(t => t.id === id)

    expect(item?.duration).toBeNull()
  })

  it('keeps error notifications visible until the user dismisses them', () => {
    const id = toast.error('Provider request failed after the upstream stream stalled')
    const item = getToasts().find(t => t.id === id)

    expect(item?.duration).toBeNull()
  })

  it('still accepts an explicit auto-dismiss duration', () => {
    const id = toast.info('Short lived update', EXPLICIT_TOAST_DURATION_MS)
    const item = getToasts().find(t => t.id === id)

    expect(item?.duration).toBe(EXPLICIT_TOAST_DURATION_MS)
  })
})
