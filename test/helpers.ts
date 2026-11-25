import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KbEngine } from '../src/core/engine.js';
import { DEFAULT_CONFIG, type KbConfig } from '../src/core/config.js';

export interface Sandbox {
  root: string;
  kbRoot: string;
  dataDir: string;
  engine: KbEngine;
  cleanup(): void;
}

/** Create a throwaway project with its own KB + data dirs. */
export function sandbox(overrides: Partial<KbConfig> = {}): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'knowlege-base-harness-test-'));
  const kbRoot = path.join(root, 'knowledge');
  const dataDir = path.join(root, '.kb');
  const cfg: KbConfig = {
    ...DEFAULT_CONFIG,
    kbRoot,
    dataDir,
    memoryDir: path.join(kbRoot, 'memory'),
    ...overrides,
  };
  const engine = new KbEngine(cfg);
  engine.init();
  return {
    root,
    kbRoot,
    dataDir,
    engine,
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function readPage(sb: Sandbox, rel: string): string {
  return fs.readFileSync(path.join(sb.kbRoot, rel), 'utf8');
}

export function listMarkdown(sb: Sandbox, dir = ''): string[] {
  const out: string[] = [];
  const visit = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) visit(abs);
      else out.push(path.relative(sb.kbRoot, abs).split(path.sep).join('/'));
    }
  };
  const start = dir === '' ? sb.kbRoot : path.join(sb.kbRoot, dir);
  if (fs.existsSync(start)) visit(start);
  return out.sort();
}

/** Files under the always-injected memory folder. */
export function memoryFiles(sb: Sandbox): string[] {
  return listMarkdown(sb).filter((f) => f.startsWith('memory/'));
}

/** Every markdown file that is NOT part of the memory folder. */
export function topicFiles(sb: Sandbox, dir = ''): string[] {
  return listMarkdown(sb, dir).filter((f) => !f.startsWith('memory/'));
}

/** Live topic pages: no memory, no archive. This is what a reader sees. */
export function liveFiles(sb: Sandbox): string[] {
  return listMarkdown(sb).filter((f) => !f.startsWith('memory/') && !f.startsWith('_archive/'));
}
