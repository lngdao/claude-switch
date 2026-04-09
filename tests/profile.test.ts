import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  cloneProfile,
  deleteProfile,
  detectCurrent,
  isValidProfileName,
  listProfiles,
  profileFile,
  readProfile,
  recordProbe,
  renameProfile,
  summarize,
  writeProfile,
} from '../src/core/profile.js';
import { AUTH_KEYS } from '../src/core/scheme.js';
import { makeSandbox, type Sandbox, writeProfileFile } from './helpers.js';

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

describe('profile name validation', () => {
  it('accepts simple names', () => {
    expect(isValidProfileName('foo')).toBe(true);
    expect(isValidProfileName('foo-bar_1')).toBe(true);
  });
  it('accepts names with spaces', () => {
    expect(isValidProfileName('Official backup')).toBe(true);
  });
  it('rejects empty / weird chars', () => {
    expect(isValidProfileName('')).toBe(false);
    expect(isValidProfileName('../etc/passwd')).toBe(false);
    expect(isValidProfileName('foo/bar')).toBe(false);
  });
});

describe('list / read / write profile', () => {
  it('returns empty list when no profiles', () => {
    expect(listProfiles(box.paths)).toEqual([]);
  });

  it('writes and reads back a profile', () => {
    writeProfile(box.paths, 'foo', {
      env: { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-x' },
    });
    expect(listProfiles(box.paths)).toEqual(['foo']);
    const back = readProfile(box.paths, 'foo');
    expect(back.env[AUTH_KEYS.OAUTH]).toBe('sk-ant-oat01-x');
    expect(back.meta?.createdAt).toBeDefined();
    expect(back.meta?.updatedAt).toBeDefined();
  });

  it('lists profiles sorted lexicographically', () => {
    writeProfileFile(box.paths, 'zebra', {});
    writeProfileFile(box.paths, 'apple', {});
    writeProfileFile(box.paths, 'mango', {});
    expect(listProfiles(box.paths)).toEqual(['apple', 'mango', 'zebra']);
  });

  it('handles names with spaces', () => {
    writeProfile(box.paths, 'Official backup', {
      env: { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-x' },
    });
    expect(listProfiles(box.paths)).toContain('Official backup');
  });

  it('rejects conflicting auth keys without --force', () => {
    expect(() =>
      writeProfile(box.paths, 'bad', {
        env: {
          [AUTH_KEYS.OAUTH]: 'a',
          [AUTH_KEYS.API_KEY]: 'b',
        },
      }),
    ).toThrowError(/conflicting/);
  });

  it('allows conflicts with force=true', () => {
    expect(() =>
      writeProfile(
        box.paths,
        'bad',
        {
          env: {
            [AUTH_KEYS.OAUTH]: 'a',
            [AUTH_KEYS.API_KEY]: 'b',
          },
        },
        { force: true },
      ),
    ).not.toThrow();
  });

  it('writes profile file with mode 600', () => {
    writeProfile(box.paths, 'foo', {
      env: { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-x' },
    });
    const { statSync } = require('node:fs') as typeof import('node:fs');
    const mode = statSync(profileFile(box.paths, 'foo')).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('rename / clone / delete', () => {
  beforeEach(() => {
    writeProfile(box.paths, 'src', {
      env: { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-x' },
    });
  });

  it('renames a profile', () => {
    renameProfile(box.paths, 'src', 'dst');
    expect(listProfiles(box.paths)).toEqual(['dst']);
  });

  it('rename rejects existing target', () => {
    writeProfile(box.paths, 'dst', { env: {} }, { force: true });
    expect(() => renameProfile(box.paths, 'src', 'dst')).toThrowError(/already exists/);
  });

  it('clones a profile (independent copy)', () => {
    cloneProfile(box.paths, 'src', 'copy');
    const orig = readProfile(box.paths, 'src');
    const copy = readProfile(box.paths, 'copy');
    expect(copy.env[AUTH_KEYS.OAUTH]).toBe(orig.env[AUTH_KEYS.OAUTH]);
    // mutating copy doesn't affect orig
    writeProfile(box.paths, 'copy', { env: { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-y' } });
    expect(readProfile(box.paths, 'src').env[AUTH_KEYS.OAUTH]).toBe(orig.env[AUTH_KEYS.OAUTH]);
  });

  it('deletes a profile', () => {
    deleteProfile(box.paths, 'src');
    expect(existsSync(profileFile(box.paths, 'src'))).toBe(false);
  });

  it('delete throws on missing', () => {
    expect(() => deleteProfile(box.paths, 'nope')).toThrowError(/not found/);
  });
});

describe('detectCurrent', () => {
  it('returns (custom) when no match', () => {
    writeProfile(box.paths, 'a', { env: { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-a' } });
    expect(detectCurrent(box.paths, { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-z' })).toBe('(custom)');
  });

  it('returns matching profile name', () => {
    writeProfile(box.paths, 'a', { env: { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-a' } });
    writeProfile(box.paths, 'b', { env: { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-b' } });
    expect(detectCurrent(box.paths, { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-b' })).toBe('b');
  });

  it('does not require key order to match', () => {
    writeProfile(box.paths, 'p', {
      env: {
        [AUTH_KEYS.AUTH_TOKEN]: 'x',
        [AUTH_KEYS.BASE_URL]: 'https://y',
      },
    });
    // Different insertion order
    expect(
      detectCurrent(box.paths, {
        [AUTH_KEYS.BASE_URL]: 'https://y',
        [AUTH_KEYS.AUTH_TOKEN]: 'x',
      }),
    ).toBe('p');
  });
});

describe('recordProbe', () => {
  beforeEach(() => {
    writeProfile(box.paths, 'p', {
      env: { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-a' },
    });
  });

  it('persists a probe record into meta.lastProbe', () => {
    recordProbe(box.paths, 'p', {
      at: '2026-04-09T00:00:00.000Z',
      severity: 'ok',
      title: 'Probe p: token valid',
      detail: 'cost: 22 in + 1 out',
    });
    const back = readProfile(box.paths, 'p');
    expect(back.meta?.lastProbe?.severity).toBe('ok');
    expect(back.meta?.lastProbe?.at).toBe('2026-04-09T00:00:00.000Z');
    expect(back.meta?.lastProbe?.detail).toContain('cost');
  });

  it('overwrites previous probe record', () => {
    recordProbe(box.paths, 'p', {
      at: '2026-04-09T00:00:00.000Z',
      severity: 'error',
      title: 'first',
    });
    recordProbe(box.paths, 'p', {
      at: '2026-04-09T01:00:00.000Z',
      severity: 'ok',
      title: 'second',
    });
    const back = readProfile(box.paths, 'p');
    expect(back.meta?.lastProbe?.title).toBe('second');
    expect(back.meta?.lastProbe?.severity).toBe('ok');
  });

  it('does not bump meta.updatedAt', () => {
    const before = readProfile(box.paths, 'p').meta?.updatedAt;
    recordProbe(box.paths, 'p', {
      at: '2026-04-09T00:00:00.000Z',
      severity: 'ok',
      title: 'x',
    });
    const after = readProfile(box.paths, 'p').meta?.updatedAt;
    expect(after).toBe(before);
  });

  it('survives a profile that has conflicting auth keys (no validation)', () => {
    // Force-write a conflicting profile by hand
    const fs = require('node:fs') as typeof import('node:fs');
    fs.writeFileSync(
      profileFile(box.paths, 'bad'),
      JSON.stringify({
        env: {
          [AUTH_KEYS.OAUTH]: 'a',
          [AUTH_KEYS.API_KEY]: 'b',
        },
      }),
    );
    expect(() =>
      recordProbe(box.paths, 'bad', {
        at: '2026-04-09T00:00:00.000Z',
        severity: 'error',
        title: 'conflict',
      }),
    ).not.toThrow();
    // The raw file should now contain the probe record
    const raw = JSON.parse(
      fs.readFileSync(profileFile(box.paths, 'bad'), 'utf8'),
    );
    expect(raw.meta.lastProbe.title).toBe('conflict');
  });
});

describe('summarize', () => {
  it('marks the active profile', () => {
    writeProfile(box.paths, 'a', { env: { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-a' } });
    writeProfile(box.paths, 'b', { env: { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-b' } });
    const sums = summarize(box.paths, { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-a' });
    const a = sums.find((s) => s.name === 'a')!;
    const b = sums.find((s) => s.name === 'b')!;
    expect(a.active).toBe(true);
    expect(b.active).toBe(false);
    expect(a.scheme).toBe('oauth');
  });

  it('handles invalid profile gracefully', () => {
    writeProfile(box.paths, 'good', { env: {} });
    // create a broken profile file
    const path = profileFile(box.paths, 'broken');
    require('node:fs').writeFileSync(path, '{ not json');
    const sums = summarize(box.paths, {});
    const broken = sums.find((s) => s.name === 'broken')!;
    expect(broken).toBeDefined();
    expect(broken.scheme).toBe('unknown');
    void readFileSync;
  });
});
