import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, basename, join } from 'node:path';
import lockfile from 'proper-lockfile';

const FILE_MODE = 0o600;

/**
 * Resolve symlinks so we write to the real underlying file.
 * If the path doesn't exist yet, return as-is.
 */
function resolveTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readJsonSafe<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as T;
}

export interface WriteOptions {
  /** Rotate up to N backups before overwriting (default 0 = no backup). */
  backup?: number;
  /** chmod after writing. Defaults to 0o600. */
  mode?: number;
  /** Pretty-print JSON with N spaces. Default 2. */
  indent?: number;
}

/**
 * Atomic write JSON: write to tmp file, fsync(ish), rename over real path.
 * Symlink-aware: if `path` is a symlink, we resolve it and rewrite the real file
 * (preserving the symlink itself instead of clobbering it).
 */
export function writeJsonAtomic(
  path: string,
  data: unknown,
  opts: WriteOptions = {},
): void {
  const target = resolveTarget(path);
  ensureDir(dirname(target));

  if (opts.backup && opts.backup > 0 && existsSync(target)) {
    rotateBackups(target, opts.backup);
  }

  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`;
  const json = JSON.stringify(data, null, opts.indent ?? 2);
  writeFileSync(tmp, json + '\n', { mode: opts.mode ?? FILE_MODE });
  renameSync(tmp, target);

  try {
    chmodSync(target, opts.mode ?? FILE_MODE);
  } catch {
    /* best-effort */
  }
}

function rotateBackups(target: string, keep: number): void {
  // .bak (newest) → .bak.1 → .bak.2 → ... → drop oldest
  for (let i = keep - 1; i >= 1; i--) {
    const from = i === 1 ? `${target}.bak` : `${target}.bak.${i - 1}`;
    const to = `${target}.bak.${i}`;
    if (existsSync(from)) {
      try {
        renameSync(from, to);
      } catch {
        /* ignore */
      }
    }
  }
  try {
    copyFileSync(target, `${target}.bak`);
  } catch {
    /* ignore */
  }
}

export interface LockHandle {
  release: () => Promise<void>;
}

/**
 * Acquire an advisory lock for write operations on a directory.
 * Falls back silently to a no-op handle if locking fails (e.g. file doesn't exist).
 */
export async function acquireLock(target: string): Promise<LockHandle> {
  const dir = existsSync(target) ? target : dirname(target);
  ensureDir(dir);
  try {
    const release = await lockfile.lock(dir, {
      retries: { retries: 5, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
      stale: 10_000,
      realpath: false,
    });
    return { release: async () => release() };
  } catch {
    return { release: async () => {} };
  }
}

export function getMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

export function chmodSafe(path: string, mode: number): boolean {
  try {
    chmodSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

export function fileBaseName(path: string): string {
  return basename(path);
}

export function joinPath(...parts: string[]): string {
  return join(...parts);
}
