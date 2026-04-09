import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ProfileSchema, type Profile, type ProbeRecord } from './schema.js';
import { writeJsonAtomic, ensureDir } from './fs-safe.js';
import { detectScheme, checkConflicts, type AuthScheme } from './scheme.js';
import type { Paths } from './paths.js';

export interface ProfileSummary {
  name: string;
  file: string;
  scheme: AuthScheme;
  envKeys: string[];
  updatedAt?: string;
  active: boolean;
  lastProbe?: ProbeRecord;
}

const PROFILE_NAME_RE = /^[A-Za-z0-9 _.\-]+$/;

export function isValidProfileName(name: string): boolean {
  return name.length > 0 && PROFILE_NAME_RE.test(name);
}

export function profileFile(paths: Paths, name: string): string {
  return join(paths.profilesDir, `${name}.json`);
}

export function listProfiles(paths: Paths): string[] {
  if (!existsSync(paths.profilesDir)) return [];
  return readdirSync(paths.profilesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort((a, b) => a.localeCompare(b));
}

export function readProfile(paths: Paths, name: string): Profile {
  const file = profileFile(paths, name);
  if (!existsSync(file)) throw new Error(`Profile not found: ${name}`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Profile '${name}' is invalid: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  return parsed.data;
}

export interface WriteProfileOptions {
  /** Allow conflicting auth keys (skip guard). Default false. */
  force?: boolean;
}

export function writeProfile(
  paths: Paths,
  name: string,
  profile: Profile,
  opts: WriteProfileOptions = {},
): void {
  if (!isValidProfileName(name)) {
    throw new Error(
      `Invalid profile name: '${name}'. Allowed: letters, digits, space, _ . -`,
    );
  }

  if (!opts.force) {
    const conflict = checkConflicts(profile.env);
    if (!conflict.ok) {
      const err = new Error(
        `Profile has conflicting auth keys: ${conflict.conflicts.join(', ')}. ` +
          `Claude Code does not allow these together. Pass --force to override.`,
      );
      (err as Error & { code: string }).code = 'CONFLICT';
      throw err;
    }
  }

  ensureDir(paths.profilesDir);
  const now = new Date().toISOString();
  const next: Profile = {
    ...profile,
    meta: {
      ...(profile.meta ?? {}),
      createdAt: profile.meta?.createdAt ?? now,
      updatedAt: now,
    },
  };

  writeJsonAtomic(profileFile(paths, name), next, { mode: 0o600 });
}

/**
 * Persist a probe result into a profile's meta.lastProbe field.
 *
 * Bypasses conflict guard / prefix checks intentionally — recording a probe
 * shouldn't fail just because the profile happens to be in a bad state. We
 * also do NOT bump meta.updatedAt because this is internal bookkeeping, not a
 * user edit.
 */
export function recordProbe(
  paths: Paths,
  name: string,
  probe: ProbeRecord,
): void {
  // Read raw — skip schema validation so a malformed profile can still get a
  // probe record (the doctor probably already flagged it).
  const file = profileFile(paths, name);
  if (!existsSync(file)) return;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  const meta = (raw.meta ?? {}) as Record<string, unknown>;
  const next = {
    ...raw,
    meta: { ...meta, lastProbe: probe },
  };
  writeJsonAtomic(file, next, { mode: 0o600 });
}

export function deleteProfile(paths: Paths, name: string): void {
  const file = profileFile(paths, name);
  if (!existsSync(file)) throw new Error(`Profile not found: ${name}`);
  unlinkSync(file);
}

export function renameProfile(paths: Paths, oldName: string, newName: string): void {
  if (!isValidProfileName(newName)) {
    throw new Error(`Invalid profile name: '${newName}'`);
  }
  const from = profileFile(paths, oldName);
  const to = profileFile(paths, newName);
  if (!existsSync(from)) throw new Error(`Profile not found: ${oldName}`);
  if (existsSync(to)) throw new Error(`Profile already exists: ${newName}`);
  renameSync(from, to);
}

export function cloneProfile(paths: Paths, src: string, dst: string): void {
  if (!isValidProfileName(dst)) throw new Error(`Invalid profile name: '${dst}'`);
  const dstFile = profileFile(paths, dst);
  if (existsSync(dstFile)) throw new Error(`Profile already exists: ${dst}`);
  const profile = readProfile(paths, src);
  const now = new Date().toISOString();
  const cloned: Profile = {
    env: { ...profile.env },
    meta: {
      ...(profile.meta ?? {}),
      createdAt: now,
      updatedAt: now,
      description: profile.meta?.description
        ? `${profile.meta.description} (clone of ${src})`
        : `clone of ${src}`,
    },
  };
  writeJsonAtomic(dstFile, cloned, { mode: 0o600 });
}

/**
 * Compare two env objects key-by-key (sorted) for equality.
 */
function envEquals(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    const k = ka[i]!;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/**
 * Find which profile matches the given env block.
 * - exact match → profile name
 * - no match → '(custom)'
 * - multiple matches → first lexicographically
 */
export function detectCurrent(
  paths: Paths,
  settingsEnv: Record<string, string>,
): string {
  const matches: string[] = [];
  for (const name of listProfiles(paths)) {
    try {
      const profile = readProfile(paths, name);
      if (envEquals(profile.env, settingsEnv)) matches.push(name);
    } catch {
      /* skip invalid profiles */
    }
  }
  if (matches.length === 0) return '(custom)';
  return matches[0]!;
}

export function summarize(
  paths: Paths,
  settingsEnv: Record<string, string>,
): ProfileSummary[] {
  const current = detectCurrent(paths, settingsEnv);
  return listProfiles(paths).map((name) => {
    const file = profileFile(paths, name);
    let envKeys: string[] = [];
    let scheme: AuthScheme = 'unknown';
    let updatedAt: string | undefined;
    let lastProbe: ProbeRecord | undefined;
    try {
      const p = readProfile(paths, name);
      envKeys = Object.keys(p.env);
      scheme = detectScheme(p.env);
      updatedAt = p.meta?.updatedAt;
      lastProbe = p.meta?.lastProbe;
    } catch {
      /* leave defaults */
    }
    if (!updatedAt) {
      try {
        updatedAt = statSync(file).mtime.toISOString();
      } catch {
        /* ignore */
      }
    }
    return {
      name,
      file,
      scheme,
      envKeys,
      updatedAt,
      active: name === current,
      lastProbe,
    };
  });
}
