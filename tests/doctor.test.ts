import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { runDoctor } from '../src/core/doctor.js';
import { writeProfile } from '../src/core/profile.js';
import { AUTH_KEYS } from '../src/core/scheme.js';
import { makeSandbox, type Sandbox, writeProfileFile } from './helpers.js';

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox();
  // Clean shell env so probe-conflict checks are deterministic
  delete process.env[AUTH_KEYS.OAUTH];
  delete process.env[AUTH_KEYS.API_KEY];
  delete process.env[AUTH_KEYS.AUTH_TOKEN];
});
afterEach(() => box.cleanup());

describe('runDoctor', () => {
  it('reports valid empty config without errors', async () => {
    const report = await runDoctor(box.paths);
    expect(report.error).toBe(0);
  });

  it('reports profile conflict as error', async () => {
    writeProfileFile(box.paths, 'bad', {
      [AUTH_KEYS.OAUTH]: 'a',
      [AUTH_KEYS.API_KEY]: 'b',
    });
    const report = await runDoctor(box.paths);
    expect(report.error).toBeGreaterThanOrEqual(1);
    const conflictResult = report.results.find((r) =>
      r.id.startsWith('profile.conflict.'),
    );
    expect(conflictResult?.severity).toBe('error');
  });

  it('reports prefix mismatch as warn', async () => {
    writeProfileFile(box.paths, 'bad', {
      [AUTH_KEYS.OAUTH]: 'sk-foo-bar',
    });
    const report = await runDoctor(box.paths);
    const prefix = report.results.find((r) => r.id.startsWith('profile.prefix.'));
    expect(prefix?.severity).toBe('warn');
  });

  it('reports missing claude.json as warn', async () => {
    const report = await runDoctor(box.paths);
    const claude = report.results.find((r) => r.id === 'claudejson.exists');
    expect(claude?.severity).toBe('warn');
  });

  it('reports valid claude.json with onboarding bypass as ok', async () => {
    writeFileSync(
      box.paths.claudeJson,
      JSON.stringify({
        hasCompletedOnboarding: true,
        lastOnboardingVersion: '2.1.29',
        oauthAccount: {
          accountUuid: 'a',
          emailAddress: 'b',
          organizationUuid: 'c',
        },
      }),
    );
    const report = await runDoctor(box.paths);
    const claude = report.results.find((r) => r.id === 'claudejson.ok');
    expect(claude?.severity).toBe('ok');
  });

  it('detects shell env conflict', async () => {
    process.env[AUTH_KEYS.OAUTH] = 'a';
    process.env[AUTH_KEYS.API_KEY] = 'b';
    const report = await runDoctor(box.paths);
    const conflict = report.results.find((r) => r.id === 'shell.conflict');
    expect(conflict?.severity).toBe('error');
  });

  it('counts ok/warn/error correctly', async () => {
    writeProfile(box.paths, 'good', {
      env: { [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-x' },
    });
    const report = await runDoctor(box.paths);
    expect(report.ok + report.warn + report.error).toBe(report.results.length);
  });
});
