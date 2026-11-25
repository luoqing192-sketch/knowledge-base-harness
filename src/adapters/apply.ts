import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type InstallArtifact } from './types.js';
import { ensureDir, readIfExists, writeAtomic } from '../core/fsx.js';

export interface AppliedArtifact {
  path: string;
  action: 'created' | 'merged' | 'appended' | 'unchanged' | 'skipped';
  note?: string;
}

/**
 * Apply one install artifact.
 *
 * Merges are conservative: existing keys win over ours unless the key is inside
 * our marker block, so a user's hand-written hook list is never clobbered.
 */
export function applyArtifact(artifact: InstallArtifact): AppliedArtifact {
  if (artifact.strategy === 'command') return applyCommand(artifact);
  const existing = readIfExists(artifact.path);
  switch (artifact.strategy) {
    case 'write':
      return applyWrite(artifact, existing);
    case 'json-merge':
      return applyJsonMerge(artifact, existing);
    case 'text-append':
    case 'toml-append':
      return applyAppend(artifact, existing);
  }
}

/**
 * Run the harness's own CLI to register something.
 *
 * Some harnesses keep their config in a file they also rewrite themselves
 * (Claude Code's `~/.claude.json` is a multi-hundred-key state file). Asking the
 * CLI is both safer and the path the vendor documents. A failed command is
 * reported, never thrown: an install that half-succeeds should still leave the
 * rest of the artifacts in place.
 */
function applyCommand(artifact: InstallArtifact): AppliedArtifact {
  const argv = artifact.argv ?? [];
  if (argv.length === 0) return { path: artifact.path, action: 'skipped', note: 'no argv' };
  const res = spawnSync(argv[0]!, argv.slice(1), { encoding: 'utf8' });
  if (res.error) {
    return { path: artifact.path, action: 'skipped', note: `${argv[0]} not found: run this yourself` };
  }
  const detail = ((res.stdout ?? '') + (res.stderr ?? '')).trim().split('\n').slice(-1)[0];
  if (res.status !== 0) {
    return { path: artifact.path, action: 'skipped', note: detail || `exited ${res.status}` };
  }
  return { path: artifact.path, action: 'merged', note: detail || artifact.note };
}

function applyWrite(a: InstallArtifact, existing: string | null): AppliedArtifact {
  if (existing === a.content) return { path: a.path, action: 'unchanged' };
  writeAtomic(a.path, a.content);
  return { path: a.path, action: existing === null ? 'created' : 'merged', note: a.note };
}

function applyAppend(a: InstallArtifact, existing: string | null): AppliedArtifact {
  const marker = a.marker ?? 'knowlege-base-harness';
  const begin = `>>> ${marker} >>>`;
  const end = `<<< ${marker} <<<`;

  if (existing === null) {
    writeAtomic(a.path, a.content);
    return { path: a.path, action: 'created', note: a.note };
  }

  const beginIdx = existing.indexOf(begin);
  if (beginIdx >= 0) {
    const endIdx = existing.indexOf(end, beginIdx);
    if (endIdx >= 0) {
      const before = existing.slice(0, lineStart(existing, beginIdx));
      const after = existing.slice(lineEnd(existing, endIdx + end.length));
      const next = before + a.content + after;
      if (next === existing) return { path: a.path, action: 'unchanged' };
      writeAtomic(a.path, next);
      return { path: a.path, action: 'merged', note: 'marker block replaced' };
    }
  }

  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  writeAtomic(a.path, existing + sep + a.content);
  return { path: a.path, action: 'appended', note: a.note };
}

function lineStart(s: string, idx: number): number {
  const nl = s.lastIndexOf('\n', idx - 1);
  return nl < 0 ? 0 : nl + 1;
}

function lineEnd(s: string, idx: number): number {
  const nl = s.indexOf('\n', idx);
  return nl < 0 ? s.length : nl + 1;
}

function applyJsonMerge(a: InstallArtifact, existing: string | null): AppliedArtifact {
  let mine: Record<string, unknown>;
  try {
    mine = JSON.parse(a.content) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`kb: internal error, bad artifact JSON for ${a.path}: ${(err as Error).message}`);
  }

  if (existing === null) {
    writeAtomic(a.path, JSON.stringify(mine, null, 2) + '\n');
    return { path: a.path, action: 'created', note: a.note };
  }

  let current: Record<string, unknown>;
  try {
    current = JSON.parse(existing) as Record<string, unknown>;
  } catch {
    // Not JSON (or JSONC with comments). Refuse rather than destroy the file.
    return {
      path: a.path,
      action: 'unchanged',
      note: 'file is not strict JSON — merge skipped; add the snippet manually',
    };
  }

  let changed = false;

  // `hooks` is special: concatenate our entries, never drop the user's own.
  const mineHooks = mine['hooks'] as Record<string, unknown[]> | undefined;
  if (mineHooks) {
    const currentHooks = (current['hooks'] ?? {}) as Record<string, unknown[]>;
    for (const [event, entries] of Object.entries(mineHooks)) {
      const list = Array.isArray(currentHooks[event]) ? currentHooks[event] : [];
      const filtered = list.filter((entry) => !JSON.stringify(entry).includes('knowlege-base-harness'));
      const next = [...filtered, ...entries];
      if (JSON.stringify(next) !== JSON.stringify(list)) changed = true;
      currentHooks[event] = next;
    }
    current['hooks'] = currentHooks;
  }

  const mineMcp = mine['mcpServers'] as Record<string, unknown> | undefined;
  if (mineMcp) {
    const currentMcp = (current['mcpServers'] ?? {}) as Record<string, unknown>;
    for (const [name, spec] of Object.entries(mineMcp)) {
      if (JSON.stringify(currentMcp[name]) !== JSON.stringify(spec)) {
        currentMcp[name] = spec;
        changed = true;
      }
    }
    current['mcpServers'] = currentMcp;
  }

  for (const [k, v] of Object.entries(mine)) {
    if (k === 'hooks' || k === 'mcpServers') continue;
    if (k in current) continue;
    current[k] = v;
    changed = true;
  }

  if (!changed) return { path: a.path, action: 'unchanged' };
  ensureDir(path.dirname(a.path));
  writeAtomic(a.path, JSON.stringify(current, null, 2) + '\n');
  return { path: a.path, action: 'merged', note: a.note };
}

/** True when the file already carries our marker block. */
export function hasMarker(file: string, marker = 'knowlege-base-harness'): boolean {
  const raw = readIfExists(file);
  return raw !== null && raw.includes(marker);
}

export function removeArtifact(file: string, marker = 'knowlege-base-harness'): boolean {
  const raw = readIfExists(file);
  if (raw === null) return false;
  const begin = `>>> ${marker} >>>`;
  const end = `<<< ${marker} <<<`;
  const b = raw.indexOf(begin);
  if (b < 0) return false;
  const e = raw.indexOf(end, b);
  if (e < 0) return false;
  const next = (raw.slice(0, lineStart(raw, b)) + raw.slice(lineEnd(raw, e + end.length))).trimEnd() + '\n';
  if (next.trim() === '') fs.unlinkSync(file);
  else writeAtomic(file, next);
  return true;
}
