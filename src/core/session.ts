import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { type HarnessId, type Conclusion, type SessionState } from './types.js';
import { KbStore } from './store.js';
import { readIfExists, ensureDir, writeAtomic, withLock } from './fsx.js';
import { isoNow } from './text.js';

export function newSessionId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export class SessionStore {
  constructor(private readonly store: KbStore) {}

  private file(id: string): string {
    return path.join(this.store.paths.sessionsDir, `${id}.json`);
  }

  create(harness: HarnessId, cwd: string, transcriptPath?: string): SessionState {
    ensureDir(this.store.paths.sessionsDir);
    const state: SessionState = {
      id: newSessionId(),
      harness,
      startedAt: isoNow(),
      cwd,
      transcriptPath,
      prompts: [],
      notes: [],
      touched: [],
      status: 'active',
    };
    writeAtomic(this.file(state.id), JSON.stringify(state, null, 2));
    writeAtomic(
      this.store.paths.activeSession,
      JSON.stringify({ id: state.id, harness, at: state.startedAt }, null, 2),
    );
    return state;
  }

  load(id: string): SessionState | null {
    const raw = readIfExists(this.file(id));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionState;
    } catch {
      return null;
    }
  }

  save(state: SessionState): void {
    ensureDir(this.store.paths.sessionsDir);
    writeAtomic(this.file(state.id), JSON.stringify(state, null, 2));
  }

  activeId(): string | null {
    const raw = readIfExists(this.store.paths.activeSession);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { id?: string };
      return parsed.id ?? null;
    } catch {
      return null;
    }
  }

  clearActive(): void {
    const raw = readIfExists(this.store.paths.activeSession);
    if (raw === null) return;
    writeAtomic(this.store.paths.activeSession, JSON.stringify({ id: null }, null, 2));
  }

  /**
   * Get the active session, creating one when a harness fires a prompt hook
   * without a prior SessionStart (Codex and dsh do this).
   */
  ensureActive(harness: HarnessId, cwd: string, transcriptPath?: string): SessionState {
    const id = this.activeId();
    if (id) {
      const existing = this.load(id);
      if (existing && existing.status === 'active') return existing;
    }
    return this.create(harness, cwd, transcriptPath);
  }

  /** Serialise session mutations across concurrent harness processes. */
  mutate<T>(fn: () => T): T {
    return withLock(this.store.paths.lockFile, fn);
  }

  /** Most recent ended session, used by `kb summary` without arguments. */
  latestEnded(): SessionState | null {
    const active = this.activeId();
    const dir = this.store.paths.sessionsDir;
    let best: SessionState | null = null;
    for (const raw of readJsonFiles(dir)) {
      const s = raw as SessionState;
      if (!s || s.status !== 'ended' || s.id === active) continue;
      if (!best || (s.endedAt ?? '') > (best.endedAt ?? '')) best = s;
    }
    return best;
  }

  /**
   * Best-effort session for an end-of-session hook that runs after the active
   * marker was already cleared (some harnesses fire Stop twice).
   */
  latestActiveOrRecent(): SessionState | null {
    const id = this.activeId();
    if (id) {
      const s = this.load(id);
      if (s) return s;
    }
    const dir = this.store.paths.sessionsDir;
    let best: SessionState | null = null;
    for (const raw of readJsonFiles(dir)) {
      const s = raw as SessionState;
      if (!s || typeof s.startedAt !== 'string') continue;
      if (!best || s.startedAt > best.startedAt) best = s;
    }
    return best;
  }

  addNote(state: SessionState, note: Conclusion): void {
    state.notes.push(note);
    this.save(state);
  }
}

function readJsonFiles(dir: string): unknown[] {
  const out: unknown[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {
    return out;
  }
  for (const n of names) {
    const raw = readIfExists(path.join(dir, n));
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      /* skip corrupt session file */
    }
  }
  return out;
}
