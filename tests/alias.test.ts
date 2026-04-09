import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// We need to override homedir() to point at a sandbox so the alias module
// installs to a temp ~/.bashrc instead of the real one.
let fakeHome: string;
beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'cs-home-'));
  process.env.HOME = fakeHome;
  // Stub out os.homedir via env (Node honors HOME on POSIX)
});
afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

// We import after env is set, but vitest caches modules. Use dynamic import
// inside each test so the alias module re-resolves homedir() each time.
async function importAlias() {
  // Bypass module cache by adding a query string
  return await import('../src/core/alias.js?' + Date.now());
}

describe('detectShells', () => {
  it('returns all known shells with exists=false in empty home', async () => {
    const m = await importAlias();
    const shells = m.detectShells();
    const names = shells.map((s) => s.shell);
    expect(names).toContain('bash');
    expect(names).toContain('zsh');
    expect(names).toContain('fish');
    for (const s of shells) {
      expect(s.exists).toBe(false);
    }
  });

  it('marks shells whose rc file exists', async () => {
    writeFileSync(join(fakeHome, '.zshrc'), '# user zshrc\n');
    const m = await importAlias();
    const shells = m.detectShells();
    expect(shells.find((s) => s.shell === 'zsh')?.exists).toBe(true);
    expect(shells.find((s) => s.shell === 'bash')?.exists).toBe(false);
  });
});

describe('install / uninstall round trip', () => {
  it('appends a marker block on install and removes it on uninstall', async () => {
    writeFileSync(join(fakeHome, '.bashrc'), '# pre-existing line\n');
    const m = await importAlias();
    const installResults = m.installAlias({
      target: '/path/to/claude-switch',
    });
    expect(installResults.find((r) => r.shell === 'bash')?.action).toBe('created');

    const after = readFileSync(join(fakeHome, '.bashrc'), 'utf8');
    expect(after).toContain('# pre-existing line');
    expect(after).toContain(">>> claude-switch alias");
    expect(after).toContain("alias cs='/path/to/claude-switch'");

    const uninstallResults = m.uninstallAlias();
    expect(uninstallResults.find((r) => r.shell === 'bash')?.action).toBe('removed');

    const cleaned = readFileSync(join(fakeHome, '.bashrc'), 'utf8');
    expect(cleaned).not.toContain('claude-switch');
    expect(cleaned).toContain('# pre-existing line');
  });

  it('updates existing block when target changes', async () => {
    writeFileSync(join(fakeHome, '.bashrc'), '');
    const m = await importAlias();
    m.installAlias({ target: '/old/path' });
    const r2 = m.installAlias({ target: '/new/path' });
    expect(r2.find((x) => x.shell === 'bash')?.action).toBe('updated');
    const content = readFileSync(join(fakeHome, '.bashrc'), 'utf8');
    expect(content).toContain('/new/path');
    expect(content).not.toContain('/old/path');
  });

  it('reports noop when re-installing identical alias', async () => {
    writeFileSync(join(fakeHome, '.bashrc'), '');
    const m = await importAlias();
    m.installAlias({ target: '/p' });
    const r2 = m.installAlias({ target: '/p' });
    expect(r2.find((x) => x.shell === 'bash')?.action).toBe('noop');
  });

  it('honors custom alias name', async () => {
    writeFileSync(join(fakeHome, '.zshrc'), '');
    const m = await importAlias();
    m.installAlias({ name: 'cw', target: '/p' });
    const content = readFileSync(join(fakeHome, '.zshrc'), 'utf8');
    expect(content).toContain("alias cw='/p'");
  });

  it('uses fish syntax for fish shell', async () => {
    const fishDir = join(fakeHome, '.config', 'fish');
    mkdirSync(fishDir, { recursive: true });
    writeFileSync(join(fishDir, 'config.fish'), '');
    const m = await importAlias();
    m.installAlias({ target: '/p', shells: ['fish'] });
    const content = readFileSync(join(fishDir, 'config.fish'), 'utf8');
    expect(content).toMatch(/alias cs '\/p'/);
  });

  it('rejects invalid alias name', async () => {
    writeFileSync(join(fakeHome, '.bashrc'), '');
    const m = await importAlias();
    expect(() => m.installAlias({ name: '123bad', target: '/p' })).toThrowError(
      /Invalid alias name/,
    );
  });
});

describe('aliasStatus', () => {
  it('reports installed=false for empty rc file', async () => {
    writeFileSync(join(fakeHome, '.zshrc'), '# nothing\n');
    const m = await importAlias();
    const status = m.aliasStatus();
    const z = status.find((s) => s.shell === 'zsh')!;
    expect(z.installed).toBe(false);
  });

  it('reports installed=true and the current line', async () => {
    writeFileSync(join(fakeHome, '.zshrc'), '');
    const m = await importAlias();
    m.installAlias({ target: '/p' });
    const status = m.aliasStatus();
    const z = status.find((s) => s.shell === 'zsh')!;
    expect(z.installed).toBe(true);
    expect(z.currentLine).toContain("alias cs='/p'");
  });
});
