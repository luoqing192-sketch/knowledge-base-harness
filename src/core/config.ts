import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readIfExists, ensureDir } from './fsx.js';

export type LayoutMode = 'auto' | 'single' | 'multi';

export interface KbConfig {
  /** Absolute path of the markdown wiki root. Only .md files live here. */
  kbRoot: string;
  /** Absolute path of the runtime data dir (sessions, index, quarantine). */
  dataDir: string;
  /** Hard cap in bytes for one page body. Exceeding it triggers compression. */
  maxPageBytes: number;
  /** Target size after compression. */
  targetPageBytes: number;
  /** Max bullets kept in a section before it is compressed. */
  maxBulletsPerSection: number;
  /** Max KB depth (folders below root). */
  maxDepth: number;
  /** Parent/child auto-linking. */
  backlinks: boolean;
  /** Which harnesses to install into. */
  harnesses: string[];
  layout: LayoutMode;
  /** Session distillation thresholds. */
  minPromptCharsForRecall: number;
  minConclusionConfidence: 'high' | 'medium' | 'low';
  /** Skip writing conclusions below this many characters. */
  minConclusionChars: number;

  /**
   * Two-tier memory. `memory/MEMORY.md` and `memory/USER.md` are injected into
   * every prompt, so they carry a hard character budget (count of body text).
   */
  memoryDir: string;
  memoryCharLimit: number;
  userCharLimit: number;
  /** Inject memory into every prompt hook. */
  injectMemory: boolean;
  /** Warn when a store is this full, so the agent prunes before it is blocked. */
  memoryPressureThreshold: number;
}

export const DEFAULT_CONFIG: Omit<KbConfig, 'kbRoot' | 'dataDir' | 'memoryDir'> = {
  maxPageBytes: 12_000,
  targetPageBytes: 8_000,
  maxBulletsPerSection: 40,
  maxDepth: 4,
  backlinks: true,
  harnesses: ['claude-code', 'codex', 'qoder', 'workbuddy', 'trae', 'dsh', 'generic'],
  layout: 'multi',
  minPromptCharsForRecall: 4,
  minConclusionConfidence: 'low',
  minConclusionChars: 8,
  memoryCharLimit: 4_000,
  userCharLimit: 2_000,
  injectMemory: true,
  memoryPressureThreshold: 0.85,
};

export const MEMORY_DIRNAME = 'memory';

export const CONFIG_FILE = 'kb.config.json';

/** Locate the project root: nearest ancestor with .git, else cwd. */
export function findProjectRoot(start: string): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

export function defaultPaths(projectRoot: string): { kbRoot: string; dataDir: string } {
  return {
    kbRoot: path.join(projectRoot, 'knowledge'),
    dataDir: path.join(projectRoot, '.kb'),
  };
}

export function loadConfig(cwd: string, overrides: Partial<KbConfig> = {}): KbConfig {
  const projectRoot = findProjectRoot(cwd);
  const base = defaultPaths(projectRoot);
  const candidates = [
    path.join(cwd, CONFIG_FILE),
    path.join(projectRoot, CONFIG_FILE),
    path.join(os.homedir(), '.knowledge-base-harness', CONFIG_FILE),
  ];
  let fileCfg: Partial<KbConfig> = {};
  for (const file of candidates) {
    const raw = readIfExists(file);
    if (raw) {
      try {
        fileCfg = JSON.parse(raw) as Partial<KbConfig>;
      } catch (err) {
        throw new Error(`kb: invalid JSON in ${file}: ${(err as Error).message}`);
      }
      break;
    }
  }

  const cfg: KbConfig = {
    ...DEFAULT_CONFIG,
    kbRoot: base.kbRoot,
    dataDir: base.dataDir,
    memoryDir: path.join(base.kbRoot, MEMORY_DIRNAME),
    ...fileCfg,
    ...overrides,
  };

  // Relative paths in the config file resolve against the config file location,
  // which for us is the project root.
  if (!path.isAbsolute(cfg.kbRoot)) cfg.kbRoot = path.resolve(projectRoot, cfg.kbRoot);
  if (!path.isAbsolute(cfg.dataDir)) cfg.dataDir = path.resolve(projectRoot, cfg.dataDir);
  if (!path.isAbsolute(cfg.memoryDir)) cfg.memoryDir = path.resolve(projectRoot, cfg.memoryDir);
  return cfg;
}

/** Absolute location of the always-injected memory folder. */
export function resolveMemoryDir(cfg: KbConfig): string {
  return cfg.memoryDir || path.join(cfg.kbRoot, MEMORY_DIRNAME);
}

/** Relative path of a memory page from a folder, e.g. to link it from index.md. */
export function memoryRelativePath(kbRelPath: string): string {
  const segments = kbRelPath.split('/').filter(Boolean).length;
  return '../'.repeat(Math.max(0, segments - 1)) + MEMORY_DIRNAME;
}

export function writeConfig(projectRoot: string, cfg: Partial<KbConfig>): string {
  const file = path.join(projectRoot, CONFIG_FILE);
  const rel: Record<string, unknown> = { ...cfg };
  if (typeof rel.kbRoot === 'string' && path.isAbsolute(rel.kbRoot)) {
    rel.kbRoot = path.relative(projectRoot, rel.kbRoot).split(path.sep).join('/');
  }
  if (typeof rel.dataDir === 'string' && path.isAbsolute(rel.dataDir)) {
    rel.dataDir = path.relative(projectRoot, rel.dataDir).split(path.sep).join('/');
  }
  if (typeof rel.memoryDir === 'string' && path.isAbsolute(rel.memoryDir)) {
    rel.memoryDir = path.relative(projectRoot, rel.memoryDir).split(path.sep).join('/');
  }
  ensureDir(projectRoot);
  fs.writeFileSync(file, JSON.stringify(rel, null, 2) + '\n', 'utf8');
  return file;
}

export const KB_ENTRY_FILES = ['index.md'] as const;

/** Runtime sub-paths inside dataDir. Nothing here may ever sit inside kbRoot. */
export function dataPaths(cfg: KbConfig) {
  const d = cfg.dataDir;
  return {
    indexFile: path.join(d, 'cache', 'index.json'),
    sessionsDir: path.join(d, 'sessions'),
    activeSession: path.join(d, 'sessions', '.active.json'),
    stateDir: path.join(d, 'state'),
    quarantineDir: path.join(d, 'quarantine'),
    logFile: path.join(d, 'state', 'kb.log.jsonl'),
    lockFile: path.join(d, 'state', 'kb.lock'),
  };
}
