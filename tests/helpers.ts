import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Paths } from '../src/core/paths.js';

export interface Sandbox {
  root: string;
  paths: Paths;
  cleanup: () => void;
}

export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'cs-test-'));
  const profilesDir = join(root, 'profiles');
  const settings = join(root, 'settings.json');
  const claudeJson = join(root, '.claude.json');
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(settings, JSON.stringify({ env: {} }, null, 2));
  return {
    root,
    paths: { profilesDir, settings, claudeJson },
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

export function writeProfileFile(
  paths: Paths,
  name: string,
  env: Record<string, string>,
): void {
  writeFileSync(
    join(paths.profilesDir, `${name}.json`),
    JSON.stringify({ env }, null, 2),
  );
}

export function writeSettingsRaw(paths: Paths, content: unknown): void {
  writeFileSync(paths.settings, JSON.stringify(content, null, 2));
}
