import { describe, it, expect, beforeAll } from 'vitest';
import { initDb } from '../../db/index.js';
import { applyDisabledProviderMask, assertEnabledProvidersCovered, getMissingEnabledProviders } from '../../services/provider-coverage.js';

describe('provider coverage guard', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
  });

  it('passes when every enabled catalog platform has a provider', () => {
    const db = initDb(':memory:');
    expect(getMissingEnabledProviders(db)).toEqual([]);
    expect(() => assertEnabledProvidersCovered(db)).not.toThrow();
  });

  it('fails fast when an enabled platform has no registered provider', () => {
    const db = initDb(':memory:');
    db.prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
        enabled, supports_vision, supports_tools
      ) VALUES ('imaginary', 'missing-model', 'Missing Model', 999, 999, 'Large', NULL, NULL, NULL, NULL, '', NULL, 1, 0, 0)
    `).run();

    expect(getMissingEnabledProviders(db)).toEqual(['imaginary']);
    expect(() => assertEnabledProvidersCovered(db)).toThrow(/imaginary/);
  });

  it('masks disabled providers from the catalog and fallback chains', () => {
    const db = initDb(':memory:');
    const masked = applyDisabledProviderMask(db, 'openrouter, ollama');
    expect(masked).toEqual(['openrouter', 'ollama']);

    const rows = db.prepare(`
      SELECT DISTINCT platform FROM models WHERE enabled = 1 AND platform IN ('openrouter', 'ollama')
    `).all() as { platform: string }[];
    expect(rows).toEqual([]);
    expect(getMissingEnabledProviders(db)).not.toContain('openrouter');
    expect(getMissingEnabledProviders(db)).not.toContain('ollama');
  });
});
