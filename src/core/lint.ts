import path from 'node:path';
import { type LintIssue, type ParsedDoc } from './types.js';
import { KbStore } from './store.js';
import { SECTION_CONCLUSIONS, SECTION_RELATED, bulletText, hasSection } from './markdown.js';
import { isNoise } from './distill.js';

/**
 * Structural checks for the wiki.
 *
 * Errors block a write path (the hook server refuses to commit a session's
 * conclusions into a KB that fails these); warnings are advisory and surface in
 * `kb doctor`.
 */
export function lintKb(store: KbStore): LintIssue[] {
  const issues: LintIssue[] = [];
  const { files, illegal } = store.scan();

  for (const rel of illegal) {
    issues.push({
      level: 'error',
      code: 'non-markdown-file',
      path: rel,
      message: 'The knowledge folder may only contain .md files. Run `kb doctor --fix` to quarantine it.',
    });
  }

  if (files.length === 0) {
    issues.push({
      level: 'warning',
      code: 'empty-kb',
      path: '.',
      message: 'No markdown pages found. Run `kb init` to create the root index.',
    });
  }

  const parentsSeen = new Set<string>();

  for (const rel of files) {
    const raw = store.read(rel);
    if (!raw) continue;
    const doc: ParsedDoc = raw;

    // Depth
    const depth = store.depthOf(rel);
    if (depth > store.cfg.maxDepth) {
      issues.push({
        level: 'error',
        code: 'too-deep',
        path: rel,
        message: `Depth ${depth} exceeds maxDepth=${store.cfg.maxDepth}. Flatten the tree or raise the limit.`,
      });
    }

    // Size
    const bytes = store.bytesOf(rel);
    if (bytes > store.cfg.maxPageBytes) {
      issues.push({
        level: 'error',
        code: 'page-too-large',
        path: rel,
        message: `Page is ${bytes} bytes, above maxPageBytes=${store.cfg.maxPageBytes}. Run \`kb compress ${rel}\`.`,
      });
    } else if (bytes > store.cfg.targetPageBytes) {
      issues.push({
        level: 'warning',
        code: 'page-near-limit',
        path: rel,
        message: `Page is ${bytes} bytes, above targetPageBytes=${store.cfg.targetPageBytes}.`,
      });
    }

    // Front matter integrity
    const fm = doc.frontmatter;
    if (!fm.title || fm.title === '') {
      issues.push({ level: 'error', code: 'missing-title', path: rel, message: 'Missing title in front matter.' });
    }
    if (!fm.summary || fm.summary === '') {
      issues.push({ level: 'warning', code: 'missing-summary', path: rel, message: 'Missing summary; recall quality drops.' });
    }
    if (fm.level !== depth) {
      issues.push({
        level: 'warning',
        code: 'level-mismatch',
        path: rel,
        message: `front matter level=${fm.level} but the path is at depth ${depth}.`,
      });
    }
    if (!fm.tags || fm.tags.length === 0) {
      issues.push({ level: 'warning', code: 'no-tags', path: rel, message: 'No tags: recall will rely on body text only.' });
    }

    // Parent index presence
    const dir = path.posix.dirname(rel);
    if (dir !== '.') {
      const parentIndex = `${dir}/index.md`;
      if (!store.exists(parentIndex)) {
        issues.push({
          level: 'error',
          code: 'missing-parent-index',
          path: rel,
          message: `Parent folder has no ${parentIndex}; the page is unreachable from the root.`,
        });
      }
      parentsSeen.add(dir);
    }

    // Leaf pages must carry conclusions — except memory pages (raw always-injected
    // facts) and reference pages (long-form evidence for another page).
    const isIndex = path.posix.basename(rel) === 'index.md';
    const memoryPrefix = store.memoryRelDir();
    const isMemory =
      memoryPrefix !== '' && (rel === memoryPrefix || rel.startsWith(memoryPrefix + '/'));
    const isReference = rel.startsWith('references/');
    if (!isIndex && !isMemory && !isReference && !hasSection(doc, SECTION_CONCLUSIONS)) {
      issues.push({
        level: 'warning',
        code: 'no-conclusions',
        path: rel,
        message: 'Leaf page has no `## 结论` section.',
      });
    }

    // A reference page must point back at its source, or it becomes unreachable
    // evidence nobody will ever read. The folder index is exempt.
    if (isReference && !isIndex && !doc.frontmatter.derivedFrom) {
      issues.push({
        level: 'warning',
        code: 'reference-without-source',
        path: rel,
        message: 'Reference page has no `derivedFrom` front matter field.',
      });
    }

    // Noise in conclusions.
    const con = doc.sections.find((s) => s.heading === SECTION_CONCLUSIONS);
    if (con) {
      for (const line of con.lines) {
        if (!line.trim().startsWith('-')) continue;
        const body = bulletText(line);
        if (isNoise(body) && body.length > 0) {
          issues.push({
            level: 'warning',
            code: 'noisy-bullet',
            path: rel,
            message: `Conclusion looks like log/tool noise: "${body.slice(0, 60)}"`,
          });
        }
      }
    }

    // Related links must resolve.
    const related = doc.sections.find((s) => s.heading === SECTION_RELATED);
    if (related) {
      for (const line of related.lines) {
        const linkRe = /\[[^\]]*\]\(([^)]+)\)/g;
        let m: RegExpExecArray | null;
        while ((m = linkRe.exec(line)) !== null) {
          const target = m[1]!;
          if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue;
          const resolved = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, decodeURIComponent(target)));
          if (!store.exists(resolved)) {
            issues.push({
              level: 'warning',
              code: 'broken-link',
              path: rel,
              message: `Related link points at a missing page: ${target}`,
            });
          }
        }
      }
    }
  }

  // Folders that exist but hold no index.
  const dirs = new Set<string>();
  for (const rel of files) {
    const segs = rel.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  for (const d of dirs) {
    if (!store.exists(`${d}/index.md`)) {
      issues.push({
        level: 'error',
        code: 'folder-without-index',
        path: d,
        message: 'Folder has files but no index.md linking them.',
      });
    }
  }

  return issues;
}

export function summariseIssues(issues: LintIssue[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const i of issues) {
    if (i.level === 'error') errors++;
    else warnings++;
  }
  return { errors, warnings };
}
