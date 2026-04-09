import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import updateNotifier from 'update-notifier';
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
  type: 'patch' | 'minor' | 'major' | 'prerelease' | 'build' | 'unknown';
  name: string;
}

/**
 * Read this package's own package.json. After bundling, dist/index.js sits
 * one level below the package root, so '../package.json' is correct in both
 * dev (./dist/index.js) and npm-installed (.../node_modules/<pkg>/dist/...)
 * layouts.
 */
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

const ONE_DAY_MS = 1000 * 60 * 60 * 24;

/**
 * Read cached update info if any, and kick off a background fetch so the
 * next invocation has fresh data. Returns null if there's no cached update
 * or if checks are disabled.
 */
export function cachedUpdateInfo(): UpdateInfo | null {
  if (process.env.CLAUDE_SWITCH_NO_UPDATE_CHECK === '1') return null;
  if (process.env.NO_UPDATE_NOTIFIER === '1') return null;
  const pkg = readSelfPackage();
  if (!pkg?.name || !pkg.version) return null;

  try {
    const notifier = updateNotifier({
      pkg: { name: pkg.name, version: pkg.version },
      updateCheckInterval: ONE_DAY_MS,
      shouldNotifyInNpmScript: false,
    });
    if (!notifier.update) return null;
    const u = notifier.update;
    return {
      current: u.current,
      latest: u.latest,
      type: (u.type as UpdateInfo['type']) ?? 'unknown',
      name: pkg.name,
    };
  } catch {
    return null;
  }
}

// ─── Package-manager detection ─────────────────────────────

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * Heuristically detect which package manager installed this binary so the
 * upgrade command matches. Falls back to npm.
 */
export function detectPackageManager(): PackageManager {
  const bin = process.argv[1] ?? '';
  if (bin.includes('/.bun/')) return 'bun';
  if (bin.includes('/Library/pnpm/') || bin.includes('/.pnpm/')) return 'pnpm';
  if (bin.includes('/.yarn/') || bin.includes('/yarn/global/')) return 'yarn';
  // Fall back to environment hints from npm-style invocations
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

// ─── Update execution ──────────────────────────────────────

export interface PerformUpdateOptions {
  pm?: PackageManager;
}

export async function performUpdate(
  pkgName: string,
  opts: PerformUpdateOptions = {},
): Promise<{ ok: boolean; pm: PackageManager; code: number | null }> {
  const pm = opts.pm ?? detectPackageManager();
  const { cmd, args } = installCommand(pm, pkgName);

  process.stdout.write(
    kleur.cyan(`→ ${cmd} ${args.join(' ')}\n`),
  );

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', (e) => {
      process.stderr.write(
        kleur.red(`Failed to run ${cmd}: ${e.message}\n`),
      );
      resolve({ ok: false, pm, code: null });
    });
    child.on('exit', (code) => {
      resolve({ ok: code === 0, pm, code });
    });
  });
}

// ─── Auto-update prompt ────────────────────────────────────

/**
 * Called near the very top of main(). If a cached update exists and we're
 * running interactively, ask the user whether to install it now. If they
 * say yes, run the install and exit (the running process is using the old
 * code; we tell the user to re-run rather than try to re-exec ourselves).
 *
 * Returns true if the prompt fired AND the user chose to update — caller
 * should NOT continue with the user's original command in that case
 * (we exit from inside this function).
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

  // Skip the prompt for non-interactive flag combos so scripts aren't
  // surprised by an unexpected question.
  if (
    argv.includes('--json') ||
    argv.includes('-y') ||
    argv.includes('--yes') ||
    argv.includes('--no-color') ||
    argv.includes('--quiet')
  ) {
    return;
  }
  // Skip when the user is already asking us to update / check status
  if (argv[0] === 'update' || argv[0] === '--version' || argv[0] === '-V') {
    return;
  }

  const info = cachedUpdateInfo();
  if (!info) return;

  printUpdateBanner(info);

  let answer = false;
  try {
    answer = await confirm({
      message: 'Update now?',
      default: true,
    });
  } catch {
    // User pressed Ctrl-C or prompt was rejected — treat as "no"
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
    process.stdout.write(
      '\n' +
        kleur.red(`✗ Update failed (exit ${result.code}).\n`) +
        kleur.dim(
          `  Try manually: ${installCommand(result.pm, info.name).cmd} ${installCommand(result.pm, info.name).args.join(' ')}\n`,
        ),
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
