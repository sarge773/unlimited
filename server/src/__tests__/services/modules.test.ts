import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  registerModule,
  getModules,
  getModule,
  isModuleEnabled,
  enableModule,
  disableModule,
  initBuiltinModules,
} from '../../services/modules.js';

// #763: the pluggable-module registry. Tests cover registration (idempotent,
// last-wins), querying (in order), the enable/disable surface (persisted to
// the module's setting key, absent = disabled) and the builtin compression
// module. The registry keeps process-global state, so tests reset it by
// re-registering known modules and clearing the settings store between cases.

const settingStore = new Map<string, string>();
vi.mock('../../db/index.js', () => ({
  getSetting: (key: string) => settingStore.get(key),
  setSetting: (key: string, value: string) => { settingStore.set(key, value); },
}));

beforeEach(() => {
  settingStore.clear();
  // Re-seed a deterministic registry for each test (registration is
  // process-global and last-wins, so a fresh set keeps cases isolated).
  registerModule({ id: 'alpha', name: 'Alpha', description: 'test module', settingKey: 'alpha_enabled' });
  registerModule({ id: 'beta', name: 'Beta', description: 'test module', settingKey: 'beta_enabled' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('module registry (#763)', () => {
  it('lists modules in registration order', () => {
    const ids = getModules().map(m => m.id);
    expect(ids).toEqual(['alpha', 'beta']);
  });

  it('returns a module by id, or undefined for an unknown id', () => {
    expect(getModule('alpha')?.name).toBe('Alpha');
    expect(getModule('nope')).toBeUndefined();
  });

  it('re-registering an id replaces the earlier module (last wins)', () => {
    registerModule({ id: 'alpha', name: 'Alpha v2', description: 'updated', settingKey: 'alpha_enabled' });
    expect(getModule('alpha')?.name).toBe('Alpha v2');
    expect(getModules()).toHaveLength(2); // no duplicate entry
  });
});

describe('enable / disable surface (#763)', () => {
  it('is disabled by default when the setting key is absent', () => {
    expect(isModuleEnabled('alpha')).toBe(false);
  });

  it('enable persists "1" and flips the flag', () => {
    expect(enableModule('alpha')).toBe(true);
    expect(settingStore.get('alpha_enabled')).toBe('1');
    expect(isModuleEnabled('alpha')).toBe(true);
  });

  it('disable persists "0" and flips the flag back', () => {
    enableModule('alpha');
    expect(disableModule('alpha')).toBe(true);
    expect(settingStore.get('alpha_enabled')).toBe('0');
    expect(isModuleEnabled('alpha')).toBe(false);
  });

  it('reads "0" from the store as disabled even without disable()', () => {
    settingStore.set('alpha_enabled', '0');
    expect(isModuleEnabled('alpha')).toBe(false);
  });

  it('returns false for unknown modules and writes nothing', () => {
    expect(enableModule('ghost')).toBe(false);
    expect(disableModule('ghost')).toBe(false);
    expect(settingStore.has('ghost_enabled')).toBe(false);
  });
});

describe('builtin modules (#763)', () => {
  it('registers compression with its own setting key', () => {
    initBuiltinModules();
    const compression = getModule('compression');
    expect(compression?.name).toBe('Prompt compression');
    expect(compression?.settingKey).toBe('compression_enabled');
    expect(isModuleEnabled('compression')).toBe(false);
    expect(enableModule('compression')).toBe(true);
    expect(isModuleEnabled('compression')).toBe(true);
  });
});
