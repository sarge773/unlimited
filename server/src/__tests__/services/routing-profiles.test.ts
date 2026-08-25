import { describe, it, expect } from 'vitest';
import {
  routingProfilesSchema,
  expandProfile,
  resolveRoutingProfile,
  resolveDispatchTarget,
  dispatchChainOptions,
  type RoutingProfile,
} from '../../services/routing-profiles.js';
import { groupRows, resolveRequestedIdForDispatch, type GroupableRow, type UnifyOverrides } from '../../services/model-groups.js';

const NO_OVERRIDES: UnifyOverrides = { merges: [], splits: [] };

function row(model_db_id: number, platform: string, model_id: string, display_name: string, intelligence_rank = 50): GroupableRow {
  return { model_db_id, platform, model_id, display_name, intelligence_rank };
}

// Same catalog slice as model-groups.test.ts: logical models spread across
// providers, so refs can exercise every rung of the resolution ladder.
function catalog(): GroupableRow[] {
  return [
    row(1, 'cerebras', 'gpt-oss-120b', 'GPT-OSS 120B', 3),
    row(2, 'groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', 6),
    row(3, 'cloudflare', '@cf/openai/gpt-oss-120b', 'GPT-OSS 120B (CF)', 6),
    row(6, 'groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 9),
    row(7, 'openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B (free)', 17),
    row(10, 'groq', 'qwen3-coder-480b', 'Qwen3 Coder 480B', 4),
  ];
}

function groups() {
  return groupRows(catalog(), NO_OVERRIDES);
}

function profile(partial: Partial<RoutingProfile>): RoutingProfile {
  return { slug: 'coding', name: 'Coding', description: '', models: [], ...partial };
}

describe('routingProfilesSchema', () => {
  it('rejects slugs that the auto short-circuit would shadow', () => {
    for (const slug of ['auto', 'auto-1', 'auto_fast']) {
      const parsed = routingProfilesSchema.safeParse([{ slug, name: 'X', models: [] }]);
      expect(parsed.success).toBe(false);
    }
  });
  it('enforces lowercase API-safe slugs and case-insensitive uniqueness', () => {
    expect(routingProfilesSchema.safeParse([{ slug: 'Coding', name: 'X', models: [] }]).success).toBe(false);
    expect(routingProfilesSchema.safeParse([{ slug: '-lead', name: 'X', models: [] }]).success).toBe(false);
    const dup = routingProfilesSchema.safeParse([
      { slug: 'coding', name: 'A', models: [] },
      { slug: 'CODING', name: 'B', models: [] },
    ]);
    expect(dup.success).toBe(false);
  });
});

describe('expandProfile', () => {
  it('orders members by entry priority regardless of declaration order', () => {
    const p = profile({
      models: [
        { ref: 'cerebras:gpt-oss-120b', priority: 20 },
        { ref: 'groq:qwen3-coder-480b', priority: 10 },
      ],
    });
    // Qwen3 has the LOWER priority number → head of the chain.
    expect(expandProfile(p, groups())!.memberDbIds).toEqual([10, 1]);
  });

  it('expands each ref through the full resolution ladder and dedupes repeats', () => {
    const p = profile({
      models: [
        { ref: 'gpt-oss-120b', priority: 1 },          // bare id → whole unify group [1,2,3]
        { ref: 'groq:openai/gpt-oss-120b', priority: 2 }, // already covered → dropped
        { ref: 'Llama 3.3 70B'.toLowerCase().replace(/ /g, '-'), priority: 3 }, // canonical group slug → [6,7]
      ],
    });
    expect(expandProfile(p, groups())!.memberDbIds).toEqual([1, 2, 3, 6, 7]);
  });

  it('skips unresolvable refs instead of failing the profile', () => {
    const p = profile({
      models: [
        { ref: 'nope:not-a-model', priority: 1 },
        { ref: 'groq:qwen3-coder-480b', priority: 2 },
        { ref: 'retired-model', priority: 3 },
      ],
    });
    expect(expandProfile(p, groups())!.memberDbIds).toEqual([10]);
  });

  it('returns null when nothing in the profile resolves', () => {
    const p = profile({ models: [{ ref: 'ghost', priority: 1 }] });
    expect(expandProfile(p, groups())).toBeNull();
  });

  it('carries per-member priorities for strict chain ordering', () => {
    const p = profile({
      models: [
        { ref: 'groq:qwen3-coder-480b', priority: 5 },
        { ref: 'gpt-oss-120b', priority: 7 },
      ],
    });
    const priorities = expandProfile(p, groups())!.priorities!;
    expect(priorities.get(10)).toBe(5);
    expect(priorities.get(1)).toBe(7);
  });
});

describe('resolveRoutingProfile', () => {
  const profiles = [
    profile({ slug: 'coding', models: [{ ref: 'groq:qwen3-coder-480b', priority: 1 }] }),
    profile({ slug: 'fast', models: [{ ref: 'gpt-oss-120b', priority: 1 }] }),
  ];

  it('matches case-insensitively', () => {
    expect(resolveRoutingProfile('CODING', groups(), profiles)!.profile.slug).toBe('coding');
  });
  it('returns null for unknown slugs', () => {
    expect(resolveRoutingProfile('reasoning', groups(), profiles)).toBeNull();
  });
});

describe('resolveDispatchTarget precedence (#1026)', () => {
  // A profile whose slug collides with a real model id must NOT hijack it.
  // The full ladder is DB-backed (resolveDispatchTarget) and covered by the
  // routes/routing-profiles.test.ts end-to-end suite; here we pin the raw
  // inputs that make the ladder correct.
  const shadow = profile({
    slug: 'qwen3-coder-480b',
    models: [{ ref: 'gpt-oss-120b', priority: 1 }],
  });

  it('the colliding model resolves on its own and the same-named profile exists', () => {
    expect(resolveRequestedIdForDispatch('qwen3-coder-480b', groups())!.memberDbIds).toEqual([10]);
    expect(resolveRoutingProfile('qwen3-coder-480b', groups(), [shadow])!.memberDbIds).toEqual([1, 2, 3]);
  });

  it('resolves a profile slug only after no model/group answers', () => {
    const profiles = [profile({ slug: 'coding', models: [{ ref: 'gpt-oss-120b', priority: 1 }] })];
    const resolved = resolveRoutingProfile('coding', groups(), profiles);
    expect(resolved!.memberDbIds).toEqual([1, 2, 3]);
  });
});

describe('dispatchChainOptions', () => {
  it('is undefined for plain model/group pins so strategy ordering is kept', () => {
    const direct = resolveRequestedIdForDispatch('gpt-oss-120b', groups());
    expect(dispatchChainOptions(direct)).toBeUndefined();
    expect(dispatchChainOptions(null)).toBeUndefined();
  });
  it('forces strict priority ordering only for profile chains', () => {
    const p = profile({ slug: 'x', models: [{ ref: 'gpt-oss-120b', priority: 1 }] });
    const opts = dispatchChainOptions(expandProfile(p, groups()));
    expect(opts).toBeDefined();
    expect(opts!.strictPriorityOrder).toBe(true);
    expect(opts!.priorityOverrides!.get(1)).toBe(1);
  });
});
