import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  applyEnvToSettings,
  readSettings,
  readSettingsEnv,
} from '../src/core/settings.js';
import { makeSandbox, type Sandbox, writeSettingsRaw } from './helpers.js';

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

describe('applyEnvToSettings', () => {
  it('replaces .env block while preserving non-env top-level keys', () => {
    writeSettingsRaw(box.paths, {
      env: { OLD_KEY: 'old' },
      otherKey: 'preserved',
      nested: { foo: 'bar' },
    });
    applyEnvToSettings(box.paths, { NEW_KEY: 'new' });
    const back = readSettings(box.paths);
    expect(back.env).toEqual({ NEW_KEY: 'new' });
    // typescript doesn't know about extra keys, but the parsed object retains them
    expect((back as Record<string, unknown>).otherKey).toBe('preserved');
    expect((back as Record<string, unknown>).nested).toEqual({ foo: 'bar' });
  });

  it('creates settings with env when calling on a no-env file', () => {
    writeSettingsRaw(box.paths, { otherKey: 'x' });
    applyEnvToSettings(box.paths, { K: 'v' });
    expect(readSettingsEnv(box.paths)).toEqual({ K: 'v' });
  });

  it('rotates backups (.bak)', () => {
    writeSettingsRaw(box.paths, { env: { A: '1' } });
    applyEnvToSettings(box.paths, { A: '2' });
    expect(existsSync(box.paths.settings + '.bak')).toBe(true);
    const backup = JSON.parse(readFileSync(box.paths.settings + '.bak', 'utf8'));
    expect(backup.env.A).toBe('1');
  });

  it('writes settings file with mode 600', () => {
    writeSettingsRaw(box.paths, { env: {} });
    applyEnvToSettings(box.paths, { K: 'v' });
    const { statSync } = require('node:fs') as typeof import('node:fs');
    const mode = statSync(box.paths.settings).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('readSettingsEnv', () => {
  it('returns {} when file missing', () => {
    require('node:fs').rmSync(box.paths.settings);
    expect(readSettingsEnv(box.paths)).toEqual({});
  });

  it('returns {} when file invalid JSON', () => {
    require('node:fs').writeFileSync(box.paths.settings, 'not json');
    expect(readSettingsEnv(box.paths)).toEqual({});
  });
});
