import { Command, Option } from 'commander';
import { resolvePaths } from '../core/paths.js';
import {
  cmdAdd,
  cmdAliasInstall,
  cmdAliasStatus,
  cmdAliasUninstall,
  cmdClone,
  cmdCurrent,
  cmdDelete,
  cmdDoctor,
  cmdEdit,
  cmdExport,
  cmdTweakApply,
  cmdTweakList,
  cmdTweakStatus,
  cmdImport,
  cmdInit,
  cmdLs,
  cmdRename,
  cmdUse,
  type GlobalOpts,
} from './commands.js';
import { disableColor } from './format.js';

interface RawGlobalOpts {
  profilesDir?: string;
  settings?: string;
  claudeJson?: string;
  json?: boolean;
  noColor?: boolean;
  yes?: boolean;
  verbose?: boolean;
}

function buildGlobal(raw: RawGlobalOpts): GlobalOpts {
  if (raw.noColor) disableColor();
  return {
    paths: resolvePaths({
      profilesDir: raw.profilesDir,
      settings: raw.settings,
      claudeJson: raw.claudeJson,
    }),
    json: raw.json === true,
    yes: raw.yes === true,
    verbose: raw.verbose === true,
  };
}

function getGlobal(cmd: Command): GlobalOpts {
  // Walk up to root to merge global flags
  let root: Command = cmd;
  while (root.parent) root = root.parent;
  return buildGlobal(root.opts() as RawGlobalOpts);
}

export function buildCli(): Command {
  const program = new Command();
  program
    .name('claude-switch')
    .description('TUI + CLI to manage Claude Code auth profiles')
    .version('0.1.0')
    .option('--profiles-dir <path>', 'override profiles directory')
    .option('--settings <path>', 'override settings.json path')
    .option('--claude-json <path>', 'override ~/.claude.json path')
    .option('--json', 'output JSON where supported')
    .option('--no-color', 'disable color output')
    .option('-y, --yes', 'skip confirmation prompts')
    .option('-v, --verbose', 'verbose logging');

  // ls
  program
    .command('ls')
    .alias('list')
    .description('list profiles')
    .action(async (_o, cmd) => {
      process.exit(await cmdLs(getGlobal(cmd)));
    });

  // use
  program
    .command('use <name>')
    .alias('sw')
    .description('switch active profile')
    .option('--dry-run', 'show diff without writing')
    .option('--quiet', 'no output on success')
    .option('--force', 'override conflict guard')
    .action(async (name, opts, cmd) => {
      process.exit(await cmdUse(getGlobal(cmd), name, opts));
    });

  // current
  program
    .command('current')
    .description('show active profile and env')
    .option('--unmask', 'show unmasked secrets')
    .action(async (opts, cmd) => {
      process.exit(await cmdCurrent(getGlobal(cmd), opts));
    });

  // add
  program
    .command('add [name]')
    .description('create a new profile')
    .addOption(
      new Option('--scheme <scheme>', 'auth scheme').choices([
        'oauth',
        'api-key',
        'auth-token',
        'proxy',
        'empty',
      ]),
    )
    .option('--token <token>', 'token value')
    .option('--base-url <url>', 'ANTHROPIC_BASE_URL (proxy scheme)')
    .option('--set <kv...>', 'extra env entries (KEY=VALUE)')
    .option('--force', 'override prefix/conflict checks')
    .action(async (name, opts, cmd) => {
      process.exit(await cmdAdd(getGlobal(cmd), name, opts));
    });

  // edit
  program
    .command('edit <name>')
    .description('edit a profile interactively or via flags')
    .option('--set <kv...>', 'set KEY=VALUE')
    .option('--unset <key...>', 'remove key')
    .option('--raw', 'open full env JSON in $EDITOR')
    .action(async (name, opts, cmd) => {
      process.exit(await cmdEdit(getGlobal(cmd), name, opts));
    });

  // rename
  program
    .command('rename <old> <new>')
    .description('rename a profile')
    .action(async (oldName, newName, _o, cmd) => {
      process.exit(await cmdRename(getGlobal(cmd), oldName, newName));
    });

  // delete
  program
    .command('delete <name>')
    .alias('rm')
    .description('delete a profile')
    .action(async (name, _o, cmd) => {
      process.exit(await cmdDelete(getGlobal(cmd), name));
    });

  // clone
  program
    .command('clone <src> <dst>')
    .description('duplicate a profile')
    .action(async (src, dst, _o, cmd) => {
      process.exit(await cmdClone(getGlobal(cmd), src, dst));
    });

  // import
  program
    .command('import <file>')
    .description('import a profile from JSON file')
    .option('--name <name>', 'override profile name')
    .option('--force', 'overwrite if exists')
    .action(async (file, opts, cmd) => {
      process.exit(await cmdImport(getGlobal(cmd), file, opts));
    });

  // export
  program
    .command('export <name>')
    .description('export a profile (default: stdout, unmasked)')
    .option('--out <file>', 'output file (- for stdout)', '-')
    .option('--mask', 'mask secrets in output')
    .action(async (name, opts, cmd) => {
      process.exit(await cmdExport(getGlobal(cmd), name, opts));
    });

  // doctor
  program
    .command('doctor')
    .description('check config health')
    .option('--probe', 'test tokens against the API')
    .option('--fix', 'auto-fix file permissions')
    .action(async (opts, cmd) => {
      process.exit(await cmdDoctor(getGlobal(cmd), opts));
    });

  // alias
  const alias = program.command('alias').description('manage shell alias for claude-switch');
  alias
    .command('install')
    .description('install shell alias (default name: cs)')
    .option('--name <name>', 'alias name', 'cs')
    .addOption(new Option('--shell <shell>', 'restrict to one shell').choices(['bash', 'zsh', 'fish']))
    .option('--target <path>', 'binary path the alias should point to')
    .option('--dry-run', 'show what would be added without writing')
    .action(async (opts, cmd) => {
      process.exit(await cmdAliasInstall(getGlobal(cmd), opts));
    });
  alias
    .command('uninstall')
    .description('remove shell alias')
    .addOption(new Option('--shell <shell>', 'restrict to one shell').choices(['bash', 'zsh', 'fish']))
    .option('--dry-run', 'show what would be removed without writing')
    .action(async (opts, cmd) => {
      process.exit(await cmdAliasUninstall(getGlobal(cmd), opts));
    });
  alias
    .command('status')
    .description('show shell alias installation status')
    .action(async (_o, cmd) => {
      process.exit(await cmdAliasStatus(getGlobal(cmd)));
    });

  // tweak — apply opinionated tricks / config patches
  const tweak = program.command('tweak').description('apply quick config tweaks (bypass onboarding, opus[1m], …)');
  tweak
    .command('list')
    .description('list available tweaks and their status')
    .action(async (_o, cmd) => {
      process.exit(await cmdTweakList(getGlobal(cmd)));
    });
  tweak
    .command('apply <id>')
    .description('apply a tweak by id')
    .action(async (id, _o, cmd) => {
      process.exit(await cmdTweakApply(getGlobal(cmd), id));
    });
  tweak
    .command('status [id]')
    .description('show status of one or all tweaks')
    .action(async (id, _o, cmd) => {
      process.exit(await cmdTweakStatus(getGlobal(cmd), id));
    });

  // init
  program
    .command('init')
    .description('headless setup: write ~/.claude.json + first profile')
    .option('--token <t>', 'OAuth token')
    .option('--account-uuid <u>', 'oauthAccount.accountUuid')
    .option('--email <e>', 'oauthAccount.emailAddress')
    .option('--org-uuid <u>', 'oauthAccount.organizationUuid')
    .option('--profile-name <n>', 'profile name to create', 'oauth')
    .option('--from-local', 'read oauthAccount from local ~/.claude.json')
    .option('--print-script', 'print bash setup script instead of writing')
    .option('--ansible', 'print Ansible YAML snippet instead of writing')
    .option('--onboarding-version <v>', 'value for lastOnboardingVersion')
    .action(async (opts, cmd) => {
      process.exit(await cmdInit(getGlobal(cmd), opts));
    });

  return program;
}
