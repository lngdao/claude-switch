import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { resolvePaths, type Paths } from '../core/paths.js';
import {
  cloneProfile,
  detectCurrent,
  deleteProfile as coreDelete,
  profileFile,
  readProfile,
  renameProfile,
  summarize,
  writeProfile,
  type ProfileSummary,
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
import { runDoctor, probeOne, type CheckResult } from '../core/doctor.js';
import { performInit, readLocalOauthAccount } from '../core/headless.js';
import { readSelfPackage } from '../core/update-check.js';
import {
  aliasStatus,
  detectBinaryPath,
  installAlias,
  uninstallAlias,
  type AliasStatus,
  type ShellName,
} from '../core/alias.js';
import { TWEAKS, type TweakStatus } from '../core/tweaks.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { ProfileSchema, type Profile } from '../core/schema.js';
import { writeJsonAtomic } from '../core/fs-safe.js';
import { timeAgo } from './format.js';

interface AppProps {
  paths: Paths;
}

type Toast = { msg: string; tone: 'ok' | 'err' | 'info' };

type Mode =
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'confirmDelete'; name: string }
  | { kind: 'newProfile'; step: NewStep; draft: NewDraft }
  | { kind: 'editProfile'; name: string; step: EditStep; draft: EditDraft }
  | { kind: 'rename'; name: string; value: string }
  | { kind: 'clone'; src: string; value: string }
  | { kind: 'doctor'; loading: boolean; results: CheckResult[]; probe: boolean }
  | { kind: 'init'; step: InitStep; draft: InitDraft }
  | { kind: 'probing'; name: string }
  | { kind: 'alias'; statuses: AliasStatus[]; aliasName: string; editingName: boolean }
  | {
      kind: 'tweaks';
      statuses: Array<{ id: string; title: string; description: string; status: TweakStatus }>;
      cursor: number;
      busy: boolean;
    }
  | { kind: 'import'; step: 'path' | 'name'; filePath: string; profileName: string }
  | { kind: 'export'; step: 'path' | 'mask'; outPath: string; mask: boolean; sourceName: string };

type NewStep = 'name' | 'scheme' | 'token' | 'baseUrl' | 'extras' | 'review';
type NewDraft = {
  name: string;
  scheme: 'oauth' | 'api-key' | 'auth-token' | 'proxy' | 'empty';
  token: string;
  baseUrl: string;
};

type EditStep = 'pickKey' | 'editValue' | 'addKey' | 'addValue' | 'review';
type EditDraft = {
  env: Record<string, string>;
  cursor: number; // index into env keys
  draftKey: string;
  draftValue: string;
};

type InitStep =
  | 'token'
  | 'accountUuid'
  | 'email'
  | 'orgUuid'
  | 'profileName'
  | 'review';
type InitDraft = {
  token: string;
  accountUuid: string;
  email: string;
  orgUuid: string;
  profileName: string;
  prefilled: boolean;
};

function emptyNewDraft(): NewDraft {
  return { name: '', scheme: 'oauth', token: '', baseUrl: '' };
}

function App({ paths }: AppProps) {
  const { exit } = useApp();
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [cursor, setCursor] = useState(0);
  const [envCursor, setEnvCursor] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [tick, setTick] = useState(0);

  // Reload profiles when tick changes
  useEffect(() => {
    try {
      const env = readSettingsEnv(paths);
      const sums = summarize(paths, env);
      setProfiles(sums);
      setCursor((c) => Math.max(0, Math.min(c, sums.length - 1)));
    } catch (e) {
      setToast({ msg: `Load error: ${(e as Error).message}`, tone: 'err' });
    }
  }, [tick, paths]);

  // Auto-clear toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const selected = profiles[cursor];

  const env = useMemo(() => {
    if (!selected) return {};
    try {
      return readProfile(paths, selected.name).env;
    } catch {
      return {};
    }
  }, [selected, tick, paths]);

  const envKeys = useMemo(() => Object.keys(env), [env]);

  // Snap envCursor in range
  useEffect(() => {
    setEnvCursor((c) => Math.max(0, Math.min(c, envKeys.length - 1)));
  }, [envKeys.length]);

  // ── Input handler dispatches by mode ─────────────────────
  useInput((inputCh, key) => {
    if (mode.kind === 'help') {
      if (inputCh === '?' || key.escape || inputCh === 'q') {
        setMode({ kind: 'list' });
      }
      return;
    }

    if (mode.kind === 'confirmDelete') {
      if (inputCh === 'y' || inputCh === 'Y') {
        try {
          coreDelete(paths, mode.name);
          setToast({ msg: `Deleted ${mode.name}`, tone: 'ok' });
          setMode({ kind: 'list' });
          setTick((t) => t + 1);
        } catch (e) {
          setToast({ msg: (e as Error).message, tone: 'err' });
          setMode({ kind: 'list' });
        }
      } else if (inputCh === 'n' || inputCh === 'N' || key.escape) {
        setMode({ kind: 'list' });
      }
      return;
    }

    // newProfile / editProfile / rename / clone / init / import / export
    // have their own form components handling input via TextInput's onSubmit;
    // only Esc = cancel here.
    if (
      mode.kind === 'newProfile' ||
      mode.kind === 'editProfile' ||
      mode.kind === 'rename' ||
      mode.kind === 'clone' ||
      mode.kind === 'init' ||
      mode.kind === 'import' ||
      mode.kind === 'export'
    ) {
      if (key.escape) {
        setMode({ kind: 'list' });
        setToast({ msg: 'Cancelled', tone: 'info' });
      }
      return;
    }

    if (mode.kind === 'doctor') {
      if (key.escape || inputCh === 'q') {
        setMode({ kind: 'list' });
        return;
      }
      if (inputCh === 'p' && !mode.loading) {
        // toggle: re-run with --probe
        setMode({ ...mode, loading: true });
        runDoctor(paths, { probe: true })
          .then((report) => {
            setMode({
              kind: 'doctor',
              loading: false,
              results: report.results,
              probe: true,
            });
          })
          .catch((e) => {
            setToast({ msg: (e as Error).message, tone: 'err' });
            setMode({ kind: 'list' });
          });
      }
      if (inputCh === 'f' && !mode.loading) {
        setMode({ ...mode, loading: true });
        runDoctor(paths, { fix: true, probe: mode.probe })
          .then((report) => {
            setMode({
              kind: 'doctor',
              loading: false,
              results: report.results,
              probe: mode.probe,
            });
            setToast({ msg: 'Auto-fix applied', tone: 'ok' });
          })
          .catch((e) => {
            setToast({ msg: (e as Error).message, tone: 'err' });
            setMode({ kind: 'list' });
          });
      }
      return;
    }

    if (mode.kind === 'probing') {
      // ignore input while probing
      return;
    }

    if (mode.kind === 'tweaks') {
      if (mode.busy) return;
      if (key.escape || inputCh === 'q') {
        setMode({ kind: 'list' });
        return;
      }
      if (key.upArrow || inputCh === 'k') {
        setMode({ ...mode, cursor: Math.max(0, mode.cursor - 1) });
        return;
      }
      if (key.downArrow || inputCh === 'j') {
        setMode({
          ...mode,
          cursor: Math.min(mode.statuses.length - 1, mode.cursor + 1),
        });
        return;
      }
      if (key.return || inputCh === 'a') {
        const target = mode.statuses[mode.cursor];
        if (!target) return;
        const tweak = TWEAKS.find((t) => t.id === target.id);
        if (!tweak) return;
        setMode({ ...mode, busy: true });
        tweak
          .apply(paths)
          .then(async (summary) => {
            const refreshed = await Promise.all(
              TWEAKS.map(async (t) => ({
                id: t.id,
                title: t.title,
                description: t.description,
                status: await t.status(paths),
              })),
            );
            setMode({
              kind: 'tweaks',
              statuses: refreshed,
              cursor: mode.cursor,
              busy: false,
            });
            setToast({ msg: `${target.id}: ${summary}`, tone: 'ok' });
          })
          .catch((e) => {
            setMode({ ...mode, busy: false });
            setToast({ msg: (e as Error).message, tone: 'err' });
          });
        return;
      }
      return;
    }

    if (mode.kind === 'alias') {
      if (mode.editingName) return; // TextInput owns input
      if (key.escape || inputCh === 'q') {
        setMode({ kind: 'list' });
        return;
      }
      if (inputCh === 'r') {
        setMode({ ...mode, statuses: aliasStatus() });
        return;
      }
      if (inputCh === 'n') {
        setMode({ ...mode, editingName: true });
        return;
      }
      if (inputCh === 'i') {
        try {
          const results = installAlias({
            name: mode.aliasName,
            target: detectBinaryPath(),
          });
          setMode({ kind: 'alias', statuses: aliasStatus(), aliasName: mode.aliasName, editingName: false });
          const summary = results
            .map((r) => `${r.shell}:${r.action}`)
            .join(' ');
          setToast({ msg: `Install: ${summary}`, tone: 'ok' });
          // Queue a post-exit hint so the user knows how to activate the
          // alias in their current shell. Child process can't modify the
          // parent shell environment, so we print on quit instead.
          const touched = results.filter(
            (r) => r.action === 'created' || r.action === 'updated',
          );
          if (touched.length > 0) {
            const lines = ['', `Alias '${mode.aliasName}' installed. To use it now in this shell:`];
            for (const r of touched) {
              lines.push(`  source ${r.rcPath}`);
            }
            lines.push('');
            lines.push('Or open a new terminal — it will load automatically.');
            lines.push(
              `Or one-shot: eval "$(claude-switch alias print)"`,
            );
            postExitMessage = lines.join('\n');
          }
        } catch (e) {
          setToast({ msg: (e as Error).message, tone: 'err' });
        }
        return;
      }
      if (inputCh === 'u') {
        try {
          const results = uninstallAlias({});
          setMode({ kind: 'alias', statuses: aliasStatus(), aliasName: mode.aliasName, editingName: false });
          const summary = results
            .map((r) => `${r.shell}:${r.action}`)
            .join(' ');
          setToast({ msg: `Uninstall: ${summary}`, tone: 'ok' });
        } catch (e) {
          setToast({ msg: (e as Error).message, tone: 'err' });
        }
        return;
      }
      return;
    }

    // ── list mode ──
    if (inputCh === 'q') {
      exit();
      return;
    }
    if (key.escape) {
      exit();
      return;
    }
    if (inputCh === '?') {
      setMode({ kind: 'help' });
      return;
    }
    if (key.upArrow || inputCh === 'k') {
      setCursor((c) => Math.max(0, c - 1));
      setEnvCursor(0);
      return;
    }
    if (key.downArrow || inputCh === 'j') {
      setCursor((c) => Math.min(profiles.length - 1, c + 1));
      setEnvCursor(0);
      return;
    }
    if (key.leftArrow || inputCh === 'h') {
      setEnvCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.rightArrow || inputCh === 'l') {
      setEnvCursor((c) => Math.min(envKeys.length - 1, c + 1));
      return;
    }
    if (key.return || inputCh === 's') {
      if (!selected) return;
      try {
        const p = readProfile(paths, selected.name);
        applyEnvToSettings(paths, p.env);
        setToast({ msg: `Switched to ${selected.name}`, tone: 'ok' });
        setTick((t) => t + 1);
      } catch (e) {
        setToast({ msg: (e as Error).message, tone: 'err' });
      }
      return;
    }
    if (inputCh === 'r') {
      setTick((t) => t + 1);
      setToast({ msg: 'Refreshed', tone: 'ok' });
      return;
    }
    if (inputCh === 'd') {
      if (!selected) return;
      setMode({ kind: 'confirmDelete', name: selected.name });
      return;
    }
    if (inputCh === 'n') {
      setMode({
        kind: 'newProfile',
        step: 'name',
        draft: emptyNewDraft(),
      });
      return;
    }
    if (inputCh === 'e') {
      if (!selected) return;
      try {
        const p = readProfile(paths, selected.name);
        setMode({
          kind: 'editProfile',
          name: selected.name,
          step: 'pickKey',
          draft: {
            env: { ...p.env },
            cursor: 0,
            draftKey: '',
            draftValue: '',
          },
        });
      } catch (e) {
        setToast({ msg: (e as Error).message, tone: 'err' });
      }
      return;
    }
    if (inputCh === 'c') {
      if (envKeys.length === 0) {
        setToast({ msg: 'Nothing to copy', tone: 'info' });
        return;
      }
      const k = envKeys[envCursor];
      if (!k) return;
      copyToClipboard(env[k]!).then((ok) => {
        setToast({
          msg: ok ? `Copied ${k} to clipboard` : `Clipboard unavailable`,
          tone: ok ? 'ok' : 'err',
        });
      });
      return;
    }
    if (inputCh === 'R') {
      if (!selected) return;
      setMode({ kind: 'rename', name: selected.name, value: selected.name });
      return;
    }
    if (inputCh === 'C') {
      if (!selected) return;
      setMode({ kind: 'clone', src: selected.name, value: `${selected.name}-copy` });
      return;
    }
    if (inputCh === 'D') {
      // Open doctor screen and immediately run checks
      setMode({ kind: 'doctor', loading: true, results: [], probe: false });
      runDoctor(paths)
        .then((report) => {
          setMode({
            kind: 'doctor',
            loading: false,
            results: report.results,
            probe: false,
          });
        })
        .catch((e) => {
          setToast({ msg: (e as Error).message, tone: 'err' });
          setMode({ kind: 'list' });
        });
      return;
    }
    if (inputCh === 'p') {
      if (!selected) return;
      setMode({ kind: 'probing', name: selected.name });
      probeOne(paths, selected.name)
        .then((result) => {
          setToast({
            msg: result.title,
            tone:
              result.severity === 'ok'
                ? 'ok'
                : result.severity === 'warn'
                  ? 'info'
                  : 'err',
          });
          setMode({ kind: 'list' });
        })
        .catch((e) => {
          setToast({ msg: (e as Error).message, tone: 'err' });
          setMode({ kind: 'list' });
        });
      return;
    }
    if (inputCh === 'A') {
      setMode({
        kind: 'alias',
        statuses: aliasStatus(),
        aliasName: 'cs',
        editingName: false,
      });
      return;
    }
    if (inputCh === 'I') {
      setMode({
        kind: 'import',
        step: 'path',
        filePath: './profile.json',
        profileName: '',
      });
      return;
    }
    if (inputCh === 'E') {
      if (!selected) return;
      setMode({
        kind: 'export',
        step: 'path',
        outPath: `./${selected.name}.json`,
        mask: false,
        sourceName: selected.name,
      });
      return;
    }
    if (inputCh === 'T') {
      // Snapshot tweak statuses synchronously to render immediately
      Promise.all(
        TWEAKS.map(async (t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          status: await t.status(paths),
        })),
      ).then((statuses) => {
        setMode({ kind: 'tweaks', statuses, cursor: 0, busy: false });
      });
      return;
    }
    if (inputCh === 'i') {
      // Pre-fill from local ~/.claude.json if available
      const local = readLocalOauthAccount(paths);
      const prefilled = !!local;
      setMode({
        kind: 'init',
        step: 'token',
        draft: {
          token: '',
          accountUuid: local?.accountUuid ?? '',
          email: local?.emailAddress ?? '',
          orgUuid: local?.organizationUuid ?? '',
          profileName: 'oauth',
          prefilled,
        },
      });
      if (prefilled) {
        setToast({
          msg: 'Pre-filled account info from ~/.claude.json',
          tone: 'info',
        });
      }
      return;
    }
  });

  if (mode.kind === 'help') {
    return <HelpScreen />;
  }

  if (mode.kind === 'newProfile') {
    return (
      <NewProfileForm
        paths={paths}
        mode={mode}
        onCancel={() => {
          setMode({ kind: 'list' });
          setToast({ msg: 'Cancelled', tone: 'info' });
        }}
        onDone={(name) => {
          setMode({ kind: 'list' });
          setToast({ msg: `Created ${name}`, tone: 'ok' });
          setTick((t) => t + 1);
        }}
        onError={(msg) => setToast({ msg, tone: 'err' })}
        setMode={setMode}
      />
    );
  }

  if (mode.kind === 'editProfile') {
    return (
      <EditProfileForm
        paths={paths}
        mode={mode}
        onCancel={() => {
          setMode({ kind: 'list' });
          setToast({ msg: 'Cancelled', tone: 'info' });
        }}
        onDone={(name, reActivated) => {
          setMode({ kind: 'list' });
          setToast({
            msg: reActivated ? `Saved ${name} (re-activated)` : `Saved ${name}`,
            tone: 'ok',
          });
          setTick((t) => t + 1);
        }}
        onError={(msg) => setToast({ msg, tone: 'err' })}
        setMode={setMode}
      />
    );
  }

  if (mode.kind === 'rename') {
    return (
      <RenameForm
        paths={paths}
        mode={mode}
        onDone={(newName) => {
          setMode({ kind: 'list' });
          setToast({ msg: `Renamed → ${newName}`, tone: 'ok' });
          setTick((t) => t + 1);
        }}
        onError={(msg) => setToast({ msg, tone: 'err' })}
        setMode={setMode}
      />
    );
  }

  if (mode.kind === 'clone') {
    return (
      <CloneForm
        paths={paths}
        mode={mode}
        onDone={(dst) => {
          setMode({ kind: 'list' });
          setToast({ msg: `Cloned → ${dst}`, tone: 'ok' });
          setTick((t) => t + 1);
        }}
        onError={(msg) => setToast({ msg, tone: 'err' })}
        setMode={setMode}
      />
    );
  }

  if (mode.kind === 'doctor') {
    return <DoctorScreen mode={mode} />;
  }

  if (mode.kind === 'init') {
    return (
      <InitForm
        paths={paths}
        mode={mode}
        onDone={(profileName) => {
          setMode({ kind: 'list' });
          setToast({
            msg: `Init done — wrote ~/.claude.json and profile '${profileName}'`,
            tone: 'ok',
          });
          setTick((t) => t + 1);
        }}
        onError={(msg) => setToast({ msg, tone: 'err' })}
        setMode={setMode}
      />
    );
  }

  if (mode.kind === 'probing') {
    return (
      <Box padding={1}>
        <Text color="cyan">⠋ Probing {mode.name} against api.anthropic.com…</Text>
      </Box>
    );
  }

  if (mode.kind === 'alias') {
    return (
      <AliasScreen
        mode={mode}
        setMode={setMode}
        onToast={(msg, tone) => setToast({ msg, tone })}
      />
    );
  }

  if (mode.kind === 'tweaks') {
    return <TweaksScreen mode={mode} />;
  }

  if (mode.kind === 'import') {
    return (
      <ImportForm
        paths={paths}
        mode={mode}
        onDone={(name) => {
          setMode({ kind: 'list' });
          setToast({ msg: `Imported as ${name}`, tone: 'ok' });
          setTick((t) => t + 1);
        }}
        onError={(msg) => setToast({ msg, tone: 'err' })}
        setMode={setMode}
      />
    );
  }

  if (mode.kind === 'export') {
    return (
      <ExportForm
        paths={paths}
        mode={mode}
        onDone={(outPath) => {
          setMode({ kind: 'list' });
          setToast({ msg: `Exported to ${outPath}`, tone: 'ok' });
        }}
        onError={(msg) => setToast({ msg, tone: 'err' })}
        setMode={setMode}
      />
    );
  }

  return (
    <Box flexDirection="column">
      <Header paths={paths} tick={tick} />
      <Box>
        <ProfileListView profiles={profiles} cursor={cursor} />
        <EnvPreview profile={selected} env={env} envCursor={envCursor} />
      </Box>
      <Footer mode={mode} />
      {toast ? (
        <Box marginTop={1}>
          <Text
            color={
              toast.tone === 'ok'
                ? 'green'
                : toast.tone === 'err'
                  ? 'red'
                  : 'yellow'
            }
          >
            {toast.tone === 'ok' ? '✓ ' : toast.tone === 'err' ? '✗ ' : '· '}
            {toast.msg}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

// ─── Header / list / preview / footer ──────────────────────

function Header({ paths, tick }: { paths: Paths; tick: number }) {
  const env = useMemo(() => readSettingsEnv(paths), [paths, tick]);
  const current = useMemo(() => detectCurrent(paths, env), [paths, env, tick]);
  const scheme = detectScheme(env);
  const version = useMemo(() => readSelfPackage()?.version ?? '?', []);
  return (
    <Box marginBottom={1} flexDirection="column">
      <Text bold>
        ╭─ Claude Code Profile Switcher{' '}
        <Text color="yellow">v{version}</Text> ─╮
      </Text>
      <Text>
        <Text bold>│ </Text>
        Active: <Text color="cyan">{current}</Text>{' '}
        <Text dimColor>({schemeBadge(scheme)})</Text>
      </Text>
      <Text bold>╰─────────────────────────────────────────╯</Text>
    </Box>
  );
}

function ProfileListView({
  profiles,
  cursor,
}: {
  profiles: ProfileSummary[];
  cursor: number;
}) {
  if (profiles.length === 0) {
    return (
      <Box width={36} flexDirection="column" paddingX={1}>
        <Text dimColor>No profiles. Press n to create one.</Text>
      </Box>
    );
  }
  return (
    <Box width={36} flexDirection="column" paddingX={1}>
      {profiles.map((p, i) => {
        const isCursor = i === cursor;
        const dot = p.active ? '●' : '○';
        const probeIcon = p.lastProbe
          ? p.lastProbe.severity === 'ok'
            ? { glyph: '✓', color: 'green' as const }
            : p.lastProbe.severity === 'warn'
              ? { glyph: '⚠', color: 'yellow' as const }
              : { glyph: '✗', color: 'red' as const }
          : { glyph: '·', color: undefined };
        return (
          <Text key={p.name}>
            <Text color={isCursor ? 'cyan' : undefined}>
              {isCursor ? '› ' : '  '}
            </Text>
            <Text color={p.active ? 'green' : undefined} bold={p.active}>
              {dot} {p.name}
            </Text>
            <Text dimColor> {schemeBadge(p.scheme)} </Text>
            <Text color={probeIcon.color} dimColor={!probeIcon.color}>
              {probeIcon.glyph}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}

function EnvPreview({
  profile,
  env,
  envCursor,
}: {
  profile: ProfileSummary | undefined;
  env: Record<string, string>;
  envCursor: number;
}) {
  if (!profile) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>(no profile selected)</Text>
      </Box>
    );
  }
  const keys = Object.keys(env);
  const probe = profile.lastProbe;
  return (
    <Box flexDirection="column" paddingX={1} flexGrow={1}>
      <Text>
        <Text bold>{profile.name}</Text>
        <Text dimColor>  {profile.envKeys.length} env</Text>
      </Text>
      <Text dimColor>{profile.file}</Text>
      <Text> </Text>
      {probe ? (
        <Box flexDirection="column">
          <Text>
            <Text
              color={
                probe.severity === 'ok'
                  ? 'green'
                  : probe.severity === 'warn'
                    ? 'yellow'
                    : 'red'
              }
            >
              {probe.severity === 'ok' ? '✓ ' : probe.severity === 'warn' ? '⚠ ' : '✗ '}
            </Text>
            <Text>{probe.title}</Text>
            <Text dimColor>  {timeAgo(probe.at)}</Text>
          </Text>
          {probe.detail ? <Text dimColor>    {probe.detail}</Text> : null}
        </Box>
      ) : (
        <Text dimColor>· never probed (press p to test)</Text>
      )}
      <Text> </Text>
      {keys.length === 0 ? (
        <Text dimColor>(empty env)</Text>
      ) : (
        keys.map((k, i) => {
          const isCursor = i === envCursor;
          return (
            <Text key={k}>
              <Text color={isCursor ? 'cyan' : undefined}>
                {isCursor ? '› ' : '  '}
              </Text>
              <Text color="yellow">{k}</Text>
              <Text> = </Text>
              <Text dimColor>{maskValue(k, env[k]!)}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}

function Footer({ mode }: { mode: Mode }) {
  if (mode.kind === 'confirmDelete') {
    return (
      <Box marginTop={1}>
        <Text color="red">Delete {mode.name}? (y/N)</Text>
      </Box>
    );
  }
  return (
    <Box marginTop={1} flexDirection="column">
      <Text dimColor>
        ↑↓ profile · ←→ env · enter switch · c copy · p probe
      </Text>
      <Text dimColor>
        n new · e edit · R rename · C clone · d delete · I import · E export ·
        D doctor · i init · T tweaks · A alias · r refresh · ? help · q quit
      </Text>
    </Box>
  );
}

function HelpScreen() {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Claude Code Profile Switcher — TUI help</Text>
      <Text> </Text>
      <Text bold color="cyan">Navigation</Text>
      <Text>  ↑↓/jk    Move profile cursor</Text>
      <Text>  ←→/hl    Move env-key cursor</Text>
      <Text>  Enter/s  Switch to selected profile</Text>
      <Text> </Text>
      <Text bold color="cyan">Profile actions</Text>
      <Text>  n        New profile (in-place form)</Text>
      <Text>  e        Edit selected profile</Text>
      <Text>  R        Rename selected profile</Text>
      <Text>  C        Clone selected profile</Text>
      <Text>  d        Delete selected profile</Text>
      <Text>  I        Import a profile from a JSON file</Text>
      <Text>  E        Export selected profile to a JSON file</Text>
      <Text> </Text>
      <Text bold color="cyan">Auth / health</Text>
      <Text>  i        Init wizard (write ~/.claude.json + first profile)</Text>
      <Text>  D        Doctor screen (config health checks)</Text>
      <Text>  p        Probe selected profile against api.anthropic.com</Text>
      <Text>  c        Copy selected env value to clipboard (unmasked)</Text>
      <Text>  A        Shell alias installer (bash/zsh/fish)</Text>
      <Text>  T        Tweaks (bypass onboarding, opus[1m], …)</Text>
      <Text> </Text>
      <Text bold color="cyan">Misc</Text>
      <Text>  r        Refresh from disk</Text>
      <Text>  ?        Toggle this help</Text>
      <Text>  q/Esc    Quit</Text>
      <Text> </Text>
      <Text dimColor>Import / export still in CLI:</Text>
      <Text dimColor>  claude-switch import &lt;file&gt;</Text>
      <Text dimColor>  claude-switch export &lt;name&gt;</Text>
      <Text> </Text>
      <Text dimColor>Press ? or q to return.</Text>
    </Box>
  );
}

// ─── New-profile form ─────────────────────────────────────

interface FormProps<M extends Mode> {
  paths: Paths;
  mode: M;
  onCancel?: () => void;
  onDone: (name: string, reActivated?: boolean) => void;
  onError: (msg: string) => void;
  setMode: React.Dispatch<React.SetStateAction<Mode>>;
}

function NewProfileForm({
  paths,
  mode,
  onDone,
  onError,
  setMode,
}: FormProps<Extract<Mode, { kind: 'newProfile' }>>) {
  const { step, draft } = mode;

  const update = (next: Partial<NewDraft>, nextStep?: NewStep) => {
    setMode({
      kind: 'newProfile',
      step: nextStep ?? step,
      draft: { ...draft, ...next },
    });
  };

  if (step === 'name') {
    return (
      <FormShell title="New profile — name">
        <TextInput
          value={draft.name}
          onChange={(v) => update({ name: v })}
          onSubmit={(v) => {
            const name = v.trim();
            if (!name) {
              onError('Name is required');
              return;
            }
            if (existsSync(profileFile(paths, name))) {
              onError(`Profile already exists: ${name}`);
              return;
            }
            update({ name }, 'scheme');
          }}
          placeholder="e.g. work, vps-1, anyrouter"
        />
        <Text dimColor>Enter to continue · Esc to cancel</Text>
      </FormShell>
    );
  }

  if (step === 'scheme') {
    const schemes: NewDraft['scheme'][] = [
      'oauth',
      'api-key',
      'auth-token',
      'proxy',
      'empty',
    ];
    const labels: Record<NewDraft['scheme'], string> = {
      oauth: 'oauth      — CLAUDE_CODE_OAUTH_TOKEN (Pro/Max)',
      'api-key': 'api-key    — ANTHROPIC_API_KEY',
      'auth-token': 'auth-token — ANTHROPIC_AUTH_TOKEN (bearer)',
      proxy: 'proxy      — token + ANTHROPIC_BASE_URL (3rd-party)',
      empty: 'empty      — start blank, edit later',
    };
    const idx = schemes.indexOf(draft.scheme);
    return (
      <FormShell title={`New profile '${draft.name}' — pick scheme`}>
        <SchemePicker
          schemes={schemes}
          labels={labels}
          cursor={idx}
          onMove={(d) => {
            const next = schemes[Math.max(0, Math.min(schemes.length - 1, idx + d))]!;
            update({ scheme: next });
          }}
          onSubmit={() => {
            if (draft.scheme === 'empty') {
              try {
                writeProfile(paths, draft.name, { env: {} });
                onDone(draft.name);
              } catch (e) {
                onError((e as Error).message);
              }
              return;
            }
            update({}, 'token');
          }}
        />
      </FormShell>
    );
  }

  if (step === 'token') {
    const keyName =
      draft.scheme === 'oauth'
        ? AUTH_KEYS.OAUTH
        : draft.scheme === 'api-key'
          ? AUTH_KEYS.API_KEY
          : AUTH_KEYS.AUTH_TOKEN;
    return (
      <FormShell title={`New profile '${draft.name}' — ${keyName}`}>
        <TextInput
          value={draft.token}
          onChange={(v) => update({ token: v })}
          mask="*"
          onSubmit={(v) => {
            if (!v) {
              onError('Token is required');
              return;
            }
            const pre = checkTokenPrefix(keyName, v);
            if (!pre.ok) {
              onError(`Token should start with '${pre.expected}'`);
              return;
            }
            if (draft.scheme === 'proxy') {
              update({ token: v }, 'baseUrl');
            } else {
              const env: Record<string, string> = { [keyName]: v };
              try {
                writeProfile(paths, draft.name, { env });
                onDone(draft.name);
              } catch (e) {
                onError((e as Error).message);
              }
            }
          }}
          placeholder={
            draft.scheme === 'oauth'
              ? 'sk-ant-oat01-…'
              : draft.scheme === 'api-key'
                ? 'sk-ant-api03-…'
                : 'token value'
          }
        />
        <Text dimColor>Input is masked · Enter to continue · Esc to cancel</Text>
      </FormShell>
    );
  }

  if (step === 'baseUrl') {
    return (
      <FormShell title={`New profile '${draft.name}' — ANTHROPIC_BASE_URL`}>
        <TextInput
          value={draft.baseUrl}
          onChange={(v) => update({ baseUrl: v })}
          onSubmit={(v) => {
            if (!v) {
              onError('Base URL is required for proxy scheme');
              return;
            }
            const env: Record<string, string> = {
              [AUTH_KEYS.AUTH_TOKEN]: draft.token,
              [AUTH_KEYS.BASE_URL]: v,
            };
            try {
              writeProfile(paths, draft.name, { env });
              onDone(draft.name);
            } catch (e) {
              onError((e as Error).message);
            }
          }}
          placeholder="https://anyrouter.top"
        />
      </FormShell>
    );
  }

  return null;
}

// ─── Edit-profile form ────────────────────────────────────

function EditProfileForm({
  paths,
  mode,
  onDone,
  onError,
  setMode,
}: FormProps<Extract<Mode, { kind: 'editProfile' }>>) {
  const { name, step, draft } = mode;

  const update = (next: Partial<EditDraft>, nextStep?: EditStep) => {
    setMode({
      kind: 'editProfile',
      name,
      step: nextStep ?? step,
      draft: { ...draft, ...next },
    });
  };

  const keys = Object.keys(draft.env);

  useInput((inputCh, key) => {
    if (step !== 'pickKey') return;
    if (inputCh === 'q' || key.escape) {
      setMode({ kind: 'list' });
      return;
    }
    if (key.upArrow || inputCh === 'k') {
      update({ cursor: Math.max(0, draft.cursor - 1) });
      return;
    }
    if (key.downArrow || inputCh === 'j') {
      // +2 for the two action rows: + Add key, ✓ Save
      const max = keys.length + 1;
      update({ cursor: Math.min(max, draft.cursor + 1) });
      return;
    }
    if (key.return) {
      const pos = draft.cursor;
      if (pos < keys.length) {
        const k = keys[pos]!;
        update(
          { draftKey: k, draftValue: draft.env[k] ?? '' },
          'editValue',
        );
      } else if (pos === keys.length) {
        update({ draftKey: '', draftValue: '' }, 'addKey');
      } else {
        // save
        const conflict = checkConflicts(draft.env);
        if (!conflict.ok) {
          onError(`Conflict: ${conflict.conflicts.join(' + ')}`);
          return;
        }
        const wasActive =
          detectCurrent(paths, readSettingsEnv(paths)) === name;
        try {
          const existing = readProfile(paths, name);
          writeProfile(paths, name, {
            env: draft.env,
            meta: existing.meta,
          });
          if (wasActive) {
            applyEnvToSettings(paths, draft.env);
          }
          onDone(name, wasActive);
        } catch (e) {
          onError((e as Error).message);
        }
      }
      return;
    }
    if (inputCh === 'x' || inputCh === 'D') {
      // delete the key under cursor
      const pos = draft.cursor;
      if (pos < keys.length) {
        const k = keys[pos]!;
        const next = { ...draft.env };
        delete next[k];
        update({ env: next, cursor: Math.max(0, pos - 1) });
      }
    }
  });

  if (step === 'pickKey') {
    return (
      <FormShell title={`Editing '${name}' — pick a key`}>
        <Box flexDirection="column">
          {keys.length === 0 ? (
            <Text dimColor>(no keys yet)</Text>
          ) : (
            keys.map((k, i) => {
              const isCursor = i === draft.cursor;
              return (
                <Text key={k}>
                  <Text color={isCursor ? 'cyan' : undefined}>
                    {isCursor ? '› ' : '  '}
                  </Text>
                  <Text color="yellow">{k}</Text>
                  <Text> = </Text>
                  <Text dimColor>{maskValue(k, draft.env[k]!)}</Text>
                </Text>
              );
            })
          )}
          <Text>
            <Text color={draft.cursor === keys.length ? 'cyan' : undefined}>
              {draft.cursor === keys.length ? '› ' : '  '}
            </Text>
            <Text color="green">+ Add new key</Text>
          </Text>
          <Text>
            <Text color={draft.cursor === keys.length + 1 ? 'cyan' : undefined}>
              {draft.cursor === keys.length + 1 ? '› ' : '  '}
            </Text>
            <Text color="green">✓ Save & exit</Text>
          </Text>
        </Box>
        <Text> </Text>
        <Text dimColor>↑↓ nav · enter select · x delete key · Esc cancel</Text>
      </FormShell>
    );
  }

  if (step === 'editValue') {
    const k = draft.draftKey;
    const secret = isSecretKey(k);
    return (
      <FormShell title={`Editing '${name}' — ${k}`}>
        <TextInput
          value={draft.draftValue}
          onChange={(v) => update({ draftValue: v })}
          mask={secret ? '*' : undefined}
          onSubmit={(v) => {
            const next = { ...draft.env };
            if (v === '') {
              delete next[k];
            } else {
              next[k] = v;
            }
            update({ env: next, draftKey: '', draftValue: '' }, 'pickKey');
          }}
        />
        <Text dimColor>
          Empty value = delete key · Enter to save · Esc to cancel
        </Text>
      </FormShell>
    );
  }

  if (step === 'addKey') {
    return (
      <FormShell title={`Editing '${name}' — new key name`}>
        <TextInput
          value={draft.draftKey}
          onChange={(v) => update({ draftKey: v })}
          onSubmit={(v) => {
            if (!v) {
              onError('Key name is required');
              return;
            }
            update({ draftKey: v, draftValue: '' }, 'addValue');
          }}
          placeholder="KEY_NAME"
        />
      </FormShell>
    );
  }

  if (step === 'addValue') {
    const k = draft.draftKey;
    const secret = isSecretKey(k);
    return (
      <FormShell title={`Editing '${name}' — value for ${k}`}>
        <TextInput
          value={draft.draftValue}
          onChange={(v) => update({ draftValue: v })}
          mask={secret ? '*' : undefined}
          onSubmit={(v) => {
            const next = { ...draft.env, [k]: v };
            update({ env: next, draftKey: '', draftValue: '' }, 'pickKey');
          }}
        />
      </FormShell>
    );
  }

  return null;
}

// ─── Form helpers ─────────────────────────────────────────

function FormShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      <Text> </Text>
      {children}
    </Box>
  );
}

function SchemePicker({
  schemes,
  labels,
  cursor,
  onMove,
  onSubmit,
}: {
  schemes: NewDraft['scheme'][];
  labels: Record<NewDraft['scheme'], string>;
  cursor: number;
  onMove: (delta: number) => void;
  onSubmit: () => void;
}) {
  useInput((inputCh, key) => {
    if (key.upArrow || inputCh === 'k') onMove(-1);
    else if (key.downArrow || inputCh === 'j') onMove(1);
    else if (key.return) onSubmit();
  });
  return (
    <Box flexDirection="column">
      {schemes.map((s, i) => {
        const isCursor = i === cursor;
        return (
          <Text key={s}>
            <Text color={isCursor ? 'cyan' : undefined}>
              {isCursor ? '› ' : '  '}
            </Text>
            <Text>{labels[s]}</Text>
          </Text>
        );
      })}
      <Text> </Text>
      <Text dimColor>↑↓ nav · Enter select · Esc cancel</Text>
    </Box>
  );
}

// ─── Rename / clone forms ─────────────────────────────────

function RenameForm({
  paths,
  mode,
  onDone,
  onError,
  setMode,
}: FormProps<Extract<Mode, { kind: 'rename' }>>) {
  return (
    <FormShell title={`Rename '${mode.name}'`}>
      <TextInput
        value={mode.value}
        onChange={(v) => setMode({ ...mode, value: v })}
        onSubmit={(v) => {
          const next = v.trim();
          if (!next || next === mode.name) {
            setMode({ kind: 'list' });
            return;
          }
          try {
            renameProfile(paths, mode.name, next);
            onDone(next);
          } catch (e) {
            onError((e as Error).message);
          }
        }}
      />
      <Text dimColor>Enter to confirm · Esc to cancel</Text>
    </FormShell>
  );
}

function CloneForm({
  paths,
  mode,
  onDone,
  onError,
  setMode,
}: FormProps<Extract<Mode, { kind: 'clone' }>>) {
  return (
    <FormShell title={`Clone '${mode.src}' as`}>
      <TextInput
        value={mode.value}
        onChange={(v) => setMode({ ...mode, value: v })}
        onSubmit={(v) => {
          const next = v.trim();
          if (!next) {
            onError('Name required');
            return;
          }
          try {
            cloneProfile(paths, mode.src, next);
            onDone(next);
          } catch (e) {
            onError((e as Error).message);
          }
        }}
      />
      <Text dimColor>Enter to confirm · Esc to cancel</Text>
    </FormShell>
  );
}

// ─── Import / export forms ────────────────────────────────

function basenameNoExt(path: string): string {
  const last = path.split(/[\\/]/).pop() ?? '';
  return last.replace(/\.json$/i, '');
}

function ImportForm({
  paths,
  mode,
  onDone,
  onError,
  setMode,
}: FormProps<Extract<Mode, { kind: 'import' }>>) {
  const { step } = mode;

  if (step === 'path') {
    return (
      <FormShell title="Import profile — path to JSON file">
        <TextInput
          value={mode.filePath}
          onChange={(v) => setMode({ ...mode, filePath: v })}
          onSubmit={(v) => {
            const file = resolvePath(v.trim());
            if (!file) {
              onError('File path is required');
              return;
            }
            if (!existsSync(file)) {
              onError(`File not found: ${file}`);
              return;
            }
            // Quick parse check so we fail fast (don't wait for the next step)
            try {
              const raw = JSON.parse(readFileSync(file, 'utf8'));
              const parsed = ProfileSchema.safeParse(raw);
              if (!parsed.success) {
                onError(
                  `Schema error: ${parsed.error.issues
                    .map((i) => i.message)
                    .join('; ')}`,
                );
                return;
              }
            } catch (e) {
              onError(`Invalid JSON: ${(e as Error).message}`);
              return;
            }
            setMode({
              ...mode,
              filePath: file,
              profileName: basenameNoExt(file),
              step: 'name',
            });
          }}
          placeholder="./profile.json"
        />
        <Text dimColor>Enter to load · Esc to cancel</Text>
      </FormShell>
    );
  }

  if (step === 'name') {
    return (
      <FormShell title={`Import as profile name`}>
        <Text dimColor>From {mode.filePath}</Text>
        <Text> </Text>
        <TextInput
          value={mode.profileName}
          onChange={(v) => setMode({ ...mode, profileName: v })}
          onSubmit={(v) => {
            const name = v.trim();
            if (!name) {
              onError('Profile name is required');
              return;
            }
            if (existsSync(profileFile(paths, name))) {
              onError(`Profile already exists: ${name}`);
              return;
            }
            try {
              const raw = JSON.parse(readFileSync(mode.filePath, 'utf8'));
              const parsed = ProfileSchema.safeParse(raw);
              if (!parsed.success) {
                onError('Schema error (re-parse failed)');
                return;
              }
              writeProfile(paths, name, parsed.data);
              onDone(name);
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        />
        <Text dimColor>Enter to save · Esc to cancel</Text>
      </FormShell>
    );
  }

  return null;
}

function ExportForm({
  paths,
  mode,
  onDone,
  onError,
  setMode,
}: FormProps<Extract<Mode, { kind: 'export' }>>) {
  const { step } = mode;

  if (step === 'path') {
    return (
      <FormShell title={`Export '${mode.sourceName}' — output path`}>
        <TextInput
          value={mode.outPath}
          onChange={(v) => setMode({ ...mode, outPath: v })}
          onSubmit={(v) => {
            const out = v.trim();
            if (!out) {
              onError('Output path is required');
              return;
            }
            setMode({ ...mode, outPath: resolvePath(out), step: 'mask' });
          }}
        />
        <Text dimColor>Default is ./{mode.sourceName}.json · Enter to next · Esc cancel</Text>
      </FormShell>
    );
  }

  if (step === 'mask') {
    return (
      <FormShell title={`Mask secret values?`}>
        <Text>
          Target: <Text dimColor>{mode.outPath}</Text>
        </Text>
        <Text> </Text>
        <Text>
          Mask secrets in the exported file?{' '}
          <Text color={mode.mask ? 'green' : 'yellow'} bold>
            {mode.mask ? 'YES' : 'NO (raw tokens)'}
          </Text>
        </Text>
        <Text dimColor>
          Press space to toggle · Enter to write · Esc to cancel
        </Text>
        {/* Hidden input absorbs key events for this step */}
        <ExportMaskKeys
          mask={mode.mask}
          onToggle={() => setMode({ ...mode, mask: !mode.mask })}
          onSubmit={() => {
            try {
              const profile = readProfile(paths, mode.sourceName);
              const out: Profile = mode.mask
                ? {
                    env: Object.fromEntries(
                      Object.entries(profile.env).map(([k, v]) => [
                        k,
                        maskValue(k, v),
                      ]),
                    ),
                    meta: profile.meta,
                  }
                : profile;
              writeJsonAtomic(mode.outPath, out, { mode: 0o600 });
              onDone(mode.outPath);
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        />
      </FormShell>
    );
  }

  return null;
}

function ExportMaskKeys({
  mask,
  onToggle,
  onSubmit,
}: {
  mask: boolean;
  onToggle: () => void;
  onSubmit: () => void;
}) {
  useInput((inputCh, key) => {
    if (key.return) {
      onSubmit();
      return;
    }
    if (inputCh === ' ' || inputCh === 'm' || inputCh === 'M') {
      onToggle();
      return;
    }
    if (inputCh === 'y' || inputCh === 'Y') {
      // Submit with mask=true regardless of current state
      if (!mask) onToggle();
      onSubmit();
    }
    if (inputCh === 'n' || inputCh === 'N') {
      if (mask) onToggle();
      onSubmit();
    }
  });
  return null;
}

// ─── Doctor screen ────────────────────────────────────────

function DoctorScreen({
  mode,
}: {
  mode: Extract<Mode, { kind: 'doctor' }>;
}) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        Doctor {mode.probe ? '(with --probe)' : ''}
      </Text>
      <Text> </Text>
      {mode.loading ? (
        <Text color="cyan">⠋ Running checks…</Text>
      ) : (
        <>
          {mode.results.map((r) => (
            <Box key={r.id} flexDirection="column">
              <Text>
                <Text
                  color={
                    r.severity === 'ok'
                      ? 'green'
                      : r.severity === 'warn'
                        ? 'yellow'
                        : 'red'
                  }
                >
                  {r.severity === 'ok' ? '✓ ' : r.severity === 'warn' ? '⚠ ' : '✗ '}
                </Text>
                <Text>{r.title}</Text>
              </Text>
              {r.detail ? <Text dimColor>      {r.detail}</Text> : null}
              {r.fix ? <Text dimColor>      → {r.fix}</Text> : null}
            </Box>
          ))}
          <Text> </Text>
          <Text dimColor>p probe · f auto-fix perms · q/Esc back</Text>
        </>
      )}
    </Box>
  );
}

// ─── Init wizard ──────────────────────────────────────────

function InitForm({
  paths,
  mode,
  onDone,
  onError,
  setMode,
}: FormProps<Extract<Mode, { kind: 'init' }>>) {
  const { step, draft } = mode;

  const update = (next: Partial<InitDraft>, nextStep?: InitStep) => {
    setMode({
      kind: 'init',
      step: nextStep ?? step,
      draft: { ...draft, ...next },
    });
  };

  if (step === 'token') {
    return (
      <FormShell title="Init — OAuth token">
        <Text dimColor>
          From `claude setup-token` on a machine with a browser. Format:
          sk-ant-oat01-…
        </Text>
        <Text> </Text>
        <TextInput
          value={draft.token}
          onChange={(v) => update({ token: v })}
          mask="*"
          onSubmit={(v) => {
            if (!v) {
              onError('Token required');
              return;
            }
            const pre = checkTokenPrefix(AUTH_KEYS.OAUTH, v);
            if (!pre.ok) {
              onError(`Token must start with '${pre.expected}'`);
              return;
            }
            update({ token: v }, 'accountUuid');
          }}
        />
        <Text dimColor>Input is masked · Enter to continue · Esc to cancel</Text>
      </FormShell>
    );
  }

  if (step === 'accountUuid') {
    return (
      <FormShell title="Init — accountUuid">
        {draft.prefilled ? (
          <Text dimColor>(pre-filled from local ~/.claude.json)</Text>
        ) : null}
        <TextInput
          value={draft.accountUuid}
          onChange={(v) => update({ accountUuid: v })}
          onSubmit={(v) => {
            if (!v) {
              onError('accountUuid required');
              return;
            }
            update({ accountUuid: v }, 'email');
          }}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        />
      </FormShell>
    );
  }

  if (step === 'email') {
    return (
      <FormShell title="Init — emailAddress">
        <TextInput
          value={draft.email}
          onChange={(v) => update({ email: v })}
          onSubmit={(v) => {
            if (!v) {
              onError('email required');
              return;
            }
            update({ email: v }, 'orgUuid');
          }}
          placeholder="you@example.com"
        />
      </FormShell>
    );
  }

  if (step === 'orgUuid') {
    return (
      <FormShell title="Init — organizationUuid">
        <TextInput
          value={draft.orgUuid}
          onChange={(v) => update({ orgUuid: v })}
          onSubmit={(v) => {
            if (!v) {
              onError('organizationUuid required');
              return;
            }
            update({ orgUuid: v }, 'profileName');
          }}
          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        />
      </FormShell>
    );
  }

  if (step === 'profileName') {
    return (
      <FormShell title="Init — profile name to create">
        <TextInput
          value={draft.profileName}
          onChange={(v) => update({ profileName: v })}
          onSubmit={(v) => {
            const name = v.trim() || 'oauth';
            try {
              const result = performInit(paths, {
                token: draft.token,
                account: {
                  accountUuid: draft.accountUuid,
                  emailAddress: draft.email,
                  organizationUuid: draft.orgUuid,
                },
                profileName: name,
              });
              onDone(result.profileName);
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        />
        <Text dimColor>
          This writes ~/.claude.json (onboarding bypass) and the named profile.
        </Text>
      </FormShell>
    );
  }

  return null;
}

// ─── Alias screen ─────────────────────────────────────────

function AliasScreen({
  mode,
  setMode,
  onToast,
}: {
  mode: Extract<Mode, { kind: 'alias' }>;
  setMode: React.Dispatch<React.SetStateAction<Mode>>;
  onToast: (msg: string, tone: Toast['tone']) => void;
}) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">Shell alias installer</Text>
      <Text> </Text>
      <Text>
        Alias name: <Text color="yellow">{mode.aliasName}</Text>{' '}
        <Text dimColor>(press n to rename)</Text>
      </Text>
      <Text>
        Target: <Text dimColor>{detectBinaryPath()}</Text>
      </Text>
      <Text> </Text>
      {mode.editingName ? (
        <Box>
          <Text>New alias name: </Text>
          <TextInput
            value={mode.aliasName}
            onChange={(v) => setMode({ ...mode, aliasName: v })}
            onSubmit={(v) => {
              const name = v.trim() || 'cs';
              setMode({ ...mode, aliasName: name, editingName: false });
            }}
          />
        </Box>
      ) : null}
      <Text bold>Detected shells:</Text>
      {mode.statuses.length === 0 ? (
        <Text dimColor>  (none — checked ~/.bashrc, ~/.zshrc, ~/.config/fish/config.fish)</Text>
      ) : (
        mode.statuses.map((s) => (
          <Box key={s.shell} flexDirection="column">
            <Text>
              <Text color={s.installed ? 'green' : undefined}>
                {s.installed ? '  ● ' : '  ○ '}
              </Text>
              <Text bold>{s.shell}</Text>
              <Text dimColor>  {s.rcPath}</Text>
            </Text>
            {s.installed && s.currentLine ? (
              <Text dimColor>      {s.currentLine}</Text>
            ) : null}
          </Box>
        ))
      )}
      <Text> </Text>
      <Text dimColor>i install · u uninstall · n rename alias · r refresh · q/Esc back</Text>
      {(() => {
        void onToast;
        return null;
      })()}
    </Box>
  );
}

// ─── Tweaks screen ────────────────────────────────────────

function TweaksScreen({
  mode,
}: {
  mode: Extract<Mode, { kind: 'tweaks' }>;
}) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        Tweaks {mode.busy ? '(applying…)' : ''}
      </Text>
      <Text dimColor>
        Quick config tricks for Claude Code (bypass onboarding, opus[1m], …)
      </Text>
      <Text> </Text>
      {mode.statuses.map((s, i) => {
        const isCursor = i === mode.cursor;
        const icon =
          s.status === 'applied'
            ? { glyph: '●', color: 'green' as const }
            : s.status === 'not-applied'
              ? { glyph: '○', color: undefined }
              : { glyph: '?', color: 'yellow' as const };
        return (
          <Box key={s.id} flexDirection="column">
            <Text>
              <Text color={isCursor ? 'cyan' : undefined}>
                {isCursor ? '› ' : '  '}
              </Text>
              <Text color={icon.color} dimColor={!icon.color}>
                {icon.glyph}{' '}
              </Text>
              <Text bold>{s.id}</Text>
              <Text dimColor>  {s.status}</Text>
            </Text>
            <Text>    {s.title}</Text>
            <Text dimColor>    {s.description}</Text>
            <Text> </Text>
          </Box>
        );
      })}
      <Text dimColor>↑↓ nav · enter/a apply selected · q/Esc back</Text>
    </Box>
  );
}

// ─── Clipboard helper ─────────────────────────────────────

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    const mod = await import('clipboardy');
    await mod.default.write(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Module-level message queued by TUI screens (e.g. alias installer) to be
 * printed AFTER Ink unmounts and the process exits. This is how we surface
 * post-action hints that need to live past the TUI session — child processes
 * can't modify their parent shell so we just instruct the user instead.
 */
let postExitMessage: string | null = null;

export function runTui(): void {
  const paths = resolvePaths();
  render(<App paths={paths} />);
  // Print queued message after Ink finishes unmounting. The 'exit' event
  // fires synchronously right before process exit.
  process.on('exit', () => {
    if (postExitMessage) {
      process.stdout.write('\n' + postExitMessage + '\n');
    }
  });
}
