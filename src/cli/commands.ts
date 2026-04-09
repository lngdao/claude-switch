import { existsSync, readFileSync } from 'node:fs';
import {
  input,
  password,
  select,
  confirm,
  editor,
} from '@inquirer/prompts';
import { ProfileSchema, type Profile } from '../core/schema.js';
import {
  cloneProfile,
  deleteProfile,
  detectCurrent,
  listProfiles,
  profileFile,
  readProfile,
  renameProfile,
  summarize,
  writeProfile,
} from '../core/profile.js';
import { applyEnvToSettings, readSettingsEnv } from '../core/settings.js';
import {
  AUTH_KEYS,
  checkConflicts,
  checkTokenPrefix,
  detectScheme,
  isSecretKey,
  maskValue,
  schemeBadge,
} from '../core/scheme.js';
import { runDoctor } from '../core/doctor.js';
import {
  buildAnsibleSnippet,
  buildBashScript,
  performInit,
  readLocalOauthAccount,
  type InitInput,
} from '../core/headless.js';
import {
  aliasStatus,
  detectBinaryPath,
  detectShells,
  installAlias,
  uninstallAlias,
  type ShellName,
} from '../core/alias.js';
import { TWEAKS, getTweak } from '../core/tweaks.js';
import {
  cachedUpdateInfo,
  detectPackageManager,
  installCommand,
  performUpdate,
  readSelfPackage,
  type PackageManager,
} from '../core/update-check.js';
import { writeJsonAtomic } from '../core/fs-safe.js';
import type { Paths } from '../core/paths.js';
import {
  c,
  formatDoctor,
  formatList,
  schemeColor,
  summary,
  timeAgo,
} from './format.js';

export interface GlobalOpts {
  paths: Paths;
  json: boolean;
  yes: boolean;
  verbose: boolean;
}

// ─── ls ─────────────────────────────────────────────────────

export async function cmdLs(opts: GlobalOpts): Promise<number> {
  const env = readSettingsEnv(opts.paths);
  const profiles = summarize(opts.paths, env);
  if (opts.json) {
    console.log(
      JSON.stringify(
        profiles.map((p) => ({
          name: p.name,
          scheme: p.scheme,
          active: p.active,
          envKeys: p.envKeys,
          updatedAt: p.updatedAt,
          lastProbe: p.lastProbe,
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  console.log('');
  console.log(formatList(profiles));
  console.log('');
  return 0;
}

// ─── use ─────────────────────────────────────────────────────

export async function cmdUse(
  opts: GlobalOpts,
  name: string,
  flags: { dryRun?: boolean; quiet?: boolean; force?: boolean } = {},
): Promise<number> {
  const profile = readProfile(opts.paths, name);
  const conflict = checkConflicts(profile.env);
  if (!conflict.ok && !flags.force) {
    console.error(
      c.red(
        `Conflict: profile '${name}' has multiple auth keys (${conflict.conflicts.join(', ')}). Use --force to override.`,
      ),
    );
    return 2;
  }
  if (flags.dryRun) {
    const current = readSettingsEnv(opts.paths);
    console.log(c.bold(`Would switch to '${name}'.`));
    console.log(c.dim('Current env keys: ') + Object.keys(current).join(', '));
    console.log(c.dim('New env keys:     ') + Object.keys(profile.env).join(', '));
    return 0;
  }
  applyEnvToSettings(opts.paths, profile.env);
  if (!flags.quiet) {
    console.log(c.green(`✓ Switched to ${c.bold(name)} (${schemeBadge(detectScheme(profile.env))})`));
  }
  return 0;
}

// ─── current ─────────────────────────────────────────────────

export async function cmdCurrent(
  opts: GlobalOpts,
  flags: { unmask?: boolean } = {},
): Promise<number> {
  const env = readSettingsEnv(opts.paths);
  const name = detectCurrent(opts.paths, env);
  const scheme = detectScheme(env);

  // Try to read the active profile to get its lastProbe (best-effort).
  let lastProbe: { at: string; severity: 'ok' | 'warn' | 'error'; title: string; detail?: string } | undefined;
  if (name !== '(custom)') {
    try {
      const p = readProfile(opts.paths, name);
      lastProbe = p.meta?.lastProbe;
    } catch {
      /* ignore */
    }
  }

  if (flags.unmask && !opts.yes) {
    const ok = await confirm({
      message: 'Display unmasked secrets in terminal?',
      default: false,
    });
    if (!ok) return 0;
  }

  if (opts.json) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      out[k] = flags.unmask ? v : maskValue(k, v);
    }
    console.log(
      JSON.stringify({ name, scheme, env: out, lastProbe }, null, 2),
    );
    return 0;
  }

  console.log('');
  console.log(`  ${c.bold('Active:')} ${c.green(name)}  ${schemeColor(scheme)}`);
  if (lastProbe) {
    const icon =
      lastProbe.severity === 'ok'
        ? c.green('✓')
        : lastProbe.severity === 'warn'
          ? c.yellow('⚠')
          : c.red('✗');
    console.log(
      `  ${c.bold('Last probe:')} ${icon} ${lastProbe.title} ${c.dim('(' + timeAgo(lastProbe.at) + ')')}`,
    );
    if (lastProbe.detail) {
      console.log(c.dim(`               ${lastProbe.detail}`));
    }
  } else if (name !== '(custom)') {
    console.log(`  ${c.bold('Last probe:')} ${c.dim('never')}`);
  }
  console.log('');
  if (Object.keys(env).length === 0) {
    console.log(c.dim('  (no env keys set in settings.json)'));
  } else {
    for (const [k, v] of Object.entries(env)) {
      const display = flags.unmask ? v : maskValue(k, v);
      console.log(`  ${c.yellow(k)} = ${c.dim(display)}`);
    }
  }
  console.log('');
  return 0;
}

// ─── add ─────────────────────────────────────────────────────

export async function cmdAdd(
  opts: GlobalOpts,
  name: string | undefined,
  flags: {
    scheme?: string;
    token?: string;
    baseUrl?: string;
    set?: string[];
    force?: boolean;
  } = {},
): Promise<number> {
  const finalName =
    name ??
    (await input({
      message: 'Profile name:',
      validate: (v) => (v.trim().length > 0 ? true : 'Required'),
    }));

  if (existsSync(profileFile(opts.paths, finalName))) {
    console.error(c.red(`Profile already exists: ${finalName}`));
    return 1;
  }

  const env: Record<string, string> = {};

  // If non-interactive flags provided, use them.
  if (flags.scheme || flags.token || flags.set?.length) {
    if (flags.scheme === 'oauth' && flags.token) {
      env[AUTH_KEYS.OAUTH] = flags.token;
    } else if (flags.scheme === 'api-key' && flags.token) {
      env[AUTH_KEYS.API_KEY] = flags.token;
    } else if (flags.scheme === 'auth-token' && flags.token) {
      env[AUTH_KEYS.AUTH_TOKEN] = flags.token;
    } else if (flags.scheme === 'proxy' && flags.token) {
      env[AUTH_KEYS.AUTH_TOKEN] = flags.token;
      if (flags.baseUrl) env[AUTH_KEYS.BASE_URL] = flags.baseUrl;
    }
    for (const kv of flags.set ?? []) {
      const [k, ...rest] = kv.split('=');
      if (!k || rest.length === 0) {
        console.error(c.red(`Invalid --set value: ${kv}`));
        return 1;
      }
      env[k] = rest.join('=');
    }
  } else {
    // Interactive wizard
    const scheme = await select({
      message: 'Auth scheme:',
      choices: [
        { name: 'oauth — Claude Pro/Max OAuth token', value: 'oauth' },
        { name: 'api-key — Anthropic API key', value: 'api-key' },
        { name: 'auth-token — generic bearer token', value: 'auth-token' },
        { name: 'proxy — third-party (token + base URL)', value: 'proxy' },
        { name: 'empty — start blank', value: 'empty' },
      ],
    });

    if (scheme === 'oauth') {
      const t = await password({ message: 'CLAUDE_CODE_OAUTH_TOKEN:', mask: '*' });
      env[AUTH_KEYS.OAUTH] = t;
    } else if (scheme === 'api-key') {
      const t = await password({ message: 'ANTHROPIC_API_KEY:', mask: '*' });
      env[AUTH_KEYS.API_KEY] = t;
    } else if (scheme === 'auth-token') {
      const t = await password({ message: 'ANTHROPIC_AUTH_TOKEN:', mask: '*' });
      env[AUTH_KEYS.AUTH_TOKEN] = t;
    } else if (scheme === 'proxy') {
      const t = await password({ message: 'ANTHROPIC_AUTH_TOKEN:', mask: '*' });
      env[AUTH_KEYS.AUTH_TOKEN] = t;
      const url = await input({ message: 'ANTHROPIC_BASE_URL:' });
      env[AUTH_KEYS.BASE_URL] = url;
    }

    // Optional extra keys
    while (true) {
      const more = await confirm({ message: 'Add another env key?', default: false });
      if (!more) break;
      const k = await input({ message: 'Key:' });
      if (!k) break;
      const v = isSecretKey(k)
        ? await password({ message: 'Value:', mask: '*' })
        : await input({ message: 'Value:' });
      env[k] = v;
    }
  }

  // Validate token prefixes
  for (const [k, v] of Object.entries(env)) {
    const pre = checkTokenPrefix(k, v);
    if (!pre.ok && !flags.force) {
      console.error(
        c.red(
          `Token for ${k} should start with '${pre.expected}'. Use --force to save anyway.`,
        ),
      );
      return 1;
    }
  }

  try {
    writeProfile(opts.paths, finalName, { env }, { force: flags.force });
  } catch (e) {
    console.error(c.red((e as Error).message));
    return 2;
  }
  console.log(c.green(`✓ Created profile ${c.bold(finalName)}`));
  return 0;
}

// ─── edit ────────────────────────────────────────────────────

export async function cmdEdit(
  opts: GlobalOpts,
  name: string,
  flags: { set?: string[]; unset?: string[]; raw?: boolean } = {},
): Promise<number> {
  const profile = readProfile(opts.paths, name);
  const env = { ...profile.env };

  if (flags.raw) {
    const next = await editor({
      message: `Editing ${name} (.env block as JSON)`,
      default: JSON.stringify(env, null, 2),
      postfix: '.json',
    });
    let parsed: Record<string, string>;
    try {
      parsed = JSON.parse(next);
    } catch (e) {
      console.error(c.red(`Invalid JSON: ${(e as Error).message}`));
      return 1;
    }
    return saveEdited(opts, name, parsed);
  }

  if (flags.set?.length || flags.unset?.length) {
    for (const kv of flags.set ?? []) {
      const [k, ...rest] = kv.split('=');
      if (!k || rest.length === 0) {
        console.error(c.red(`Invalid --set: ${kv}`));
        return 1;
      }
      env[k] = rest.join('=');
    }
    for (const k of flags.unset ?? []) {
      delete env[k];
    }
    return saveEdited(opts, name, env);
  }

  // Interactive
  while (true) {
    const keys = Object.keys(env);
    const choices = keys.map((k) => ({
      name: `${k} = ${maskValue(k, env[k]!)}`,
      value: `edit:${k}`,
    }));
    const action = await select({
      message: `Editing ${name}`,
      choices: [
        ...choices,
        { name: '+ Add new key', value: 'add' },
        { name: '✓ Save & exit', value: 'save' },
        { name: '✗ Cancel', value: 'cancel' },
      ],
    });

    if (action === 'cancel') return 0;
    if (action === 'save') return saveEdited(opts, name, env);
    if (action === 'add') {
      const k = await input({ message: 'Key:' });
      if (!k) continue;
      const v = isSecretKey(k)
        ? await password({ message: 'Value:', mask: '*' })
        : await input({ message: 'Value:' });
      env[k] = v;
      continue;
    }
    if (action.startsWith('edit:')) {
      const k = action.slice(5);
      const current = env[k] ?? '';
      const next = isSecretKey(k)
        ? await password({
            message: `${k} (empty = delete):`,
            mask: '*',
          })
        : await input({ message: `${k} (empty = delete):`, default: current });
      if (next === '') {
        delete env[k];
      } else {
        env[k] = next;
      }
    }
  }
}

function saveEdited(
  opts: GlobalOpts,
  name: string,
  env: Record<string, string>,
): number {
  const profile: Profile = { env };
  const parsed = ProfileSchema.safeParse(profile);
  if (!parsed.success) {
    console.error(c.red('Invalid profile shape after edit.'));
    return 1;
  }
  // Capture active state BEFORE write so we know whether to re-apply.
  const wasActive = detectCurrent(opts.paths, readSettingsEnv(opts.paths)) === name;
  try {
    // preserve existing meta
    const existing = readProfile(opts.paths, name);
    writeProfile(opts.paths, name, { env, meta: existing.meta });
  } catch (e) {
    console.error(c.red((e as Error).message));
    return 2;
  }
  console.log(c.green(`✓ Saved ${c.bold(name)}`));
  if (wasActive) {
    try {
      applyEnvToSettings(opts.paths, env);
      console.log(c.dim('  (re-applied to settings.json — still active)'));
    } catch (e) {
      console.error(
        c.yellow(`  Warning: could not re-apply to settings.json: ${(e as Error).message}`),
      );
    }
  }
  return 0;
}

// ─── rename / delete / clone ─────────────────────────────────

export async function cmdRename(opts: GlobalOpts, oldName: string, newName: string): Promise<number> {
  try {
    renameProfile(opts.paths, oldName, newName);
    console.log(c.green(`✓ Renamed ${oldName} → ${newName}`));
    return 0;
  } catch (e) {
    console.error(c.red((e as Error).message));
    return 1;
  }
}

export async function cmdDelete(opts: GlobalOpts, name: string): Promise<number> {
  if (!opts.yes) {
    const ok = await confirm({ message: `Delete '${name}'?`, default: false });
    if (!ok) return 0;
  }
  try {
    deleteProfile(opts.paths, name);
    console.log(c.green(`✓ Deleted ${name}`));
    return 0;
  } catch (e) {
    console.error(c.red((e as Error).message));
    return 1;
  }
}

export async function cmdClone(opts: GlobalOpts, src: string, dst: string): Promise<number> {
  try {
    cloneProfile(opts.paths, src, dst);
    console.log(c.green(`✓ Cloned ${src} → ${dst}`));
    return 0;
  } catch (e) {
    console.error(c.red((e as Error).message));
    return 1;
  }
}

// ─── import / export ─────────────────────────────────────────

export async function cmdImport(
  opts: GlobalOpts,
  file: string,
  flags: { name?: string; force?: boolean } = {},
): Promise<number> {
  if (!existsSync(file)) {
    console.error(c.red(`File not found: ${file}`));
    return 1;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(c.red(`Invalid JSON: ${(e as Error).message}`));
    return 1;
  }
  const parsed = ProfileSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(c.red(`Schema error: ${parsed.error.issues.map((i) => i.message).join('; ')}`));
    return 1;
  }
  const baseName =
    flags.name ?? file.split('/').pop()?.replace(/\.json$/, '') ?? 'imported';
  if (existsSync(profileFile(opts.paths, baseName)) && !flags.force) {
    console.error(c.red(`Profile already exists: ${baseName}. Use --force.`));
    return 1;
  }
  try {
    writeProfile(opts.paths, baseName, parsed.data);
    console.log(c.green(`✓ Imported as ${c.bold(baseName)}`));
    return 0;
  } catch (e) {
    console.error(c.red((e as Error).message));
    return 2;
  }
}

export async function cmdExport(
  opts: GlobalOpts,
  name: string,
  flags: { out?: string; mask?: boolean } = {},
): Promise<number> {
  const profile = readProfile(opts.paths, name);
  const out: Profile = flags.mask
    ? {
        env: Object.fromEntries(
          Object.entries(profile.env).map(([k, v]) => [k, maskValue(k, v)]),
        ),
        meta: profile.meta,
      }
    : profile;
  const json = JSON.stringify(out, null, 2);
  if (!flags.out || flags.out === '-') {
    if (!flags.mask && !opts.yes) {
      console.error(
        c.yellow(
          '⚠ Exporting unmasked tokens to stdout. Pipe carefully.',
        ),
      );
    }
    process.stdout.write(json + '\n');
  } else {
    writeJsonAtomic(flags.out, out, { mode: 0o600 });
    console.log(c.green(`✓ Wrote ${flags.out}`));
  }
  return 0;
}

// ─── doctor ──────────────────────────────────────────────────

export async function cmdDoctor(
  opts: GlobalOpts,
  flags: { probe?: boolean; fix?: boolean } = {},
): Promise<number> {
  const report = await runDoctor(opts.paths, { probe: flags.probe, fix: flags.fix });
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('');
    console.log(formatDoctor(report.results));
    console.log('');
    console.log('  ' + summary(report.ok, report.warn, report.error));
    console.log('');
  }
  if (report.error > 0) return 10;
  return 0;
}

// ─── init ────────────────────────────────────────────────────

export async function cmdInit(
  opts: GlobalOpts,
  flags: {
    token?: string;
    accountUuid?: string;
    email?: string;
    orgUuid?: string;
    profileName?: string;
    fromLocal?: boolean;
    printScript?: boolean;
    ansible?: boolean;
    onboardingVersion?: string;
  } = {},
): Promise<number> {
  let token = flags.token;
  let accountUuid = flags.accountUuid;
  let email = flags.email;
  let orgUuid = flags.orgUuid;

  // Hydrate from local ~/.claude.json if available / requested
  if (flags.fromLocal || (!accountUuid && !email && !orgUuid)) {
    const local = readLocalOauthAccount(opts.paths);
    if (local) {
      accountUuid ??= local.accountUuid;
      email ??= local.emailAddress;
      orgUuid ??= local.organizationUuid;
      if (flags.fromLocal) {
        console.log(c.dim(`Loaded oauthAccount from ${opts.paths.claudeJson}`));
      }
    }
  }

  // Fill missing fields interactively (unless --yes)
  if (!token) {
    if (opts.yes) {
      console.error(c.red('--token required in non-interactive mode'));
      return 1;
    }
    token = await password({ message: 'OAuth token (sk-ant-oat01-…):', mask: '*' });
  }
  if (!accountUuid) {
    if (opts.yes) {
      console.error(c.red('--account-uuid required'));
      return 1;
    }
    accountUuid = await input({ message: 'accountUuid:' });
  }
  if (!email) {
    if (opts.yes) {
      console.error(c.red('--email required'));
      return 1;
    }
    email = await input({ message: 'emailAddress:' });
  }
  if (!orgUuid) {
    if (opts.yes) {
      console.error(c.red('--org-uuid required'));
      return 1;
    }
    orgUuid = await input({ message: 'organizationUuid:' });
  }

  const initInput: InitInput = {
    token,
    account: {
      accountUuid,
      emailAddress: email,
      organizationUuid: orgUuid,
    },
    profileName: flags.profileName,
    lastOnboardingVersion: flags.onboardingVersion,
  };

  if (flags.printScript) {
    process.stdout.write(buildBashScript(initInput));
    return 0;
  }
  if (flags.ansible) {
    process.stdout.write(buildAnsibleSnippet(initInput));
    return 0;
  }

  try {
    const result = performInit(opts.paths, initInput);
    console.log(c.green(`✓ Wrote ${result.claudeJsonPath} and profile '${result.profileName}'`));
    console.log(c.dim('  Tip: now run `claude-switch use ' + result.profileName + '` to activate it.'));
    return 0;
  } catch (e) {
    console.error(c.red((e as Error).message));
    return 1;
  }
}

// ─── alias ───────────────────────────────────────────────

export async function cmdAliasInstall(
  opts: GlobalOpts,
  flags: {
    name?: string;
    shell?: string;
    target?: string;
    dryRun?: boolean;
  } = {},
): Promise<number> {
  const target = flags.target ?? detectBinaryPath();
  const shells = flags.shell ? [flags.shell as ShellName] : undefined;

  const detected = detectShells();
  const installable = detected.filter((d) => d.exists);
  if (installable.length === 0) {
    console.error(c.red('No supported shell rc file found (~/.bashrc, ~/.zshrc, ~/.config/fish/config.fish)'));
    return 1;
  }

  if (!opts.yes && !flags.dryRun && !flags.shell) {
    console.log(c.bold('Will install alias') + ` ${flags.name ?? 'cs'} → ${target}`);
    console.log(c.dim('Detected shells:'));
    for (const t of installable) {
      console.log(`  - ${t.shell} (${t.rcPath})`);
    }
    const ok = await confirm({ message: 'Proceed?', default: true });
    if (!ok) return 0;
  }

  try {
    const results = installAlias({
      name: flags.name,
      target,
      shells,
      dryRun: flags.dryRun,
    });
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return 0;
    }
    for (const r of results) {
      const icon =
        r.action === 'created'
          ? c.green('✓ created')
          : r.action === 'updated'
            ? c.cyan('↻ updated')
            : r.action === 'noop'
              ? c.dim('· noop')
              : c.dim('  skipped');
      console.log(`  ${icon} ${r.shell}  ${c.dim(r.rcPath)}`);
      if (r.diff) console.log(c.dim(`      ${r.diff.replace(/\n/g, '\n      ')}`));
    }
    if (!flags.dryRun) {
      const touched = results.filter(
        (r) => r.action === 'created' || r.action === 'updated',
      );
      if (touched.length > 0) {
        console.log('');
        console.log(c.bold('To use the alias right now in this shell:'));
        for (const r of touched) {
          console.log(`  ${c.cyan(`source ${r.rcPath}`)}`);
        }
        console.log('');
        console.log(c.dim('Or open a new terminal — the alias will load automatically.'));
        console.log(
          c.dim('Or one-shot: ') + c.cyan(`eval "$(claude-switch alias print)"`),
        );
      }
    }
    return 0;
  } catch (e) {
    console.error(c.red((e as Error).message));
    return 1;
  }
}

export async function cmdAliasPrint(
  opts: GlobalOpts,
  flags: { name?: string; target?: string } = {},
): Promise<number> {
  const name = flags.name ?? 'cs';
  const target = flags.target ?? detectBinaryPath();
  // Single-line shell-eval-able alias for `eval "$(claude-switch alias print)"`
  // Using single quotes; embed the target safely.
  const escaped = target.replace(/'/g, `'\\''`);
  process.stdout.write(`alias ${name}='${escaped}'\n`);
  return 0;
}

export async function cmdAliasUninstall(
  opts: GlobalOpts,
  flags: { shell?: string; dryRun?: boolean } = {},
): Promise<number> {
  const shells = flags.shell ? [flags.shell as ShellName] : undefined;
  if (!opts.yes && !flags.dryRun) {
    const ok = await confirm({ message: 'Remove claude-switch alias from shell rc?', default: false });
    if (!ok) return 0;
  }
  try {
    const results = uninstallAlias({ shells, dryRun: flags.dryRun });
    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return 0;
    }
    for (const r of results) {
      const icon =
        r.action === 'removed' ? c.green('✓ removed') : c.dim('· nothing to remove');
      console.log(`  ${icon} ${r.shell}  ${c.dim(r.rcPath)}`);
    }
    return 0;
  } catch (e) {
    console.error(c.red((e as Error).message));
    return 1;
  }
}

export async function cmdAliasStatus(opts: GlobalOpts): Promise<number> {
  const status = aliasStatus();
  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }
  console.log('');
  if (status.length === 0) {
    console.log(c.dim('  No supported shell rc files found.'));
    console.log('');
    return 0;
  }
  for (const s of status) {
    if (s.installed) {
      console.log(`  ${c.green('●')} ${s.shell}  ${c.dim(s.rcPath)}`);
      console.log(`      ${c.dim(s.currentLine ?? '')}`);
    } else {
      console.log(`  ${c.dim('○')} ${s.shell}  ${c.dim(s.rcPath)}  ${c.dim('(not installed)')}`);
    }
  }
  console.log('');
  return 0;
}

// ─── tweak ───────────────────────────────────────────────

export async function cmdTweakList(opts: GlobalOpts): Promise<number> {
  if (opts.json) {
    const rows = await Promise.all(
      TWEAKS.map(async (t) => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: await t.status(opts.paths),
      })),
    );
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  console.log('');
  for (const t of TWEAKS) {
    const s = await t.status(opts.paths);
    const icon =
      s === 'applied' ? c.green('●') : s === 'not-applied' ? c.dim('○') : c.yellow('?');
    console.log(`  ${icon} ${c.bold(t.id)}  ${c.dim(s)}`);
    console.log(`    ${t.title}`);
    console.log(c.dim(`    ${t.description}`));
    console.log('');
  }
  return 0;
}

export async function cmdTweakApply(
  opts: GlobalOpts,
  id: string,
): Promise<number> {
  const tweak = getTweak(id);
  if (!tweak) {
    console.error(c.red(`Unknown tweak: ${id}`));
    console.error(c.dim(`Available: ${TWEAKS.map((t) => t.id).join(', ')}`));
    return 1;
  }
  if (!opts.yes) {
    const ok = await confirm({
      message: `Apply '${tweak.title}'?`,
      default: true,
    });
    if (!ok) return 0;
  }
  try {
    const summary = await tweak.apply(opts.paths);
    console.log(c.green(`✓ ${id}: ${summary}`));
    return 0;
  } catch (e) {
    console.error(c.red(`✗ ${id}: ${(e as Error).message}`));
    return 1;
  }
}

export async function cmdTweakStatus(
  opts: GlobalOpts,
  id?: string,
): Promise<number> {
  if (id) {
    const tweak = getTweak(id);
    if (!tweak) {
      console.error(c.red(`Unknown tweak: ${id}`));
      return 1;
    }
    const s = await tweak.status(opts.paths);
    if (opts.json) {
      console.log(JSON.stringify({ id, status: s }, null, 2));
    } else {
      console.log(`${id}: ${s}`);
    }
    return 0;
  }
  return cmdTweakList(opts);
}

// ─── update ──────────────────────────────────────────────

export async function cmdUpdate(
  opts: GlobalOpts,
  flags: { check?: boolean; pm?: string; force?: boolean } = {},
): Promise<number> {
  const pkg = readSelfPackage();
  if (!pkg) {
    console.error(c.red('Could not read package metadata'));
    return 1;
  }

  // --check just reports cached status without installing
  if (flags.check) {
    const info = cachedUpdateInfo();
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            current: pkg.version,
            latest: info?.latest ?? null,
            hasUpdate: !!info,
            type: info?.type ?? null,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    if (info) {
      console.log(
        `${c.dim(info.current)} → ${c.green().bold(info.latest)} ${c.dim('(' + info.type + ')')}`,
      );
      console.log(c.dim('Run `claude-switch update` to install.'));
    } else {
      console.log(`${c.green('✓')} ${c.bold(pkg.name)}@${pkg.version} is up to date.`);
      console.log(c.dim('(based on cached check; may be stale up to 24h)'));
    }
    return 0;
  }

  const pm = (flags.pm as PackageManager | undefined) ?? detectPackageManager();
  const info = cachedUpdateInfo();

  if (!info && !flags.force) {
    console.log(`${c.green('✓')} ${c.bold(pkg.name)}@${pkg.version} appears up to date.`);
    console.log(c.dim('Pass --force to reinstall the latest version anyway.'));
    return 0;
  }

  if (info) {
    console.log(
      c.bold().yellow('Update available') +
        c.dim(` (${info.type})`) +
        `\n  ${c.dim(info.current)} → ${c.green().bold(info.latest)}` +
        `\n  package: ${info.name}` +
        `\n  manager: ${pm}\n`,
    );
  } else {
    console.log(c.bold(`Reinstalling ${pkg.name}@latest via ${pm}…\n`));
  }

  if (!opts.yes) {
    const ok = await confirm({ message: 'Install now?', default: true });
    if (!ok) return 0;
  }

  const result = await performUpdate(pkg.name, { pm });
  if (result.ok) {
    console.log('');
    console.log(c.green(`✓ Updated ${pkg.name}.`));
    console.log(c.dim('  Re-run your command to use the new version.'));
    return 0;
  }
  const { cmd, args } = installCommand(result.pm, pkg.name);
  console.error('');
  console.error(c.red(`✗ Update failed (exit ${result.code}).`));
  console.error(c.dim(`  Try manually: ${cmd} ${args.join(' ')}`));
  return 1;
}

// for unused detection if needed
void listProfiles;
