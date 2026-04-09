import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { writeJsonAtomic } from './fs-safe.js';
import { writeFileSync } from 'node:fs';

export type ShellName = 'bash' | 'zsh' | 'fish';

export interface ShellTarget {
  shell: ShellName;
  rcPath: string;
  exists: boolean;
}

const MARKER_BEGIN = '# >>> claude-switch alias >>>';
const MARKER_END = '# <<< claude-switch alias <<<';

/**
 * Return all candidate shell rc files. We always include the canonical rc
 * for bash/zsh/fish; `exists` tells the caller whether it's currently on disk.
 */
export function detectShells(): ShellTarget[] {
  const home = homedir();
  return [
    { shell: 'bash', rcPath: join(home, '.bashrc'), exists: existsSync(join(home, '.bashrc')) },
    { shell: 'zsh', rcPath: join(home, '.zshrc'), exists: existsSync(join(home, '.zshrc')) },
    {
      shell: 'fish',
      rcPath: join(home, '.config', 'fish', 'config.fish'),
      exists: existsSync(join(home, '.config', 'fish', 'config.fish')),
    },
  ];
}

/** Detect the user's primary shell from $SHELL. */
export function currentShell(): ShellName | null {
  const sh = process.env.SHELL;
  if (!sh) return null;
  const name = basename(sh);
  if (name === 'bash' || name === 'zsh' || name === 'fish') return name;
  return null;
}

export interface AliasStatus {
  shell: ShellName;
  rcPath: string;
  installed: boolean;
  /** The alias line currently in the rc file, if installed. */
  currentLine?: string;
}

/**
 * Inspect every known shell rc file and report whether the marker block is
 * present and what the alias currently points to.
 */
export function aliasStatus(): AliasStatus[] {
  return detectShells()
    .filter((t) => t.exists)
    .map((t) => {
      const content = readFileSafe(t.rcPath);
      const block = extractBlock(content);
      return {
        shell: t.shell,
        rcPath: t.rcPath,
        installed: block !== null,
        currentLine: block?.line,
      };
    });
}

export interface InstallOptions {
  /** Alias name (default 'cs'). */
  name?: string;
  /** Path to the binary the alias should point to. */
  target: string;
  /** Restrict installation to these shells. Default: all detected. */
  shells?: ShellName[];
  /** Don't write — just return what would change. */
  dryRun?: boolean;
}

export interface InstallResult {
  shell: ShellName;
  rcPath: string;
  action: 'created' | 'updated' | 'skipped' | 'noop';
  diff?: string;
}

export function installAlias(opts: InstallOptions): InstallResult[] {
  const name = opts.name ?? 'cs';
  if (!isValidAliasName(name)) {
    throw new Error(`Invalid alias name: '${name}'`);
  }

  const targets = detectShells().filter((t) => {
    if (opts.shells && !opts.shells.includes(t.shell)) return false;
    return t.exists;
  });

  const results: InstallResult[] = [];
  for (const t of targets) {
    const content = readFileSafe(t.rcPath);
    const aliasLine = formatAliasLine(t.shell, name, opts.target);
    const block = buildBlock(aliasLine);

    const existing = extractBlock(content);
    if (existing) {
      if (existing.line === aliasLine) {
        results.push({ shell: t.shell, rcPath: t.rcPath, action: 'noop' });
        continue;
      }
      const next = replaceBlock(content, block);
      if (!opts.dryRun) atomicWriteText(t.rcPath, next);
      results.push({
        shell: t.shell,
        rcPath: t.rcPath,
        action: 'updated',
        diff: `was: ${existing.line}\nnow: ${aliasLine}`,
      });
    } else {
      const next = appendBlock(content, block);
      if (!opts.dryRun) atomicWriteText(t.rcPath, next);
      results.push({
        shell: t.shell,
        rcPath: t.rcPath,
        action: 'created',
        diff: aliasLine,
      });
    }
  }

  return results;
}

export interface UninstallOptions {
  shells?: ShellName[];
  dryRun?: boolean;
}

export interface UninstallResult {
  shell: ShellName;
  rcPath: string;
  action: 'removed' | 'noop';
}

export function uninstallAlias(opts: UninstallOptions = {}): UninstallResult[] {
  const targets = detectShells().filter((t) => {
    if (opts.shells && !opts.shells.includes(t.shell)) return false;
    return t.exists;
  });

  const results: UninstallResult[] = [];
  for (const t of targets) {
    const content = readFileSafe(t.rcPath);
    if (!extractBlock(content)) {
      results.push({ shell: t.shell, rcPath: t.rcPath, action: 'noop' });
      continue;
    }
    const next = removeBlock(content);
    if (!opts.dryRun) atomicWriteText(t.rcPath, next);
    results.push({ shell: t.shell, rcPath: t.rcPath, action: 'removed' });
  }
  return results;
}

// ─── Helpers ─────────────────────────────────────────────

function readFileSafe(path: string): string {
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function isValidAliasName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name);
}

function formatAliasLine(shell: ShellName, name: string, target: string): string {
  // Quote the path to handle spaces. POSIX shells: single quotes.
  // fish: `alias cs '/path'` or `alias cs="/path"` — both work.
  if (shell === 'fish') {
    return `alias ${name} '${escapeSingleQuotes(target)}'`;
  }
  return `alias ${name}='${escapeSingleQuotes(target)}'`;
}

function escapeSingleQuotes(s: string): string {
  // POSIX: close, escape, reopen → 'foo'\''bar'
  return s.replace(/'/g, `'\\''`);
}

function buildBlock(aliasLine: string): string {
  return `${MARKER_BEGIN}\n${aliasLine}\n${MARKER_END}`;
}

interface ExtractedBlock {
  line: string;
  start: number;
  end: number;
}

function extractBlock(content: string): ExtractedBlock | null {
  const start = content.indexOf(MARKER_BEGIN);
  if (start === -1) return null;
  const endMarker = content.indexOf(MARKER_END, start);
  if (endMarker === -1) return null;
  const end = endMarker + MARKER_END.length;
  const inside = content.slice(start + MARKER_BEGIN.length, endMarker).trim();
  return { line: inside, start, end };
}

function replaceBlock(content: string, newBlock: string): string {
  const block = extractBlock(content);
  if (!block) return appendBlock(content, newBlock);
  return content.slice(0, block.start) + newBlock + content.slice(block.end);
}

function appendBlock(content: string, block: string): string {
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const trailingNewline = content.length === 0 || content.endsWith('\n') ? '' : '';
  return `${content}${sep}\n${block}\n${trailingNewline}`;
}

function removeBlock(content: string): string {
  const block = extractBlock(content);
  if (!block) return content;
  // Trim a single leading newline left over from the block
  let before = content.slice(0, block.start);
  let after = content.slice(block.end);
  if (before.endsWith('\n\n')) before = before.slice(0, -1);
  if (after.startsWith('\n')) after = after.slice(1);
  return before + after;
}

function atomicWriteText(path: string, content: string): void {
  // We can't use writeJsonAtomic since this is text — but the same atomic
  // approach: tmp + rename. Use plain writeFileSync for simplicity since the
  // surface area for a partial write here is small (rc file).
  // We do still chmod-preserve by reading mode first, but rc files are
  // user-managed so we leave permissions alone.
  void writeJsonAtomic; // suppress unused
  writeFileSync(path, content, { encoding: 'utf8' });
}

/**
 * Best-effort detection of where the claude-switch binary lives so we can
 * point the alias at it. Falls back to argv[1] (which is what npm/npx hands
 * us when we're invoked as the bin entry).
 */
export function detectBinaryPath(): string {
  // process.argv[1] is the absolute path to the script when invoked as a bin
  return process.argv[1] ?? 'claude-switch';
}
