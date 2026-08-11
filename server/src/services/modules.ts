import { getSetting, setSetting } from '../db/index.js';

/**
 * #763: sub-feature modularization — a tiny, dependency-free pluggable-module
 * registry so composable features (compression, an opt-in paid-model module,
 * future experimental ones) share one uniform enable/disable surface.
 *
 * Modules are just objects with an id, a display name, a one-line description
 * and an enable/disable pair persisted to a settings key. There is no plugin
 * loading, no dynamic code — the point is a single registry the dashboard and
 * the router can query, so opt-in features don't each invent their own toggle.
 */

export interface FeatureModule {
  /** Stable identifier, e.g. 'compression'. */
  id: string;
  /** Display name shown in the dashboard. */
  name: string;
  /** One-line description for the settings list. */
  description: string;
  /** Setting key that holds the enabled flag ('1'/'0', absent = false). */
  settingKey: string;
}

const modules = new Map<string, FeatureModule>();

/** Register a feature module (idempotent — last registration wins). */
export function registerModule(module: FeatureModule): void {
  modules.set(module.id, module);
}

/** All registered modules, in registration order. */
export function getModules(): FeatureModule[] {
  return [...modules.values()];
}

/** A module by id, or undefined when not registered. */
export function getModule(id: string): FeatureModule | undefined {
  return modules.get(id);
}

/** Whether the module is currently enabled. */
export function isModuleEnabled(id: string): boolean {
  const module = modules.get(id);
  if (!module) return false;
  return getSetting(module.settingKey) === '1';
}

/** Enable a module. Returns true when it was registered, false otherwise. */
export function enableModule(id: string): boolean {
  const module = modules.get(id);
  if (!module) return false;
  setSetting(module.settingKey, '1');
  return true;
}

/** Disable a module. Returns true when it was registered, false otherwise. */
export function disableModule(id: string): boolean {
  const module = modules.get(id);
  if (!module) return false;
  setSetting(module.settingKey, '0');
  return true;
}

/**
 * Compression is the flagship opt-in module (#763): it rewrites outbound
 * requests to save tokens, and is gated by the dashboard toggle. Registering
 * it here exposes the uniform interface without touching its config code.
 */
export function initBuiltinModules(): void {
  registerModule({
    id: 'compression',
    name: 'Prompt compression',
    description: 'Rewrites outbound requests to use fewer tokens (lossless / standard / aggressive modes).',
    settingKey: 'compression_enabled',
  });
}
