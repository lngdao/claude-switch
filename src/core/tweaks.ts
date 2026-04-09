import { existsSync, readFileSync } from 'node:fs';
import { writeJsonAtomic } from './fs-safe.js';
import { bypassOnboarding } from './headless.js';
import type { Paths } from './paths.js';

export type TweakStatus = 'applied' | 'not-applied' | 'unknown';

export interface TweakDescriptor {
  id: string;
  title: string;
  description: string;
  /** Apply the tweak; returns a short human-readable summary. */
  apply(paths: Paths): Promise<string>;
  /** Inspect current state without changing anything. */
  status(paths: Paths): Promise<TweakStatus>;
}

// ─── opus-1m: pin model to "opus[1m]" in settings.json ─────

const OPUS_1M_MODEL = 'opus[1m]';

async function applyOpus1m(paths: Paths): Promise<string> {
  const existing: Record<string, unknown> = readSettingsRaw(paths);
  if (existing.model === OPUS_1M_MODEL) {
    return `model already set to "${OPUS_1M_MODEL}"`;
  }
  const next = { ...existing, model: OPUS_1M_MODEL };
  writeJsonAtomic(paths.settings, next, { mode: 0o600, backup: 3 });
  return `model set to "${OPUS_1M_MODEL}" in ${paths.settings}`;
}

async function statusOpus1m(paths: Paths): Promise<TweakStatus> {
  if (!existsSync(paths.settings)) return 'not-applied';
  try {
    const raw = readSettingsRaw(paths);
    return raw.model === OPUS_1M_MODEL ? 'applied' : 'not-applied';
  } catch {
    return 'unknown';
  }
}

function readSettingsRaw(paths: Paths): Record<string, unknown> {
  if (!existsSync(paths.settings)) return {};
  try {
    return JSON.parse(readFileSync(paths.settings, 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

// ─── bypass-onboarding: set hasCompletedOnboarding in ~/.claude.json ───

async function applyBypassOnboarding(paths: Paths): Promise<string> {
  const result = await bypassOnboarding(paths);
  switch (result.action) {
    case 'created':
      return `created ${result.path} (version: ${result.version || 'unknown'})`;
    case 'updated':
      return `updated ${result.path}, preserved ${result.preservedKeys.length} other keys`;
    case 'noop':
      return `already bypassed (${result.version || 'no version recorded'})`;
  }
}

async function statusBypassOnboarding(paths: Paths): Promise<TweakStatus> {
  if (!existsSync(paths.claudeJson)) return 'not-applied';
  try {
    const raw = JSON.parse(readFileSync(paths.claudeJson, 'utf8')) as Record<
      string,
      unknown
    >;
    return raw.hasCompletedOnboarding === true ? 'applied' : 'not-applied';
  } catch {
    return 'unknown';
  }
}

// ─── Registry ──────────────────────────────────────────────

export const TWEAKS: TweakDescriptor[] = [
  {
    id: 'bypass-onboarding',
    title: 'Bypass Claude Code onboarding wizard',
    description:
      'Sets `hasCompletedOnboarding: true` in ~/.claude.json so Claude Code starts directly. Auto-detects `lastOnboardingVersion` from `claude --version`. Preserves all other fields (oauthAccount, etc).',
    apply: applyBypassOnboarding,
    status: statusBypassOnboarding,
  },
  {
    id: 'opus-1m',
    title: 'Enable Opus with 1M context',
    description:
      'Adds `"model": "opus[1m]"` to settings.json. Workaround for the Opus 1M context option not showing in the model picker. Preserves all other settings keys.',
    apply: applyOpus1m,
    status: statusOpus1m,
  },
];

export function getTweak(id: string): TweakDescriptor | undefined {
  return TWEAKS.find((f) => f.id === id);
}

export function listTweakIds(): string[] {
  return TWEAKS.map((f) => f.id);
}
