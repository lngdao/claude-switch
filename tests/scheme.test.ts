import { describe, expect, it } from 'vitest';
import {
  AUTH_KEYS,
  checkConflicts,
  checkTokenPrefix,
  detectScheme,
  isSecretKey,
  maskValue,
} from '../src/core/scheme.js';

describe('detectScheme', () => {
  it('returns oauth for OAUTH-only env', () => {
    expect(detectScheme({ [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-x' })).toBe('oauth');
  });

  it('returns api-key for API-only env', () => {
    expect(detectScheme({ [AUTH_KEYS.API_KEY]: 'sk-ant-api03-x' })).toBe('api-key');
  });

  it('returns auth-token for ANTHROPIC_AUTH_TOKEN without base url', () => {
    expect(detectScheme({ [AUTH_KEYS.AUTH_TOKEN]: 'x' })).toBe('auth-token');
  });

  it('returns proxy for AUTH_TOKEN + BASE_URL', () => {
    expect(
      detectScheme({
        [AUTH_KEYS.AUTH_TOKEN]: 'x',
        [AUTH_KEYS.BASE_URL]: 'https://anyrouter.top',
      }),
    ).toBe('proxy');
  });

  it('returns custom-base for BASE_URL only', () => {
    expect(detectScheme({ [AUTH_KEYS.BASE_URL]: 'https://x' })).toBe('custom-base');
  });

  it('returns mixed when ≥2 token keys present', () => {
    expect(
      detectScheme({
        [AUTH_KEYS.OAUTH]: 'a',
        [AUTH_KEYS.API_KEY]: 'b',
      }),
    ).toBe('mixed');
    expect(
      detectScheme({
        [AUTH_KEYS.OAUTH]: 'a',
        [AUTH_KEYS.AUTH_TOKEN]: 'b',
      }),
    ).toBe('mixed');
  });

  it('returns empty for empty env', () => {
    expect(detectScheme({})).toBe('empty');
  });

  it('returns unknown for env without auth keys', () => {
    expect(detectScheme({ ENABLE_TOOL_SEARCH: 'true' })).toBe('unknown');
  });
});

describe('checkConflicts', () => {
  it('passes for single auth key', () => {
    expect(checkConflicts({ [AUTH_KEYS.OAUTH]: 'x' })).toEqual({
      ok: true,
      conflicts: [],
    });
  });

  it('reports conflict between OAUTH and API_KEY', () => {
    const r = checkConflicts({
      [AUTH_KEYS.OAUTH]: 'a',
      [AUTH_KEYS.API_KEY]: 'b',
    });
    expect(r.ok).toBe(false);
    expect(r.conflicts).toContain(AUTH_KEYS.OAUTH);
    expect(r.conflicts).toContain(AUTH_KEYS.API_KEY);
  });

  it('reports conflict between OAUTH and AUTH_TOKEN', () => {
    const r = checkConflicts({
      [AUTH_KEYS.OAUTH]: 'a',
      [AUTH_KEYS.AUTH_TOKEN]: 'b',
    });
    expect(r.ok).toBe(false);
  });
});

describe('checkTokenPrefix', () => {
  it('accepts correct OAuth prefix', () => {
    expect(checkTokenPrefix(AUTH_KEYS.OAUTH, 'sk-ant-oat01-abc').ok).toBe(true);
  });

  it('rejects wrong OAuth prefix', () => {
    const r = checkTokenPrefix(AUTH_KEYS.OAUTH, 'sk-foo');
    expect(r.ok).toBe(false);
    expect(r.expected).toBe('sk-ant-oat01-');
  });

  it('accepts correct API_KEY prefix', () => {
    expect(checkTokenPrefix(AUTH_KEYS.API_KEY, 'sk-ant-api03-abc').ok).toBe(true);
  });

  it('skips check for non-prefixed keys', () => {
    expect(checkTokenPrefix(AUTH_KEYS.AUTH_TOKEN, 'literally-anything').ok).toBe(true);
    expect(checkTokenPrefix('SOMETHING_ELSE', 'x').ok).toBe(true);
  });
});

describe('isSecretKey & maskValue', () => {
  it('flags secret-looking keys', () => {
    expect(isSecretKey('CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
    expect(isSecretKey('ANTHROPIC_API_KEY')).toBe(true);
    expect(isSecretKey('MY_SECRET')).toBe(true);
    expect(isSecretKey('PASSWORD')).toBe(true);
  });

  it('does not flag non-secret keys', () => {
    expect(isSecretKey('ANTHROPIC_BASE_URL')).toBe(false);
    expect(isSecretKey('ENABLE_TOOL_SEARCH')).toBe(false);
  });

  it('passes through non-secret values', () => {
    expect(maskValue('ANTHROPIC_BASE_URL', 'https://x')).toBe('https://x');
  });

  it('returns *** for short secrets', () => {
    expect(maskValue('TOKEN', 'short')).toBe('***');
  });

  it('masks long secrets keeping prefix and suffix', () => {
    const masked = maskValue('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAA-zzzz');
    expect(masked).toMatch(/^sk-ant-oat01.*zzzz$/);
    expect(masked).toContain('…');
  });
});
