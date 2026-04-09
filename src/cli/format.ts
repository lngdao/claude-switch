import kleur from 'kleur';
import type { ProfileSummary } from '../core/profile.js';
import { schemeBadge, type AuthScheme } from '../core/scheme.js';
import type { CheckResult, Severity } from '../core/doctor.js';

export function isTty(): boolean {
  return process.stdout.isTTY === true;
}

export function disableColor(): void {
  kleur.enabled = false;
}

export function schemeColor(scheme: AuthScheme): string {
  const label = schemeBadge(scheme);
  switch (scheme) {
    case 'oauth':
      return kleur.cyan(label);
    case 'api-key':
      return kleur.magenta(label);
    case 'auth-token':
      return kleur.yellow(label);
    case 'proxy':
      return kleur.blue(label);
    case 'custom-base':
      return kleur.gray(label);
    case 'mixed':
      return kleur.red().bold(label);
    case 'empty':
      return kleur.gray(label);
    case 'unknown':
      return kleur.gray(label);
  }
}

export function formatList(profiles: ProfileSummary[]): string {
  if (profiles.length === 0) {
    return kleur.dim('  No profiles found.');
  }
  const rows = profiles.map((p) => {
    const dot = p.active ? kleur.green('●') : kleur.dim('○');
    const name = p.active ? kleur.green().bold(p.name) : p.name;
    const scheme = schemeColor(p.scheme);
    const count = kleur.dim(`(${p.envKeys.length} env)`);
    let probe = '';
    if (p.lastProbe) {
      const icon =
        p.lastProbe.severity === 'ok'
          ? kleur.green('✓')
          : p.lastProbe.severity === 'warn'
            ? kleur.yellow('⚠')
            : kleur.red('✗');
      probe = `  ${icon} ${kleur.dim(timeAgo(p.lastProbe.at))}`;
    } else {
      probe = `  ${kleur.dim('· never probed')}`;
    }
    return `  ${dot} ${pad(name, 24)} ${pad(scheme, 18)} ${count}${probe}`;
  });
  return rows.join('\n');
}

function visibleLength(s: string): number {
  // strip ANSI escapes
  return s.replace(/\u001b\[[0-9;]*m/g, '').length;
}

function pad(s: string, n: number): string {
  const len = visibleLength(s);
  if (len >= n) return s;
  return s + ' '.repeat(n - len);
}

export function severityIcon(s: Severity): string {
  switch (s) {
    case 'ok':
      return kleur.green('✓');
    case 'warn':
      return kleur.yellow('⚠');
    case 'error':
      return kleur.red('✗');
  }
}

export function formatDoctor(results: CheckResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`  ${severityIcon(r.severity)} ${r.title}`);
    if (r.detail) lines.push(kleur.dim(`      ${r.detail}`));
    if (r.fix) lines.push(kleur.dim(`      → ${r.fix}`));
  }
  return lines.join('\n');
}

export function summary(ok: number, warn: number, err: number): string {
  const parts = [
    kleur.green(`${ok} ok`),
    kleur.yellow(`${warn} warn`),
    kleur.red(`${err} error`),
  ];
  return parts.join('  ');
}

/**
 * Compact relative-time formatter for probe timestamps.
 * "5s ago", "10m ago", "2h ago", "3d ago", "2w ago".
 */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '?';
  const ms = now.getTime() - then;
  if (ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  const w = Math.floor(d / 7);
  return `${w}w ago`;
}

export const c = kleur;
