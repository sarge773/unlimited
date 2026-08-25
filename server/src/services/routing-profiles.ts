/**
 * Routing profiles (#1026) — named capability groups ("coding", "fast",
 * "vision", …) that a client can request AS the model id. A profile lists
 * member models with an explicit priority; when the request names the profile,
 * the members form a strict failover chain tried strictly in that order —
 * 429/timeout/5xx on the head model falls through to the next, exactly like a
 * pinned group, but across DIFFERENT logical models instead of one model's
 * providers.
 *
 * Storage mirrors the unify-overrides pattern (services/model-groups.ts): JSON
 * in the existing `settings` table keyed by ROUTING_PROFILES_KEY. No schema
 * change; profiles are operator config, not catalog data.
 *
 * Resolution precedence is deliberate and documented in resolveRequestedId…:
 * real models and unify groups always win over profile slugs, so shipping a
 * profile can never hijack an id an existing client already uses.
 *
 * Pure by design: expandProfile / resolveProfileToMembers take rows and
 * profiles as arguments and touch no globals; only the get/set convenience
 * wrappers touch the DB.
 */
import { z } from 'zod';
import { getDb, getSetting, setSetting } from '../db/index.js';
import {
  getModelGroups,
  resolveRequestedIdForDispatch,
  type DispatchMembers,
  type GroupCandidatesOptions,
  type ModelGroup,
} from './model-groups.js';

// ── Settings key ─────────────────────────────────────────────────────────────
export const ROUTING_PROFILES_KEY = 'routing_profiles_json';

// ── Schema ───────────────────────────────────────────────────────────────────
// Slugs are lowercase API identifiers (the `model` value clients send). They
// must not start with "auto" — every inbound surface treats `auto`/`auto:*` as
// automatic routing before resolution ever runs, so such a profile would be
// unreachable.
export const profileSlugSchema = z.string()
  .min(1, 'Slug cannot be empty')
  .max(40, 'Slug must not exceed 40 characters')
  .regex(/^[a-z0-9][a-z0-9-_]*$/, 'Use lowercase letters, digits, hyphens (-) and underscores (_); must start with a letter or digit')
  .refine(s => !(s === 'auto' || s.startsWith('auto-') || s.startsWith('auto_')), "'auto' is reserved for automatic routing");

const profileModelSchema = z.object({
  // What the entry points at: a bare model_id, a canonical group slug, or a
  // fully-qualified "platform:model_id" — anything resolveRequestedIdToMembers
  // answers. Each ref may itself expand to several provider copies; they all
  // inherit the entry's priority slot and fail over within it.
  ref: z.string().min(1).max(300),
  // Lower tries first. Bare z number like PUT /api/fallback so operators keep
  // whatever spacing they like (10/20/30); ordering is relative.
  priority: z.number(),
});

export const routingProfileSchema = z.object({
  slug: profileSlugSchema,
  name: z.string().min(1).max(60),
  description: z.string().max(300).default(''),
  models: z.array(profileModelSchema).max(100).default([]),
});

export const routingProfilesSchema = z.array(routingProfileSchema)
  .max(50, 'At most 50 routing profiles')
  // Slug uniqueness is case-insensitive: slugs are matched case-insensitively
  // at request time, so two profiles differing only by case would be ambiguous.
  .refine(profiles => new Set(profiles.map(p => p.slug.toLowerCase())).size === profiles.length,
    'Duplicate profile slugs');

export type RoutingProfileModel = z.infer<typeof profileModelSchema>;
export type RoutingProfile = z.infer<typeof routingProfileSchema>;

// ── DB accessors ─────────────────────────────────────────────────────────────
export function getRoutingProfiles(): RoutingProfile[] {
  const raw = getSetting(ROUTING_PROFILES_KEY);
  if (!raw) return [];
  try {
    const parsed = routingProfilesSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch { /* corrupt JSON → safe default */ }
  return [];
}

export function setRoutingProfiles(input: unknown): RoutingProfile[] {
  const norm = routingProfilesSchema.parse(input);
  setSetting(ROUTING_PROFILES_KEY, JSON.stringify(norm));
  return norm;
}

/** Replace one profile (by slug, case-insensitive) or append it; keeps order stable. */
export function upsertRoutingProfile(profile: RoutingProfile, existing?: RoutingProfile[]): RoutingProfile[] {
  const profiles = existing ?? getRoutingProfiles();
  const idx = profiles.findIndex(p => p.slug.toLowerCase() === profile.slug.toLowerCase());
  const next = [...profiles];
  if (idx >= 0) next[idx] = profile;
  else next.push(profile);
  return setRoutingProfiles(next);
}

export function deleteRoutingProfile(slug: string): boolean {
  const profiles = getRoutingProfiles();
  const next = profiles.filter(p => p.slug.toLowerCase() !== slug.toLowerCase());
  if (next.length === profiles.length) return false;
  setRoutingProfiles(next);
  return true;
}

// ── Pure expansion core ──────────────────────────────────────────────────────

/**
 * Expand ONE profile into ordered dispatch members. Entries are sorted by
 * priority ascending (ties keep declaration order), each entry's ref resolves
 * through the same ladder a direct model request would use, and already-seen
 * db ids are dropped so a model listed twice is not tried twice.
 *
 * Refs that resolve to nothing (a retired model id, a typo) are skipped rather
 * than failing the whole profile — a profile should degrade to its resolvable
 * members, and the admin GET reports unresolvable refs so the operator can fix
 * them.
 *
 * Returns null when the profile matches no resolvable member at all: the
 * caller then treats it as any other unknown model id.
 */
export function expandProfile(
  profile: RoutingProfile,
  groups: ModelGroup[],
): DispatchMembers | null {
  const entries = [...profile.models]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.priority - b.entry.priority || a.index - b.index);

  const ids: number[] = [];
  const priorities = new Map<number, number>();
  for (const { entry } of entries) {
    const resolved = resolveRequestedIdForDispatch(entry.ref, groups);
    if (!resolved) continue;
    for (const id of resolved.memberDbIds) {
      if (priorities.has(id)) continue;
      priorities.set(id, entry.priority);
      ids.push(id);
    }
  }
  return ids.length > 0 ? { memberDbIds: ids, demotedDbIds: new Set(), priorities } : null;
}

/**
 * Resolve a requested model id AGAINST THE PROFILES ONLY. Matched
 * case-insensitively (clients send arbitrary casing; slugs are lowercase).
 */
export function resolveRoutingProfile(
  requested: string,
  groups: ModelGroup[],
  profiles: readonly RoutingProfile[],
): (DispatchMembers & { profile: RoutingProfile }) | null {
  const needle = requested.trim().toLowerCase();
  const profile = profiles.find(p => p.slug === needle);
  if (!profile) return null;
  const expanded = expandProfile(profile, groups);
  return expanded ? { ...expanded, profile } : null;
}

/**
 * The full dispatch ladder for a request path, in one call:
 *   1. exact endpoint-qualified / platform:model_id / group-slug / bare-id
 *      resolution (the pre-existing behavior — unchanged, so no existing
 *      client can be shadowed by a profile that happens to share its name);
 *   2. then a routing-profile slug.
 *
 * Returns null when NEITHER matches, which callers turn into their usual
 * model_not_found path.
 */
export function resolveDispatchTarget(requested: string | undefined): DispatchMembers | null {
  const trimmed = requested?.trim();
  if (!trimmed || trimmed.toLowerCase() === 'auto' || trimmed.toLowerCase().startsWith('auto:')) return null;
  const groups = getModelGroups();
  const direct = resolveRequestedIdForDispatch(trimmed, groups);
  if (direct) return direct;
  return resolveRoutingProfile(trimmed, groups, getRoutingProfiles());
}

/**
 * Options for resolveModelGroupCandidates derived from a dispatch result.
 * Undefined for plain model/group pins (strategy-driven ordering, exactly as
 * before); strict-priority for profile chains.
 */
export function dispatchChainOptions(dispatch: DispatchMembers | null): GroupCandidatesOptions | undefined {
  if (!dispatch?.priorities) return undefined;
  return { priorityOverrides: dispatch.priorities, strictPriorityOrder: true };
}

/** The subset of a profile's refs that resolve to nothing (admin diagnostics). */
export function unresolvableRefs(profile: RoutingProfile, groups: ModelGroup[]): string[] {
  return profile.models
    .filter(entry => !resolveRequestedIdForDispatch(entry.ref, groups))
    .map(entry => entry.ref);
}
