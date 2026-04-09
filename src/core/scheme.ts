export type AuthScheme =
  | 'oauth'
  | 'api-key'
  | 'auth-token'
  | 'proxy'
  | 'custom-base'
  | 'mixed'
  | 'empty'
  | 'unknown';

export const AUTH_KEYS = {
  OAUTH: 'CLAUDE_CODE_OAUTH_TOKEN',
  API_KEY: 'ANTHROPIC_API_KEY',
  AUTH_TOKEN: 'ANTHROPIC_AUTH_TOKEN',
  BASE_URL: 'ANTHROPIC_BASE_URL',
} as const;

export const TOKEN_PREFIXES: Record<string, string> = {
  [AUTH_KEYS.OAUTH]: 'sk-ant-oat01-',
  [AUTH_KEYS.API_KEY]: 'sk-ant-api03-',
};

export function detectScheme(env: Record<string, string>): AuthScheme {
  const hasOauth = !!env[AUTH_KEYS.OAUTH];
  const hasApi = !!env[AUTH_KEYS.API_KEY];
  const hasAuthToken = !!env[AUTH_KEYS.AUTH_TOKEN];
  const hasBaseUrl = !!env[AUTH_KEYS.BASE_URL];

  const tokenCount = [hasOauth, hasApi, hasAuthToken].filter(Boolean).length;

  if (tokenCount > 1) return 'mixed';
  if (hasOauth) return 'oauth';
  if (hasApi) return 'api-key';
  if (hasAuthToken) return hasBaseUrl ? 'proxy' : 'auth-token';
  if (hasBaseUrl) return 'custom-base';
  if (Object.keys(env).length === 0) return 'empty';
  return 'unknown';
}

export interface ConflictResult {
  ok: boolean;
  conflicts: string[];
}

export function checkConflicts(env: Record<string, string>): ConflictResult {
  const present: string[] = [];
  if (env[AUTH_KEYS.OAUTH]) present.push(AUTH_KEYS.OAUTH);
  if (env[AUTH_KEYS.API_KEY]) present.push(AUTH_KEYS.API_KEY);
  if (env[AUTH_KEYS.AUTH_TOKEN]) present.push(AUTH_KEYS.AUTH_TOKEN);

  if (present.length > 1) {
    return {
      ok: false,
      conflicts: present,
    };
  }
  return { ok: true, conflicts: [] };
}

export interface PrefixCheck {
  ok: boolean;
  expected?: string;
}

export function checkTokenPrefix(key: string, value: string): PrefixCheck {
  const expected = TOKEN_PREFIXES[key];
  if (!expected) return { ok: true };
  return { ok: value.startsWith(expected), expected };
}

const SECRET_PATTERN = /TOKEN|KEY|SECRET|PASSWORD/i;

export function isSecretKey(key: string): boolean {
  return SECRET_PATTERN.test(key);
}

export function maskValue(key: string, value: string): string {
  if (!isSecretKey(key)) return value;
  if (value.length <= 16) return '***';
  return `${value.slice(0, 12)}…${value.slice(-4)}`;
}

export function schemeBadge(scheme: AuthScheme): string {
  switch (scheme) {
    case 'oauth':
      return 'oauth';
    case 'api-key':
      return 'api-key';
    case 'auth-token':
      return 'auth-token';
    case 'proxy':
      return 'proxy';
    case 'custom-base':
      return 'custom-base';
    case 'mixed':
      return 'MIXED!';
    case 'empty':
      return 'empty';
    case 'unknown':
      return 'unknown';
  }
}
