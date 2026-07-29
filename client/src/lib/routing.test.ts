import { describe, it, expect } from 'vitest'
import { memberProviderLabel, memberEndpointTitle, memberOverrideKey, providerPinId } from './routing'

// Per-endpoint identity must be INVISIBLE until two endpoints actually serve the
// same model id (#651). The server sends `endpointScope` / `qualifiedModelId` on
// every custom row — including the only relay of a one-endpoint install — so any
// gate written against those fields alone leaks the user's own base URL. These
// cases pin the gate to the collision itself.

type R = {
  platform: string; modelId: string; source?: 'catalog' | 'custom'
  keyLabel?: string | null; endpointScope?: string | null; qualifiedModelId?: string | null
  displayName?: string
}

const soloRelay: R = {
  platform: 'custom', modelId: 'deepseek-v3.1', source: 'custom', keyLabel: 'Custom',
  endpointScope: 'http://192.168.1.50:11434/v1',
  qualifiedModelId: 'custom:deepseek-v3.1#192.168.1.50-11434-v1',
}
const relayA: R = {
  platform: 'custom', modelId: 'deepseek-v3.1', source: 'custom', keyLabel: 'Relay A',
  endpointScope: 'https://relay-a.example.com/v1',
  qualifiedModelId: 'custom:deepseek-v3.1#relay-a.example.com-v1',
}
const relayB: R = {
  platform: 'custom', modelId: 'deepseek-v3.1', source: 'custom', keyLabel: 'Relay B',
  endpointScope: 'https://relay-b.example.com/v1',
  qualifiedModelId: 'custom:deepseek-v3.1#relay-b.example.com-v1',
}
const catalog: R = { platform: 'groq', modelId: 'llama-3.3-70b', source: 'catalog' }

describe('single-endpoint install stays un-qualified', () => {
  it('labels the lone relay by its key label only', () => {
    expect(memberProviderLabel(soloRelay, [soloRelay])).toBe('Custom')
  })

  it('reveals no endpoint URL on hover', () => {
    expect(memberEndpointTitle(soloRelay, [soloRelay])).toBeUndefined()
  })

  it('offers the bare model id, never the qualified one', () => {
    expect(providerPinId(soloRelay, [soloRelay])).toBe('deepseek-v3.1')
  })

  it('leaves catalog rows entirely alone', () => {
    expect(memberProviderLabel(catalog, [catalog, soloRelay])).toBe('groq')
    expect(memberEndpointTitle(catalog, [catalog, soloRelay])).toBeUndefined()
  })
})

describe('two endpoints serving one model id', () => {
  const both = [relayA, relayB]

  it('appends the endpoint to each label', () => {
    expect(memberProviderLabel(relayA, both)).toBe('Relay A · relay-a.example.com/v1')
    expect(memberProviderLabel(relayB, both)).toBe('Relay B · relay-b.example.com/v1')
  })

  it('reveals the full endpoint URL on hover', () => {
    expect(memberEndpointTitle(relayA, both)).toBe('https://relay-a.example.com/v1')
    expect(memberEndpointTitle(relayB, both)).toBe('https://relay-b.example.com/v1')
  })

  it('offers the qualified id so a copy pins one relay', () => {
    expect(providerPinId(relayA, both)).toBe('custom:deepseek-v3.1#relay-a.example.com-v1')
    expect(providerPinId(relayB, both)).toBe('custom:deepseek-v3.1#relay-b.example.com-v1')
  })

  it('does not disambiguate a DIFFERENT model id that only one relay serves', () => {
    const soloOnA: R = { ...relayA, modelId: 'qwen-3' }
    const siblings = [soloOnA, relayA, relayB]
    expect(memberProviderLabel(soloOnA, siblings)).toBe('Relay A')
    expect(memberEndpointTitle(soloOnA, siblings)).toBeUndefined()
    expect(providerPinId(soloOnA, siblings)).toBe('qwen-3')
  })
})


// Display name is presentation, never identity (#651). Renaming one relay's copy
// moves it into a different display-name group, but the two rows still share
// (platform, model_id) — so the disambiguation must key on that pair and nothing
// else, and the split/merge override must name ONE relay's row.
describe('two endpoints whose copies were renamed apart', () => {
  const renamedA: R = { ...relayA, displayName: 'DeepSeek via A' }
  const all = [renamedA, relayB]

  it('still labels each with its endpoint', () => {
    expect(memberProviderLabel(renamedA, all)).toBe('Relay A · relay-a.example.com/v1')
    expect(memberProviderLabel(relayB, all)).toBe('Relay B · relay-b.example.com/v1')
  })

  it('still hands out the qualified id to copy', () => {
    expect(providerPinId(renamedA, all)).toBe('custom:deepseek-v3.1#relay-a.example.com-v1')
    expect(providerPinId(relayB, all)).toBe('custom:deepseek-v3.1#relay-b.example.com-v1')
  })

  it('still reveals the endpoint on hover', () => {
    expect(memberEndpointTitle(renamedA, all)).toBe('https://relay-a.example.com/v1')
  })
})

describe('split / merge override key', () => {
  it('names one relay\'s row, not every custom row with that model id', () => {
    expect(memberOverrideKey(relayA)).toBe('custom:deepseek-v3.1#relay-a.example.com-v1')
    expect(memberOverrideKey(relayB)).toBe('custom:deepseek-v3.1#relay-b.example.com-v1')
    expect(memberOverrideKey(relayA)).not.toBe(memberOverrideKey(relayB))
  })

  it('keeps the plain member id for rows with no endpoint of their own', () => {
    expect(memberOverrideKey(catalog)).toBe('groq:llama-3.3-70b')
    expect(memberOverrideKey({ platform: 'custom', modelId: 'legacy' })).toBe('custom:legacy')
  })
})

describe('collision detection keys on (platform, model_id)', () => {
  it('ignores a same-id row on a different platform', () => {
    const sameIdOnCatalog: R = { platform: 'groq', modelId: 'deepseek-v3.1', source: 'catalog' }
    expect(memberProviderLabel(soloRelay, [soloRelay, sameIdOnCatalog])).toBe('Custom')
    expect(providerPinId(soloRelay, [soloRelay, sameIdOnCatalog])).toBe('deepseek-v3.1')
  })
})
