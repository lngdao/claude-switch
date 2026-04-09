import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
import kleur from 'kleur';

const require = createRequire(import.meta.url);

interface PackageJson {
  name: string;
  version: string;
}

export interface UpdateInfo {
  current: string;
  latest: string;
  type: 'patch' | 'minor' | 'major' | 'unknown';
  name: string;
}

interface CacheData {
  /** Version that performed the check (used to invalidate when downgraded). */
  current: string;
  /** Latest version observed from the npm registry. May equal `current`. */
  latest: string | null;
  /** Unix ms when this cache entry was written. */
  checkedAt: number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const CACHE_DIR = join(homedir(), '.config', 'claude-switch');
const CACHE_FILE = join(CACHE_DIR, 'update-check.json');

// ─── Self package info ────────────────────────────────────

export function readSelfPackage(): PackageJson | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, '..', 'package.json'),
      join(here, '..', '..', 'package.json'),
    ];
    for (const path of candidates) {
      try {
        return require(path) as PackageJson;
      } catch {
        /* try next */
      }
    }
  } catch {
    /* swallow */
  }
  return null;
}

// ─── Cache I/O ────────────────────────────────────────────

function readCache(): CacheData | null {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    const raw = readFileSync(CACHE_FILE, 'utf8');
    const data = JSON.parse(raw) as CacheData;
    if (typeof data.current !== 'string' || typeof data.checkedAt !== 'number') {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function writeCache(data: CacheData): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    /* swallow */
  }
}

// ─── Version comparison (date-based YYYY.MMDD.N safe) ─────

/**
 * Compare two dot-separated numeric versions component-by-component.
 * Returns true iff `latest` is strictly greater than `current`.
 *
 * Works correctly for both classic semver (1.2.3 vs 1.2.10) and our
 * date-based scheme (2026.410.4 vs 2026.410.10).
 */
export function isNewer(latest: string, current: string): boolean {
  const a = current.split('.').map((n) => parseInt(n, 10) || 0);
  const b = latest.split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (y > x) return true;
    if (y < x) return false;
  }
  return false;
}

function classifyDiff(current: string, latest: string): UpdateInfo['type'] {
  const a = current.split('.').map((n) => parseInt(n, 10) || 0);
  const b = latest.split('.').map((n) => parseInt(n, 10) || 0);
  if ((b[0] ?? 0) !== (a[0] ?? 0)) return 'major';
  if ((b[1] ?? 0) !== (a[1] ?? 0)) return 'minor';
  if ((b[2] ?? 0) !== (a[2] ?? 0)) return 'patch';
  return 'unknown';
}

// ─── Registry fetch ───────────────────────────────────────

async function fetchLatestVersion(
  packageName: string,
  timeoutMs = 3000,
): Promise<string | null> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName).replace('%40', '@')}/latest`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string } | undefined;
    return data?.version ?? null;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────

/**
 * Synchronously read cached update info if it's fresh and for the SAME
 * current version we're running. Returns null if cache is missing, stale,
 * was written by a different version, or doesn't show a newer release.
 */
export function cachedUpdateInfo(): UpdateInfo | null {
  if (process.env.CLAUDE_SWITCH_NO_UPDATE_CHECK === '1') return null;
  const pkg = readSelfPackage();
  if (!pkg?.name || !pkg.version) return null;

  const cache = readCache();
  if (!cache) return null;
  // Cache is invalid for THIS process if it was written by a different version
  if (cache.current !== pkg.version) return null;
  if (Date.now() - cache.checkedAt > ONE_DAY_MS) return null;
  if (!cache.latest || !isNewer(cache.latest, pkg.version)) return null;

  return {
    current: pkg.version,
    latest: cache.latest,
    type: classifyDiff(pkg.version, cache.latest),
    name: pkg.name,
  };
}

/**
 * Refresh the cache by hitting the npm registry. Returns the freshly-fetched
 * UpdateInfo if a newer version is available, otherwise null. Always writes
 * the result to cache (even when there's no update) to suppress re-checks
 * for ONE_DAY_MS.
 */
export async function refreshUpdateCache(
  timeoutMs = 3000,
): Promise<UpdateInfo | null> {
  const pkg = readSelfPackage();
  if (!pkg?.name || !pkg.version) return null;

  const latest = await fetchLatestVersion(pkg.name, timeoutMs);
  writeCache({
    current: pkg.version,
    latest,
    checkedAt: Date.now(),
  });

  if (!latest || !isNewer(latest, pkg.version)) return null;
  return {
    current: pkg.version,
    latest,
    type: classifyDiff(pkg.version, latest),
    name: pkg.name,
  };
}

// ─── Package-manager detection ────────────────────────────

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export function detectPackageManager(): PackageManager {
  const bin = process.argv[1] ?? '';
  if (bin.includes('/.bun/')) return 'bun';
  if (bin.includes('/Library/pnpm/') || bin.includes('/.pnpm/')) return 'pnpm';
  if (bin.includes('/.yarn/') || bin.includes('/yarn/global/')) return 'yarn';
  const ua = process.env.npm_config_user_agent ?? '';
  if (ua.startsWith('pnpm')) return 'pnpm';
  if (ua.startsWith('yarn')) return 'yarn';
  if (ua.startsWith('bun')) return 'bun';
  return 'npm';
}

export function installCommand(
  pm: PackageManager,
  pkgName: string,
): { cmd: string; args: string[] } {
  const target = `${pkgName}@latest`;
  switch (pm) {
    case 'pnpm':
      return { cmd: 'pnpm', args: ['add', '-g', target] };
    case 'yarn':
      return { cmd: 'yarn', args: ['global', 'add', target] };
    case 'bun':
      return { cmd: 'bun', args: ['install', '-g', target] };
    default:
      return { cmd: 'npm', args: ['install', '-g', target] };
  }
}

export interface PerformUpdateOptions {
  pm?: PackageManager;
}

export async function performUpdate(
  pkgName: string,
  opts: PerformUpdateOptions = {},
): Promise<{ ok: boolean; pm: PackageManager; code: number | null }> {
  const pm = opts.pm ?? detectPackageManager();
  const { cmd, args } = installCommand(pm, pkgName);

  process.stdout.write(kleur.cyan(`→ ${cmd} ${args.join(' ')}\n`));

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
    child.on('error', (e) => {
      process.stderr.write(kleur.red(`Failed to run ${cmd}: ${e.message}\n`));
      resolve({ ok: false, pm, code: null });
    });
    child.on('exit', (code) => {
      resolve({ ok: code === 0, pm, code });
    });
  });
}

// ─── Auto-update prompt ───────────────────────────────────

/**
 * Called near the very top of main(). On the first interactive call after
 * install, performs a synchronous registry check (with a 3-second timeout).
 * On subsequent calls, uses the cached result.
 *
 * If a newer version is available and the user says yes, runs the install
 * and exits the process.
 *
 * Skipped automatically when:
 *  - CLAUDE_SWITCH_NO_UPDATE_CHECK=1 or NO_UPDATE_NOTIFIER=1
 *  - stdin is not a TTY (scripted/CI use)
 *  - the invoked command is the update command itself, --json, --yes, etc.
 */
export async function maybePromptForUpdate(argv: string[]): Promise<void> {
  if (process.env.CLAUDE_SWITCH_NO_UPDATE_CHECK === '1') return;
  if (process.env.NO_UPDATE_NOTIFIER === '1') return;
  if (process.env.CI === 'true') return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  if (
    argv.includes('--json') ||
    argv.includes('-y') ||
    argv.includes('--yes') ||
    argv.includes('--no-color') ||
    argv.includes('--quiet')
  ) {
    return;
  }
  if (argv[0] === 'update' || argv[0] === '--version' || argv[0] === '-V') {
    return;
  }

  // 1. Try the cache (instant, no network)
  let info = cachedUpdateInfo();

  // 2. If cache miss/stale, do a synchronous fetch with a tight timeout
  if (!info) {
    const cache = readCache();
    const stale =
      !cache ||
      cache.current !== readSelfPackage()?.version ||
      Date.now() - cache.checkedAt > ONE_DAY_MS;
    if (stale) {
      info = await refreshUpdateCache(3000);
    }
  }

  if (!info) return;

  printUpdateBanner(info);

  let answer = false;
  try {
    answer = await confirm({
      message: 'Update now?',
      default: true,
    });
  } catch {
    return;
  }
  if (!answer) {
    process.stdout.write(
      kleur.dim(`  Skipped. Run \`claude-switch update\` later.\n\n`),
    );
    return;
  }

  const result = await performUpdate(info.name);
  if (result.ok) {
    process.stdout.write(
      '\n' +
        kleur.green(`✓ Updated to ${info.latest}.\n`) +
        kleur.dim('  Re-run your command to use the new version.\n'),
    );
  } else {
    const { cmd, args } = installCommand(result.pm, info.name);
    process.stdout.write(
      '\n' +
        kleur.red(`✗ Update failed (exit ${result.code}).\n`) +
        kleur.dim(`  Try manually: ${cmd} ${args.join(' ')}\n`),
    );
  }
  process.exit(result.ok ? 0 : 1);
}

function printUpdateBanner(info: UpdateInfo): void {
  const arrow = kleur.cyan('→');
  process.stdout.write(
    '\n' +
      kleur.bold().yellow('Update available') +
      kleur.dim(` (${info.type})`) +
      `\n  ${kleur.dim(info.current)} ${arrow} ${kleur.green().bold(info.latest)}` +
      `\n  ${kleur.dim('package: ')}${info.name}\n\n`,
  );
}
