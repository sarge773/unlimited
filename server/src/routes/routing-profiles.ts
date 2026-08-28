/**
 * Admin CRUD for routing profiles (#1026) — named capability groups ("coding",
 * "fast", …) that clients can send as the `model` value and that expand into a
 * strict, priority-ordered failover chain across DIFFERENT logical models.
 * Storage and resolution live in services/routing-profiles.ts; this router is
 * the dashboard's door to it.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getModelGroups } from '../services/model-groups.js';
import {
  getRoutingProfiles,
  setRoutingProfiles,
  upsertRoutingProfile,
  deleteRoutingProfile,
  unresolvableRefs,
  routingProfileSchema,
  type RoutingProfile,
} from '../services/routing-profiles.js';

export const routingProfilesRouter = Router();

const createSchema = z.object({
  slug: routingProfileSchema.shape.slug,
  name: z.string().min(1).max(60),
  description: z.string().max(300).optional(),
  models: z.array(z.object({
    ref: z.string().min(1).max(300),
    priority: z.number(),
  })).max(100).default([]),
});

// Partial update: metadata only, members replaced wholesale via `models`.
const updateSchema = createSchema.partial().omit({ slug: true });

function withDiagnostics(profile: RoutingProfile): RoutingProfile & { unresolvedRefs: string[]; memberCount: number } {
  const groups = getModelGroups();
  return {
    ...profile,
    unresolvedRefs: unresolvableRefs(profile, groups),
    memberCount: profile.models.length,
  };
}

routingProfilesRouter.get('/', (_req: Request, res: Response) => {
  res.json(getRoutingProfiles().map(withDiagnostics));
});

routingProfilesRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const profiles = getRoutingProfiles();
  if (profiles.some(p => p.slug.toLowerCase() === parsed.data.slug.toLowerCase())) {
    res.status(409).json({ error: { message: `A routing profile '${parsed.data.slug}' already exists` } });
    return;
  }
  const created: RoutingProfile = {
    slug: parsed.data.slug,
    name: parsed.data.name,
    description: parsed.data.description ?? '',
    models: parsed.data.models,
  };
  upsertRoutingProfile(created, profiles);
  res.status(201).json(withDiagnostics(created));
});

routingProfilesRouter.put('/:slug', (req: Request, res: Response) => {
  const slug = String(req.params.slug);
  const profiles = getRoutingProfiles();
  const idx = profiles.findIndex(p => p.slug.toLowerCase() === slug.toLowerCase());
  if (idx < 0) {
    res.status(404).json({ error: { message: `Unknown routing profile '${slug}'` } });
    return;
  }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const next: RoutingProfile = {
    ...profiles[idx],
    ...parsed.data,
    description: parsed.data.description ?? profiles[idx].description,
    models: parsed.data.models ?? profiles[idx].models,
  };
  // Persist through setRoutingProfiles so the whole-list schema (duplicate-slug
  // check included) validates the result, not just the patch.
  const updated = [...profiles];
  updated[idx] = next;
  try {
    setRoutingProfiles(updated);
  } catch (error: any) {
    res.status(400).json({ error: { message: error.message } });
    return;
  }
  res.json(withDiagnostics(next));
});

routingProfilesRouter.delete('/:slug', (req: Request, res: Response) => {
  if (!deleteRoutingProfile(String(req.params.slug))) {
    res.status(404).json({ error: { message: `Unknown routing profile '${String(req.params.slug)}'` } });
    return;
  }
  res.json({ success: true });
});
