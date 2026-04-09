import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Paths {
  profilesDir: string;
  settings: string;
  claudeJson: string;
}

export function defaultPaths(): Paths {
  const home = homedir();
  return {
    profilesDir: join(home, '.claude', 'profiles'),
    settings: join(home, '.claude', 'settings.json'),
    claudeJson: join(home, '.claude.json'),
  };
}

export function resolvePaths(overrides: Partial<Paths> = {}): Paths {
  // Filter out undefined so spread doesn't clobber defaults.
  const cleaned: Partial<Paths> = {};
  if (overrides.profilesDir !== undefined) cleaned.profilesDir = overrides.profilesDir;
  if (overrides.settings !== undefined) cleaned.settings = overrides.settings;
  if (overrides.claudeJson !== undefined) cleaned.claudeJson = overrides.claudeJson;
  return { ...defaultPaths(), ...cleaned };
}
