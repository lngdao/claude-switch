import { existsSync, readFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ClaudeJsonSchema, type OauthAccount } from './schema.js';
import { writeJsonAtomic } from './fs-safe.js';
import { writeProfile } from './profile.js';
import { AUTH_KEYS, checkTokenPrefix } from './scheme.js';
import type { Paths } from './paths.js';

const pExecFile = promisify(execFile);

export interface InitInput {
  token: string;
  account: OauthAccount;
  profileName?: string;
  lastOnboardingVersion?: string;
}

export interface InitResult {
  claudeJsonPath: string;
  profileName: string;
}

export interface BypassResult {
  path: string;
  action: 'created' | 'updated' | 'noop';
  version: string;
  /** Other top-level keys that were preserved (for transparency). */
  preservedKeys: string[];
}

/**
 * Toggle the onboarding bypass flag in `~/.claude.json`.
 *
 * This is intentionally narrow: it only sets `hasCompletedOnboarding: true`
 * and `lastOnboardingVersion`. Existing fields (including `oauthAccount`) are
 * preserved untouched. It does NOT require a token and does NOT modify any
 * profile.
 *
 * If `version` is omitted we try to detect it from `claude --version`. If
 * neither is available we fall back to an empty string and let the caller
 * decide whether to surface a warning.
 */
export async function bypassOnboarding(
  paths: Paths,
  version?: string,
): Promise<BypassResult> {
  // Read existing JSON if present (preserve everything else).
  let existing: Record<string, unknown> = {};
  let existed = false;
  if (existsSync(paths.claudeJson)) {
    existed = true;
    try {
      existing = JSON.parse(readFileSync(paths.claudeJson, 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      // Corrupt file — start over but treat as 'created'
      existing = {};
      existed = false;
    }
  }

  const resolvedVersion = version ?? (await detectClaudeVersion()) ?? '';

  const wasAlreadyBypassed =
    existing.hasCompletedOnboarding === true &&
    (resolvedVersion === '' ||
      existing.lastOnboardingVersion === resolvedVersion);

  const next: Record<string, unknown> = {
    ...existing,
    hasCompletedOnboarding: true,
  };
  if (resolvedVersion) {
    next.lastOnboardingVersion = resolvedVersion;
  }

  if (wasAlreadyBypassed) {
    return {
      path: paths.claudeJson,
      action: 'noop',
      version: resolvedVersion,
      preservedKeys: Object.keys(existing).filter(
        (k) => k !== 'hasCompletedOnboarding' && k !== 'lastOnboardingVersion',
      ),
    };
  }

  writeJsonAtomic(paths.claudeJson, next, { mode: 0o600 });

  return {
    path: paths.claudeJson,
    action: existed ? 'updated' : 'created',
    version: resolvedVersion,
    preservedKeys: Object.keys(existing).filter(
      (k) => k !== 'hasCompletedOnboarding' && k !== 'lastOnboardingVersion',
    ),
  };
}

async function detectClaudeVersion(): Promise<string | null> {
  try {
    const result = await pExecFile('claude', ['--version'], { timeout: 2000 });
    const out = (result.stdout || result.stderr || '').trim();
    const match = out.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/);
    return match ? match[1]! : null;
  } catch {
    return null;
  }
}

export interface SetupTokenResult {
  /** Extracted long-lived OAuth token, or null if it couldn't be parsed. */
  token: string | null;
  /** Exit code of the spawned `claude setup-token` process. */
  code: number | null;
  /** Captured stdout (mostly for diagnostics). */
  output: string;
  /** Set when the `claude` binary is not on PATH. */
  notInstalled?: boolean;
}

/**
 * Spawn `claude setup-token`, tee its stdout to the parent terminal so the
 * user sees the OAuth instructions live, and parse the long-lived token from
 * the captured output once the process exits.
 *
 * The OAuth token format is `sk-ant-oat01-…` and Claude Code prints it on its
 * own line near the end of the flow ("Use this token by setting: export
 * CLAUDE_CODE_OAUTH_TOKEN=<token>").
 */
export async function runClaudeSetupToken(): Promise<SetupTokenResult> {
  return new Promise((resolve) => {
    let captured = '';
    let child;
    try {
      child = spawn('claude', ['setup-token'], {
        // stdin: inherit so user can answer any prompts claude shows
        // stdout: pipe so we can capture (and tee) the token
        // stderr: inherit so user sees errors live
        stdio: ['inherit', 'pipe', 'inherit'],
      });
    } catch (e) {
      resolve({
        token: null,
        code: null,
        output: '',
        notInstalled: (e as NodeJS.ErrnoException).code === 'ENOENT',
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      captured += text;
      process.stdout.write(text);
    });

    child.on('error', (e) => {
      const enoent = (e as NodeJS.ErrnoException).code === 'ENOENT';
      resolve({
        token: null,
        code: null,
        output: captured,
        notInstalled: enoent,
      });
    });

    child.on('close', (code) => {
      // Match the OAuth token wherever it appears in the captured output.
      // Token format: sk-ant-oat01-<base64-ish>; allow common URL/JWT chars.
      const match = captured.match(/sk-ant-oat01-[A-Za-z0-9_\-+=/]+/);
      resolve({
        token: match ? match[0] : null,
        code,
        output: captured,
      });
    });
  });
}

/**
 * Convenience wrapper for the full headless setup flow:
 *  1. Run `claude setup-token` (interactive browser flow).
 *  2. Read the freshly-populated `oauthAccount` from the local
 *     `~/.claude.json` (Claude Code writes this after a successful setup).
 *  3. Write our own `~/.claude.json` plus a profile via `performInit`.
 *
 * Returns the InitResult on success, or throws an Error explaining what
 * went wrong (no claude binary, no token, no oauthAccount, etc).
 */
export async function performAutoInit(
  paths: Paths,
  options: { profileName?: string; lastOnboardingVersion?: string } = {},
): Promise<{ profileName: string; claudeJsonPath: string }> {
  const result = await runClaudeSetupToken();
  if (result.notInstalled) {
    throw new Error(
      "`claude` CLI not found on PATH. Install it first (https://docs.claude.com/claude-code).",
    );
  }
  if (result.code !== 0) {
    throw new Error(`claude setup-token exited with code ${result.code}`);
  }
  if (!result.token) {
    throw new Error(
      'Could not extract an OAuth token from the setup-token output.',
    );
  }

  const account = readLocalOauthAccount(paths);
  if (!account) {
    throw new Error(
      'No oauthAccount in ~/.claude.json after setup-token. Make sure the OAuth flow completed.',
    );
  }

  return performInit(paths, {
    token: result.token,
    account,
    profileName: options.profileName,
    lastOnboardingVersion: options.lastOnboardingVersion,
  });
}

export function readLocalOauthAccount(paths: Paths): OauthAccount | null {
  if (!existsSync(paths.claudeJson)) return null;
  try {
    const raw = JSON.parse(readFileSync(paths.claudeJson, 'utf8'));
    const parsed = ClaudeJsonSchema.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data.oauthAccount ?? null;
  } catch {
    return null;
  }
}

export function performInit(paths: Paths, input: InitInput): InitResult {
  // Validate token prefix (warn but allow if user wants — caller can pre-check)
  const pre = checkTokenPrefix(AUTH_KEYS.OAUTH, input.token);
  if (!pre.ok) {
    throw new Error(
      `OAuth token must start with '${pre.expected}'. Pass --force to override.`,
    );
  }

  const claudeJson = {
    hasCompletedOnboarding: true,
    lastOnboardingVersion: input.lastOnboardingVersion ?? '2.1.29',
    oauthAccount: input.account,
  };
  writeJsonAtomic(paths.claudeJson, claudeJson, { mode: 0o600 });

  const profileName = input.profileName ?? 'oauth';
  writeProfile(paths, profileName, {
    env: { [AUTH_KEYS.OAUTH]: input.token },
    meta: {
      description: 'Created by claude-switch init',
    },
  });

  return { claudeJsonPath: paths.claudeJson, profileName };
}

export function buildBashScript(input: InitInput): string {
  const account = JSON.stringify({
    hasCompletedOnboarding: true,
    lastOnboardingVersion: input.lastOnboardingVersion ?? '2.1.29',
    oauthAccount: input.account,
  });
  return `#!/usr/bin/env bash
# Generated by claude-switch init --print-script
set -euo pipefail

# 1. Export OAuth token (subscription-based)
grep -q CLAUDE_CODE_OAUTH_TOKEN ~/.bashrc.local 2>/dev/null || \\
  echo 'export CLAUDE_CODE_OAUTH_TOKEN="${input.token}"' >> ~/.bashrc.local
chmod 600 ~/.bashrc.local

# 2. Bypass onboarding wizard
cat > ~/.claude.json <<'JSON'
${account}
JSON
chmod 600 ~/.claude.json

# 3. Make sure ~/.bashrc sources ~/.bashrc.local
grep -q '.bashrc.local' ~/.bashrc 2>/dev/null || \\
  echo '[[ -f ~/.bashrc.local ]] && . ~/.bashrc.local' >> ~/.bashrc

echo "Done. Open a new shell or: source ~/.bashrc"
`;
}

export function buildAnsibleSnippet(input: InitInput): string {
  return `# Generated by claude-switch init --ansible
- name: Configure Claude Code OAuth token in bashrc.local
  copy:
    content: |
      # Claude Code OAuth token (managed by Ansible)
      export CLAUDE_CODE_OAUTH_TOKEN="${input.token}"
    dest: "/home/{{ target_user }}/.bashrc.local"
    owner: "{{ target_user }}"
    mode: '0600'
  no_log: true

- name: Configure Claude Code onboarding bypass
  copy:
    content: |
      {
        "hasCompletedOnboarding": true,
        "lastOnboardingVersion": "${input.lastOnboardingVersion ?? '2.1.29'}",
        "oauthAccount": {
          "accountUuid": "${input.account.accountUuid}",
          "emailAddress": "${input.account.emailAddress}",
          "organizationUuid": "${input.account.organizationUuid}"
        }
      }
    dest: "/home/{{ target_user }}/.claude.json"
    owner: "{{ target_user }}"
    mode: '0600'
`;
}
