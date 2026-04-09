import { existsSync, readFileSync } from 'node:fs';
import { SettingsSchema, type Settings } from './schema.js';
import { writeJsonAtomic } from './fs-safe.js';
import type { Paths } from './paths.js';

export function readSettings(paths: Paths): Settings {
  if (!existsSync(paths.settings)) {
    return {};
  }
  const raw = JSON.parse(readFileSync(paths.settings, 'utf8'));
  const parsed = SettingsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `settings.json is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}

export function readSettingsEnv(paths: Paths): Record<string, string> {
  try {
    return readSettings(paths).env ?? {};
  } catch {
    return {};
  }
}

/**
 * Replace the .env block in settings.json with the given env, preserving all
 * other top-level keys. Atomic write + automatic backup rotation (3 keep).
 */
export function applyEnvToSettings(
  paths: Paths,
  newEnv: Record<string, string>,
  opts: { backup?: number } = {},
): void {
  const current = readSettings(paths);
  const next: Settings = { ...current, env: newEnv };
  writeJsonAtomic(paths.settings, next, {
    backup: opts.backup ?? 3,
    mode: 0o600,
  });
}
