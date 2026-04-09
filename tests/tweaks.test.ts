import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { TWEAKS, getTweak } from '../src/core/tweaks.js';
import { makeSandbox, type Sandbox, writeSettingsRaw } from './helpers.js';

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

describe('tweak registry', () => {
  it('contains both expected tweaks', () => {
    const ids = TWEAKS.map((t) => t.id);
    expect(ids).toContain('bypass-onboarding');
    expect(ids).toContain('opus-1m');
  });

  it('getTweak returns by id', () => {
    expect(getTweak('opus-1m')?.id).toBe('opus-1m');
    expect(getTweak('nonsense')).toBeUndefined();
  });
});

describe('opus-1m tweak', () => {
  it('reports not-applied initially', async () => {
    writeSettingsRaw(box.paths, { env: {} });
    const t = getTweak('opus-1m')!;
    expect(await t.status(box.paths)).toBe('not-applied');
  });

  it('adds model field, preserving existing keys', async () => {
    writeSettingsRaw(box.paths, { env: { K: 'v' }, otherKey: 'preserved' });
    const t = getTweak('opus-1m')!;
    const summary = await t.apply(box.paths);
    expect(summary).toContain('opus[1m]');
    const back = JSON.parse(readFileSync(box.paths.settings, 'utf8'));
    expect(back.model).toBe('opus[1m]');
    expect(back.otherKey).toBe('preserved');
    expect(back.env).toEqual({ K: 'v' });
  });

  it('reports applied after apply', async () => {
    writeSettingsRaw(box.paths, { env: {} });
    const t = getTweak('opus-1m')!;
    await t.apply(box.paths);
    expect(await t.status(box.paths)).toBe('applied');
  });

  it('handles missing settings.json (creates from scratch)', async () => {
    // settings.json initially exists from sandbox fixture; remove it
    require('node:fs').rmSync(box.paths.settings);
    const t = getTweak('opus-1m')!;
    await t.apply(box.paths);
    expect(existsSync(box.paths.settings)).toBe(true);
    const back = JSON.parse(readFileSync(box.paths.settings, 'utf8'));
    expect(back.model).toBe('opus[1m]');
  });

  it('reapply is noop for status', async () => {
    writeSettingsRaw(box.paths, { env: {} });
    const t = getTweak('opus-1m')!;
    await t.apply(box.paths);
    const summary = await t.apply(box.paths);
    expect(summary).toContain('already');
  });
});

describe('bypass-onboarding tweak', () => {
  it('reports not-applied when claude.json missing', async () => {
    const t = getTweak('bypass-onboarding')!;
    expect(await t.status(box.paths)).toBe('not-applied');
  });

  it('creates claude.json with hasCompletedOnboarding=true', async () => {
    const t = getTweak('bypass-onboarding')!;
    await t.apply(box.paths);
    expect(existsSync(box.paths.claudeJson)).toBe(true);
    const back = JSON.parse(readFileSync(box.paths.claudeJson, 'utf8'));
    expect(back.hasCompletedOnboarding).toBe(true);
  });

  it('preserves existing oauthAccount', async () => {
    writeFileSync(
      box.paths.claudeJson,
      JSON.stringify({
        oauthAccount: {
          accountUuid: 'a',
          emailAddress: 'b',
          organizationUuid: 'c',
        },
        somethingElse: 42,
      }),
    );
    const t = getTweak('bypass-onboarding')!;
    await t.apply(box.paths);
    const back = JSON.parse(readFileSync(box.paths.claudeJson, 'utf8'));
    expect(back.hasCompletedOnboarding).toBe(true);
    expect(back.oauthAccount.emailAddress).toBe('b');
    expect(back.somethingElse).toBe(42);
  });

  it('reports applied after apply', async () => {
    const t = getTweak('bypass-onboarding')!;
    await t.apply(box.paths);
    expect(await t.status(box.paths)).toBe('applied');
  });

  it('reapply is noop when version matches', async () => {
    const t = getTweak('bypass-onboarding')!;
    await t.apply(box.paths);
    // Read what was set, then reapply — should detect noop
    const before = readFileSync(box.paths.claudeJson, 'utf8');
    await t.apply(box.paths);
    const after = readFileSync(box.paths.claudeJson, 'utf8');
    // Content should be unchanged (same version path)
    // Note: if the test environment has claude on PATH, version is detected;
    // if not, version is empty and reapply is also noop. Either way the file
    // shouldn't change.
    expect(after).toBe(before);
  });

  it('handles a corrupt claude.json gracefully (overwrites)', async () => {
    writeFileSync(box.paths.claudeJson, 'not json {{');
    const t = getTweak('bypass-onboarding')!;
    await t.apply(box.paths);
    const back = JSON.parse(readFileSync(box.paths.claudeJson, 'utf8'));
    expect(back.hasCompletedOnboarding).toBe(true);
  });
});
