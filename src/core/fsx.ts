import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write via temp file + rename so a crashed run never leaves a half page.
 *
 * `tempDir` exists because the knowledge folder must never contain stray files:
 * pages are staged in the runtime data dir and then renamed into place.
 */
export function writeAtomic(file: string, content: string, tempDir?: string): void {
  ensureDir(path.dirname(file));
  const tmp = tempDir
    ? path.join(tempDir, `${process.pid}-${Date.now()}-${path.basename(file)}.tmp`)
    : `${file}.${process.pid}.${Date.now()}.tmp`;
  if (tempDir) ensureDir(tempDir);
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

export function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export function walkFiles(root: string, opts: { skipHidden?: boolean } = {}): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of listDir(dir)) {
      if (opts.skipHidden !== false && entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  if (statOrNull(root)?.isDirectory()) visit(root);
  return out.sort();
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function sizeOf(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function sleepSync(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/**
 * Small cross-process advisory lock. Sessions from several harnesses can be
 * open at once and must not interleave writes into the same markdown page.
 */
export function withLock<T>(lockFile: string, fn: () => T, timeoutMs = 10_000): T {
  ensureDir(path.dirname(lockFile));
  const deadline = Date.now() + timeoutMs;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockFile, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const st = statOrNull(lockFile);
      // Stale lock left behind by a killed process.
      if (st && Date.now() - st.mtimeMs > 30_000) {
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* ignore */
        }
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`kb: timed out waiting for lock ${lockFile}`);
      }
      sleepSync(25);
    }
  }
  try {
    fs.writeSync(fd, String(process.pid));
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* ignore */
    }
  }
}

export function moveFile(from: string, to: string): void {
  ensureDir(path.dirname(to));
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
      return;
    }
    throw err;
  }
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
