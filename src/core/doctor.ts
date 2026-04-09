import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  AUTH_KEYS,
  checkConflicts,
  checkTokenPrefix,
  detectScheme,
} from './scheme.js';
import { listProfiles, readProfile, recordProbe } from './profile.js';
import { readSettings } from './settings.js';
import { ClaudeJsonSchema } from './schema.js';
import { chmodSafe, getMode } from './fs-safe.js';
import type { Paths } from './paths.js';

const pExecFile = promisify(execFile);

export type Severity = 'ok' | 'warn' | 'error';

export interface CheckResult {
  id: string;
  severity: Severity;
  title: string;
  detail?: string;
  fix?: string;
  /** If set and `--fix` is passed, this fixer will be invoked. */
  fixer?: () => boolean;
}

export interface DoctorOptions {
  probe?: boolean;
  fix?: boolean;
}

export interface DoctorReport {
  results: CheckResult[];
  ok: number;
  warn: number;
  error: number;
}

export async function runDoctor(paths: Paths, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const results: CheckResult[] = [];

  // 1. settings.json exists & valid
  results.push(checkSettings(paths));

  // 2. profiles dir exists & each profile valid
  results.push(...checkProfiles(paths));

  // 3. ~/.claude.json onboarding bypass
  results.push(checkClaudeJson(paths));

  // 4. shell env conflict
  results.push(checkShellEnvConflict());

  // 5. file permissions
  results.push(...checkPermissions(paths, opts.fix === true));

  // 6. settings vs profiles consistency (current profile detection sanity)
  results.push(checkSettingsEnvSanity(paths));

  // 7. version drift between installed claude and lastOnboardingVersion
  const drift = await checkVersionDrift(paths);
  if (drift) results.push(drift);

  // 8. token probe (optional)
  if (opts.probe) {
    const probeResults = await probeAllTokens(paths);
    results.push(...probeResults);
  }

  let ok = 0;
  let warn = 0;
  let error = 0;
  for (const r of results) {
    if (r.severity === 'ok') ok++;
    else if (r.severity === 'warn') warn++;
    else error++;
  }
  return { results, ok, warn, error };
}

function checkSettings(paths: Paths): CheckResult {
  if (!existsSync(paths.settings)) {
    return {
      id: 'settings.exists',
      severity: 'warn',
      title: 'settings.json missing',
      detail: `Expected at ${paths.settings}`,
      fix: 'Will be created automatically on `claude-switch use <name>`.',
    };
  }
  try {
    readSettings(paths);
  } catch (e) {
    return {
      id: 'settings.valid',
      severity: 'error',
      title: 'settings.json invalid',
      detail: (e as Error).message,
    };
  }
  return { id: 'settings.valid', severity: 'ok', title: 'settings.json is valid' };
}

function checkProfiles(paths: Paths): CheckResult[] {
  const out: CheckResult[] = [];
  if (!existsSync(paths.profilesDir)) {
    out.push({
      id: 'profiles.dir',
      severity: 'warn',
      title: 'profiles dir missing',
      detail: `Expected at ${paths.profilesDir}`,
      fix: 'Will be created on first `claude-switch add`.',
    });
    return out;
  }

  const names = listProfiles(paths);
  if (names.length === 0) {
    out.push({
      id: 'profiles.count',
      severity: 'warn',
      title: 'No profiles found',
      fix: 'Run `claude-switch add` or `claude-switch init`.',
    });
    return out;
  }

  let bad = 0;
  for (const name of names) {
    try {
      const p = readProfile(paths, name);
      const conflict = checkConflicts(p.env);
      if (!conflict.ok) {
        out.push({
          id: `profile.conflict.${name}`,
          severity: 'error',
          title: `Profile '${name}' has conflicting auth keys`,
          detail: conflict.conflicts.join(' + '),
          fix: 'Edit the profile and remove all but one auth key.',
        });
        bad++;
        continue;
      }
      // prefix check
      for (const [k, v] of Object.entries(p.env)) {
        const pre = checkTokenPrefix(k, v);
        if (!pre.ok) {
          out.push({
            id: `profile.prefix.${name}.${k}`,
            severity: 'warn',
            title: `Profile '${name}': ${k} has unexpected prefix`,
            detail: `Expected to start with '${pre.expected}'`,
          });
        }
      }
    } catch (e) {
      out.push({
        id: `profile.parse.${name}`,
        severity: 'error',
        title: `Profile '${name}' is invalid`,
        detail: (e as Error).message,
      });
      bad++;
    }
  }

  if (bad === 0) {
    out.push({
      id: 'profiles.count',
      severity: 'ok',
      title: `${names.length} profile${names.length === 1 ? '' : 's'} valid`,
    });
  }
  return out;
}

function checkClaudeJson(paths: Paths): CheckResult {
  if (!existsSync(paths.claudeJson)) {
    return {
      id: 'claudejson.exists',
      severity: 'warn',
      title: '~/.claude.json missing (no onboarding bypass)',
      detail:
        'Required for headless mode. Run `claude-switch init` to create it.',
    };
  }
  try {
    const raw = JSON.parse(readFileSync(paths.claudeJson, 'utf8'));
    const parsed = ClaudeJsonSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        id: 'claudejson.valid',
        severity: 'error',
        title: '~/.claude.json invalid',
        detail: parsed.error.issues.map((i) => i.message).join('; '),
      };
    }
    if (!parsed.data.hasCompletedOnboarding) {
      return {
        id: 'claudejson.onboarding',
        severity: 'warn',
        title: 'Onboarding not marked complete',
        fix: 'Run `claude-switch init` or set hasCompletedOnboarding: true.',
      };
    }
    if (!parsed.data.oauthAccount) {
      return {
        id: 'claudejson.oauth',
        severity: 'warn',
        title: 'No oauthAccount in ~/.claude.json',
        fix: 'Run `claude-switch init` to populate.',
      };
    }
    return {
      id: 'claudejson.ok',
      severity: 'ok',
      title: '~/.claude.json is valid (onboarding bypass active)',
    };
  } catch (e) {
    return {
      id: 'claudejson.parse',
      severity: 'error',
      title: '~/.claude.json: parse error',
      detail: (e as Error).message,
    };
  }
}

function checkShellEnvConflict(): CheckResult {
  const set: string[] = [];
  if (process.env[AUTH_KEYS.OAUTH]) set.push(AUTH_KEYS.OAUTH);
  if (process.env[AUTH_KEYS.API_KEY]) set.push(AUTH_KEYS.API_KEY);
  if (process.env[AUTH_KEYS.AUTH_TOKEN]) set.push(AUTH_KEYS.AUTH_TOKEN);

  if (set.length > 1) {
    return {
      id: 'shell.conflict',
      severity: 'error',
      title: 'Multiple auth env vars exported in current shell',
      detail: set.join(', '),
      fix: `Unset all but one: \`unset ${set.slice(1).join(' ')}\``,
    };
  }
  if (set.length === 1) {
    return {
      id: 'shell.conflict',
      severity: 'ok',
      title: `Shell exports ${set[0]} (single auth)`,
    };
  }
  return {
    id: 'shell.conflict',
    severity: 'ok',
    title: 'No conflicting auth env vars in shell',
  };
}

function checkPermissions(paths: Paths, autoFix: boolean): CheckResult[] {
  const out: CheckResult[] = [];
  const targets = [paths.settings, paths.claudeJson];
  for (const name of listProfiles(paths)) {
    const f = `${paths.profilesDir}/${name}.json`;
    targets.push(f);
  }

  for (const f of targets) {
    if (!existsSync(f)) continue;
    const mode = getMode(f);
    if (mode === null) continue;
    if (mode === 0o600) {
      out.push({
        id: `perm.${f}`,
        severity: 'ok',
        title: `${shortPath(f)} permissions OK (600)`,
      });
    } else {
      let fixed = false;
      if (autoFix) fixed = chmodSafe(f, 0o600);
      out.push({
        id: `perm.${f}`,
        severity: fixed ? 'ok' : 'warn',
        title: fixed
          ? `${shortPath(f)} permissions fixed → 600`
          : `${shortPath(f)} has loose permissions: ${mode.toString(8)}`,
        fix: fixed ? undefined : `chmod 600 ${f}`,
        fixer: () => chmodSafe(f, 0o600),
      });
    }
  }
  return out;
}

function checkSettingsEnvSanity(paths: Paths): CheckResult {
  try {
    const env = readSettings(paths).env ?? {};
    const conflict = checkConflicts(env);
    if (!conflict.ok) {
      return {
        id: 'settings.envconflict',
        severity: 'error',
        title: 'settings.json has conflicting auth keys',
        detail: conflict.conflicts.join(' + '),
        fix: 'Edit settings.json or switch to a clean profile.',
      };
    }
    return {
      id: 'settings.envconflict',
      severity: 'ok',
      title: `settings.json env scheme: ${detectScheme(env)}`,
    };
  } catch {
    return {
      id: 'settings.envconflict',
      severity: 'warn',
      title: 'Could not parse settings.json env',
    };
  }
}

async function checkVersionDrift(paths: Paths): Promise<CheckResult | null> {
  if (!existsSync(paths.claudeJson)) return null;
  let recordedVersion: string | undefined;
  try {
    const raw = JSON.parse(readFileSync(paths.claudeJson, 'utf8'));
    const parsed = ClaudeJsonSchema.safeParse(raw);
    if (!parsed.success) return null;
    recordedVersion = parsed.data.lastOnboardingVersion;
  } catch {
    return null;
  }
  if (!recordedVersion) return null;

  let installedVersion: string | null = null;
  try {
    // Race against a 2s timeout so a slow `claude` doesn't hang the doctor.
    const result = await Promise.race([
      pExecFile('claude', ['--version'], { timeout: 2000 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), 2500),
      ),
    ]);
    installedVersion = parseClaudeVersion(result.stdout || result.stderr || '');
  } catch {
    // claude not on PATH or timed out — not an error, just skip the check
    return {
      id: 'version.drift',
      severity: 'ok',
      title: 'Version drift check skipped (claude CLI not available)',
    };
  }

  if (!installedVersion) {
    return {
      id: 'version.drift',
      severity: 'warn',
      title: `Could not parse 'claude --version' output`,
    };
  }

  if (installedVersion === recordedVersion) {
    return {
      id: 'version.drift',
      severity: 'ok',
      title: `Version match: claude ${installedVersion} == lastOnboardingVersion`,
    };
  }

  return {
    id: 'version.drift',
    severity: 'warn',
    title: `Version drift: installed claude ${installedVersion} ≠ lastOnboardingVersion ${recordedVersion}`,
    detail:
      'Onboarding bypass may break if Claude Code changed its onboarding flow.',
    fix: `Update ~/.claude.json: lastOnboardingVersion = "${installedVersion}"`,
  };
}

function parseClaudeVersion(output: string): string | null {
  // typical: "2.1.29 (Claude Code)" or just "2.1.29"
  const match = output.trim().match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
  return match ? match[1]! : null;
}

async function probeAllTokens(paths: Paths): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const name of listProfiles(paths)) {
    try {
      const p = readProfile(paths, name);
      const result = await probeProfile(name, p.env);
      persistProbe(paths, name, result);
      out.push(result);
    } catch (e) {
      const result: CheckResult = {
        id: `probe.${name}`,
        severity: 'warn',
        title: `Probe skipped: ${name}`,
        detail: (e as Error).message,
      };
      persistProbe(paths, name, result);
      out.push(result);
    }
  }
  return out;
}

/** Public: probe a single profile by name. Used by TUI. */
export async function probeOne(paths: Paths, name: string): Promise<CheckResult> {
  let result: CheckResult;
  try {
    const p = readProfile(paths, name);
    result = await probeProfile(name, p.env);
  } catch (e) {
    result = {
      id: `probe.${name}`,
      severity: 'warn',
      title: `Probe skipped: ${name}`,
      detail: (e as Error).message,
    };
  }
  persistProbe(paths, name, result);
  return result;
}

function persistProbe(paths: Paths, name: string, r: CheckResult): void {
  try {
    recordProbe(paths, name, {
      at: new Date().toISOString(),
      severity: r.severity,
      title: r.title,
      detail: r.detail,
    });
  } catch {
    /* don't let persistence break the probe itself */
  }
}

/**
 * Probe a profile's auth credentials.
 *
 * - OAuth tokens (`sk-ant-oat01-*`) require Claude Code's exact protocol:
 *   POST /v1/messages with `anthropic-beta: oauth-2025-04-20` and a system
 *   prompt identifying the request as Claude Code. Without these, Anthropic
 *   returns 401 "OAuth authentication is currently not supported". The
 *   minimum-cost probe is `max_tokens: 1` against `claude-haiku-4-5-20251001`
 *   (~21 input + 1 output token, < $0.00003 each).
 *
 * - API keys (`sk-ant-api03-*`) are validated via POST
 *   `/v1/messages/count_tokens`, which is free.
 *
 * - Generic ANTHROPIC_AUTH_TOKEN (proxy / third-party) is validated against
 *   `/v1/messages/count_tokens` at the configured base URL.
 */

const CLAUDE_CODE_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const PROBE_MODEL = 'claude-haiku-4-5-20251001';

async function probeProfile(
  name: string,
  env: Record<string, string>,
): Promise<CheckResult> {
  const oauth = env[AUTH_KEYS.OAUTH];
  const apiKey = env[AUTH_KEYS.API_KEY];
  const authToken = env[AUTH_KEYS.AUTH_TOKEN];
  const baseUrlOverride = env[AUTH_KEYS.BASE_URL];
  const baseUrl = baseUrlOverride ?? 'https://api.anthropic.com';

  if (oauth) {
    return probeOauthMessages(name, oauth, baseUrl);
  }
  if (apiKey) {
    return probeCountTokens(name, baseUrl, { 'x-api-key': apiKey });
  }
  if (authToken) {
    return probeCountTokens(name, baseUrl, {
      authorization: `Bearer ${authToken}`,
    });
  }

  return {
    id: `probe.${name}`,
    severity: 'warn',
    title: `Probe skipped: ${name} has no token`,
  };
}

/**
 * Probe an OAuth (sk-ant-oat01-*) token by sending a minimal `/v1/messages`
 * request with the exact headers + system prompt Claude Code itself uses.
 */
async function probeOauthMessages(
  name: string,
  token: string,
  baseUrl: string,
): Promise<CheckResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const body = JSON.stringify({
    model: PROBE_MODEL,
    max_tokens: 1,
    system: CLAUDE_CODE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: 'hi' }],
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      // Try to extract usage to show how many tokens were burned (transparency)
      let detail: string | undefined;
      try {
        const data = (await res.json()) as
          | { usage?: { input_tokens?: number; output_tokens?: number } }
          | undefined;
        const u = data?.usage;
        if (u) {
          detail = `cost: ${u.input_tokens ?? 0} in + ${u.output_tokens ?? 0} out`;
        }
      } catch {
        /* ignore */
      }
      return {
        id: `probe.${name}`,
        severity: 'ok',
        title: `Probe ${name}: OAuth token valid`,
        detail,
      };
    }

    // Read error body for diagnostics
    let errorMsg: string | undefined;
    try {
      const data = (await res.json()) as
        | { error?: { type?: string; message?: string } }
        | undefined;
      errorMsg = data?.error?.message;
    } catch {
      /* ignore */
    }

    if (res.status === 401) {
      return {
        id: `probe.${name}`,
        severity: 'error',
        title: `Probe ${name}: OAuth token rejected (401)`,
        detail: errorMsg ?? 'Token expired or revoked. Run `claude setup-token` to refresh.',
      };
    }
    if (res.status === 403) {
      // 403 may be scope mismatch — auth was OK but missing permission
      const isScope = errorMsg?.includes('scope') === true;
      return {
        id: `probe.${name}`,
        severity: isScope ? 'warn' : 'error',
        title: `Probe ${name}: 403 Forbidden`,
        detail: errorMsg,
      };
    }
    return {
      id: `probe.${name}`,
      severity: 'warn',
      title: `Probe ${name}: HTTP ${res.status}`,
      detail: errorMsg,
    };
  } catch (e) {
    return {
      id: `probe.${name}`,
      severity: 'warn',
      title: `Probe ${name}: network error`,
      detail: (e as Error).message,
    };
  }
}

/**
 * Validate any non-OAuth token via /v1/messages/count_tokens.
 * Free endpoint, no model invocation, just auth + token counting.
 */
async function probeCountTokens(
  name: string,
  baseUrl: string,
  authHeaders: Record<string, string>,
): Promise<CheckResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages/count_tokens`;
  const body = JSON.stringify({
    model: PROBE_MODEL,
    messages: [{ role: 'user', content: 'hi' }],
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      return {
        id: `probe.${name}`,
        severity: 'ok',
        title: `Probe ${name}: token accepted`,
      };
    }
    let errorMsg: string | undefined;
    try {
      const data = (await res.json()) as
        | { error?: { message?: string } }
        | undefined;
      errorMsg = data?.error?.message;
    } catch {
      /* ignore */
    }
    if (res.status === 401 || res.status === 403) {
      return {
        id: `probe.${name}`,
        severity: 'error',
        title: `Probe ${name}: auth failed (${res.status})`,
        detail: errorMsg ?? 'Token may be expired, revoked, or for the wrong endpoint.',
      };
    }
    if (res.status === 400 || res.status === 404) {
      return {
        id: `probe.${name}`,
        severity: 'warn',
        title: `Probe ${name}: ${res.status} (auth likely OK, request rejected)`,
        detail: errorMsg,
      };
    }
    return {
      id: `probe.${name}`,
      severity: 'warn',
      title: `Probe ${name}: unexpected ${res.status}`,
      detail: errorMsg,
    };
  } catch (e) {
    return {
      id: `probe.${name}`,
      severity: 'warn',
      title: `Probe ${name}: network error`,
      detail: (e as Error).message,
    };
  }
}

function shortPath(p: string): string {
  const home = process.env.HOME ?? '';
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
