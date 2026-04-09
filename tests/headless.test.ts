import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buildAnsibleSnippet,
  buildBashScript,
  performInit,
  readLocalOauthAccount,
} from '../src/core/headless.js';
import { readProfile } from '../src/core/profile.js';
import { AUTH_KEYS } from '../src/core/scheme.js';
import { makeSandbox, type Sandbox } from './helpers.js';

let box: Sandbox;
beforeEach(() => {
  box = makeSandbox();
});
afterEach(() => box.cleanup());

const validToken = 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const account = {
  accountUuid: '11111111-1111-1111-1111-111111111111',
  emailAddress: 'a@b.com',
  organizationUuid: '22222222-2222-2222-2222-222222222222',
};

describe('performInit', () => {
  it('creates ~/.claude.json with onboarding bypass + oauthAccount', () => {
    const result = performInit(box.paths, {
      token: validToken,
      account,
    });
    expect(existsSync(result.claudeJsonPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(result.claudeJsonPath, 'utf8'));
    expect(parsed.hasCompletedOnboarding).toBe(true);
    expect(parsed.lastOnboardingVersion).toBeDefined();
    expect(parsed.oauthAccount.emailAddress).toBe('a@b.com');
  });

  it('creates default profile named "oauth"', () => {
    performInit(box.paths, { token: validToken, account });
    const p = readProfile(box.paths, 'oauth');
    expect(p.env[AUTH_KEYS.OAUTH]).toBe(validToken);
  });

  it('honors custom profile name', () => {
    performInit(box.paths, { token: validToken, account, profileName: 'work' });
    const p = readProfile(box.paths, 'work');
    expect(p.env[AUTH_KEYS.OAUTH]).toBe(validToken);
  });

  it('rejects invalid token prefix', () => {
    expect(() =>
      performInit(box.paths, { token: 'sk-bad', account }),
    ).toThrowError(/sk-ant-oat01/);
  });
});

describe('readLocalOauthAccount', () => {
  it('returns null when file missing', () => {
    expect(readLocalOauthAccount(box.paths)).toBeNull();
  });

  it('returns null when oauthAccount missing', () => {
    writeFileSync(box.paths.claudeJson, JSON.stringify({ hasCompletedOnboarding: true }));
    expect(readLocalOauthAccount(box.paths)).toBeNull();
  });

  it('returns parsed oauthAccount', () => {
    writeFileSync(
      box.paths.claudeJson,
      JSON.stringify({ oauthAccount: account }),
    );
    expect(readLocalOauthAccount(box.paths)).toEqual(account);
  });
});

describe('buildBashScript', () => {
  it('contains export and onboarding bypass JSON', () => {
    const out = buildBashScript({ token: validToken, account });
    expect(out).toContain(`CLAUDE_CODE_OAUTH_TOKEN="${validToken}"`);
    expect(out).toContain('hasCompletedOnboarding');
    expect(out).toContain('a@b.com');
  });
});

describe('buildAnsibleSnippet', () => {
  it('contains both tasks', () => {
    const out = buildAnsibleSnippet({ token: validToken, account });
    expect(out).toContain('Configure Claude Code OAuth token');
    expect(out).toContain('Configure Claude Code onboarding bypass');
    expect(out).toContain(validToken);
  });
});
