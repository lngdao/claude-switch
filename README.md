# @lngdao/claude-switch

[![CI](https://github.com/lngdao/claude-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/lngdao/claude-switch/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@lngdao/claude-switch.svg)](https://www.npmjs.com/package/@lngdao/claude-switch)
[![license](https://img.shields.io/npm/l/@lngdao/claude-switch.svg)](LICENSE)

A TUI + CLI to manage multiple **Claude Code auth profiles** in `~/.claude/settings.json`. Supports OAuth tokens, API keys, third-party proxies, and headless setup workflows for VPSes.

## Install

```bash
# Run once with npx
npx @lngdao/claude-switch

# Or install globally
npm i -g @lngdao/claude-switch
claude-switch

# Optional: install a 'cs' alias into your shell rc
claude-switch alias install
```

## Features

- **Profile CRUD**: `add`, `edit`, `rename`, `delete`, `clone`, `import`, `export`.
- **Fast switching**: `claude-switch use <name>` swaps the `.env` block while preserving every other top-level key in `settings.json`.
- **Auto re-activate after edit**: if you edit the currently active profile, the new env is applied to `settings.json` immediately so it stays active.
- **Auto scheme detection**: `oauth` / `api-key` / `auth-token` / `proxy` / `mixed` / `empty`.
- **Conflict guard**: blocks saving a profile that contains both `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` (per Claude Code's own warning).
- **Token format validation**: enforces the `sk-ant-oat01-` / `sk-ant-api03-` prefixes.
- **Doctor**: checks config health (broken files, conflicts, file perms, onboarding bypass, **version drift** between `claude --version` and `lastOnboardingVersion`). Supports `--probe` to validate tokens against the API and `--fix` to auto-`chmod 600`. The probe distinguishes OAuth tokens (POST `/v1/messages` with `anthropic-beta: oauth-2025-04-20` and the Claude Code system prompt — exactly the protocol Claude Code itself uses) from API keys (free `/v1/messages/count_tokens`). Each OAuth probe burns ~22 input + 1 output token (≈$0.00003).
- **Persistent probe results**: every probe is recorded into the profile (`meta.lastProbe`) with severity, message, and timestamp; `ls`, `current`, and the TUI display "✓ 5m ago" / "✗ 2h ago" indicators.
- **Headless init**: writes `~/.claude.json` (onboarding bypass) plus a default profile, following the workflow in [this gist](https://gist.github.com/coenjacobs/d37adc34149d8c30034cd1f20a89cce9). Includes `--print-script` (bash) and `--ansible` (YAML) generators for VPS provisioning.
- **Shell alias installer**: auto-detects bash/zsh/fish and adds `alias cs='/path/to/claude-switch'` to the rc file. Idempotent and easy to uninstall.
- **Full-featured TUI**: every command above is reachable through Ink TUI hotkeys — you never have to drop back to the CLI.
- **Atomic writes + backups**: rotates 3 `.bak` copies of `settings.json`, holds an advisory lockfile to prevent races.
- **Secret masking**: tokens are masked in displays. Use `--unmask` to reveal them, or hotkey `c` in the TUI to copy the unmasked value to the clipboard.
- **Hybrid invocation**: with no arguments → opens the Ink TUI; with a sub-command → runs headless (script-friendly for Ansible/CI).

## Usage

### Profile management

```bash
claude-switch                    # open the TUI (requires a TTY)
claude-switch ls                 # list profiles
claude-switch ls --json          # JSON output for jq
claude-switch current            # show the active profile + env (masked)
claude-switch current --unmask   # show full values (requires confirmation)

claude-switch use hano           # quick switch
claude-switch use hano --dry-run # show diff without writing
claude-switch use bad --force    # bypass the conflict guard

claude-switch add                                                # interactive wizard
claude-switch add work --scheme oauth --token sk-ant-oat01-...   # non-interactive
claude-switch add proxy1 --scheme proxy --token sk-... --base-url https://anyrouter.top

claude-switch edit hano                              # interactive menu
claude-switch edit hano --set ENABLE_TOOL_SEARCH=true
claude-switch edit hano --unset ENABLE_TOOL_SEARCH
claude-switch edit hano --raw                        # open the env JSON in $EDITOR

claude-switch rename "Official backup" official-backup
claude-switch clone official official-test
claude-switch delete official-test
claude-switch delete official-test -y                # skip confirmation

claude-switch import ./shared.json --name shared
claude-switch export hano --out ./hano.json
claude-switch export hano --mask                     # masked stdout output
```

### Doctor

```bash
claude-switch doctor                # run all checks
claude-switch doctor --fix          # auto chmod 600 on profile files
claude-switch doctor --probe        # call the Anthropic API to test each token
claude-switch doctor --json         # structured output
```

Exit code: `0` for ✓/⚠ only, `10` if any ✗ are present.

### Headless init (gist workflow)

Writes `~/.claude.json` (onboarding bypass) plus a default profile:

```bash
# Interactive
claude-switch init

# Reuse oauthAccount from the local ~/.claude.json
claude-switch init --from-local --token sk-ant-oat01-...

# Non-interactive (Ansible / CI)
claude-switch init -y \
  --token sk-ant-oat01-... \
  --account-uuid 11111... \
  --email me@example.com \
  --org-uuid 22222... \
  --profile-name myhost

# Print a bash one-liner you can paste on a remote VPS
claude-switch init --print-script --token sk-ant-oat01-... \
  --account-uuid ... --email ... --org-uuid ... > setup-claude.sh

# Print an Ansible YAML snippet
claude-switch init --ansible --token sk-ant-oat01-... \
  --account-uuid ... --email ... --org-uuid ... > tasks/claude.yml
```

### Self-update

`claude-switch` checks the npm registry once per day in the background and prompts you on the next interactive run if a newer version is available — same flow as oh-my-zsh:

```
Update available (patch)
  2026.410.3 → 2026.410.4
  package: @lngdao/claude-switch

? Update now? (Y/n)
```

Saying yes spawns the install command (`npm i -g @lngdao/claude-switch@latest`, auto-detected from `npm`/`pnpm`/`yarn`/`bun`) and exits with a re-run hint.

You can also drive it explicitly:

```bash
claude-switch update --check        # report cached status only
claude-switch update                # interactive: confirm + install
claude-switch update -y             # non-interactive
claude-switch update --pm pnpm      # force a specific package manager
claude-switch update --force        # reinstall latest even if up to date
```

Disable the auto prompt with `CLAUDE_SWITCH_NO_UPDATE_CHECK=1` or the standard `NO_UPDATE_NOTIFIER=1`. The auto prompt is also skipped automatically for `--json`, `-y`, the `update` command itself, when `CI=true`, and when stdin is not a TTY.

### Shell alias installer

```bash
claude-switch alias status                # show what's currently installed
claude-switch alias install               # interactive: detect shells & confirm
claude-switch alias install -y            # non-interactive
claude-switch alias install --name cw     # custom alias name (default: cs)
claude-switch alias install --shell zsh   # restrict to one shell
claude-switch alias install --dry-run     # show diff without writing
claude-switch alias uninstall             # remove the marker block
```

The installer writes a marker block to `~/.bashrc` / `~/.zshrc` / `~/.config/fish/config.fish`, so re-running it is idempotent and `uninstall` reverts cleanly.

## Global flags

| Flag | Default | Purpose |
|---|---|---|
| `--profiles-dir <path>` | `~/.claude/profiles` | Override profiles directory |
| `--settings <path>` | `~/.claude/settings.json` | Override settings file |
| `--claude-json <path>` | `~/.claude.json` | Override onboarding bypass file |
| `--json` | off | JSON output (`ls`, `current`, `doctor`, `alias`) |
| `--no-color` | off | Disable color output |
| `-y, --yes` | off | Skip confirmation prompts |
| `-v, --verbose` | off | Verbose logging |

## Auth scheme detection

| Scheme | Condition |
|---|---|
| `oauth` | has `CLAUDE_CODE_OAUTH_TOKEN`, no other auth keys, no `ANTHROPIC_BASE_URL` |
| `api-key` | has `ANTHROPIC_API_KEY`, no other auth keys |
| `auth-token` | has `ANTHROPIC_AUTH_TOKEN`, no base URL |
| `proxy` | has `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` |
| `custom-base` | has `ANTHROPIC_BASE_URL`, no token |
| `mixed` | has 2 or more token keys (rejected by the conflict guard) |
| `empty` / `unknown` | empty env / no matching branch |

## TUI hotkeys

| Key | Action |
|---|---|
| `↑↓` / `jk` | Move profile cursor |
| `←→` / `hl` | Move env-key cursor (for copy/probe) |
| `Enter` / `s` | Switch to selected profile |
| `n` | New profile (in-place form) |
| `e` | Edit selected profile |
| `R` | Rename selected profile |
| `C` | Clone selected profile |
| `d` | Delete selected profile (confirm) |
| `I` | Import a profile from a JSON file |
| `E` | Export selected profile to a JSON file |
| `D` | Open the doctor screen (re-probe with `p`, auto-fix perms with `f`) |
| `i` | Init wizard (`~/.claude.json` + first profile, prefilled from local if available) |
| `p` | Probe selected profile against `api.anthropic.com` |
| `c` | Copy selected env value to clipboard (unmasked) |
| `A` | Shell alias installer (bash/zsh/fish) |
| `r` | Refresh from disk |
| `?` | Toggle help |
| `q` / `Esc` | Quit |

## Develop locally

```bash
git clone https://github.com/lngdao/claude-switch.git
cd claude-switch
npm install
npm run build
npm link            # makes `claude-switch` available globally
```

Tests:

```bash
npm test            # vitest run
npm run test:watch  # watch mode
npm run typecheck   # tsc --noEmit
```

The current suite has **83 test cases** covering scheme detection, profile CRUD, settings merge, doctor checks, headless init, the shell alias installer (round-trip + fish syntax + custom name), and the time-ago formatter.

## Release flow

Releases use **date-based versioning**: `YYYY.MDD.N` (e.g. `2026.410.1`). Run:

```bash
npm run release           # interactive: bumps, commits, tags, pushes
npm run release:dry       # show what would happen, no changes
```

The script (`scripts/release.sh`):
1. Aborts if the working tree is dirty or you're not on `main`.
2. Computes the next version from today's date plus an auto-incremented patch (collisions detected from existing `v*` tags).
3. Runs `npm run typecheck && npm test && npm run build` as a safety net.
4. Bumps `package.json` (and `package-lock.json`), commits with `release: <version>`, tags `vYYYY.MDD.N`, pushes branch + tag.
5. The `.github/workflows/publish.yml` workflow picks up the tag and publishes via `npm publish --provenance --access public` (provenance attestation via OIDC, auth via the `NPM_TOKEN` repo secret).

Override the auto-computed version:

```bash
./scripts/release.sh 2026.410.5
```

Manual workflow trigger is also available through the GitHub Actions "workflow_dispatch" UI with two inputs: `dry-run` (full pipeline without publishing) and `no-provenance` (escape hatch for the first-publish-of-a-new-package edge case).

## Notes

- **Locking**: uses `proper-lockfile` over the profiles directory; falls back to a no-op handle if locking fails (e.g. when the directory is being created).
- **Version drift check**: spawns `claude --version` with a 2-second timeout; if the CLI is not on `$PATH` the check is silently skipped.
- **TUI init wizard pre-fill**: account info is loaded from the local `~/.claude.json` if it exists, so creating a new profile with a fresh token doesn't require re-typing UUID / email / orgUuid.
- **In-TUI edit**: only env keys are editable from the edit screen — use hotkey `R` for rename and `C` for clone.

## License

[MIT](LICENSE) © Long Dao
