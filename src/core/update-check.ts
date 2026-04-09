import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { confirm } from '@inquirer/prompts';
import kleur from 'kleur';

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

// ─── Self package info ────────────────────────────────────

/**
 * Walk up from this file looking for the closest package.json. This works
 * regardless of bundling, symlinks, or how deep into node_modules the bundle
 * lives — same approach OpenACP uses (`src/cli/version.ts:findPackageJson`).
 */
function findPackageJson(): string | null {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const candidate = join(dir, 'package.json');
      if (existsSync(candidate)) return candidate;
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* swallow */
  }
  return null;
}

export function readSelfPackage(): PackageJson | null {
  const path = findPackageJson();
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

// ─── Version comparison (date-based YYYY.MMDD.N safe) ─────

/**
 * Returns true iff `latest` is strictly greater than `current`.
 * Works for both classic semver and the date-based YYYY.MMDD.N scheme.
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

export async function fetchLatestVersion(
  packageName: string,
  timeoutMs = 5000,
): Promise<string | null> {
  const url = `https://registry.npmjs.org/${packageName}/latest`;
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

/**
 * Synchronously fetch the latest version and compare to the running one.
 * Always hits the npm registry — no caching, so there are no stale-cache
 * surprises. Returns null when offline, the package isn't found, or there's
 * no newer version available.
 */
export async function checkUpdate(timeoutMs = 5000): Promise<UpdateInfo | null> {
  const pkg = readSelfPackage();
  if (!pkg?.name || !pkg.version) return null;
  const latest = await fetchLatestVersion(pkg.name, timeoutMs);
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

  return new Promise((resolveSpawn) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env: process.env, shell: true });
    const onSignal = () => {
      child.kill('SIGTERM');
      resolveSpawn({ ok: false, pm, code: null });
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    child.on('error', (e) => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.stderr.write(kleur.red(`Failed to run ${cmd}: ${e.message}\n`));
      resolveSpawn({ ok: false, pm, code: null });
    });
    child.on('close', (code) => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      resolveSpawn({ ok: code === 0, pm, code });
    });
  });
}

// ─── Auto-update prompt ───────────────────────────────────

/**
 * Called near the very top of main(). Hits the npm registry to check for a
 * newer version on every interactive invocation — no caching, so there are
 * no stale-state surprises. If a newer version is available, shows a prompt;
 * confirming spawns the install command and exits the process.
 *
 * Skipped automatically when:
 *  - CLAUDE_SWITCH_NO_UPDATE_CHECK=1 or NO_UPDATE_NOTIFIER=1 is set
 *  - stdin is not a TTY (scripted/CI use)
 *  - the version looks like a development build
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

  const pkg = readSelfPackage();
  if (!pkg?.version || pkg.version === '0.0.0' || pkg.version.endsWith('-dev')) return;

  const info = await checkUpdate(3000);
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
