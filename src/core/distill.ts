import { type Conclusion, type Confidence } from './types.js';
import { collapseWhitespace, tokenize, truncate } from './text.js';

/**
 * Conclusion gating.
 *
 * The KB is a wiki of *settled* facts, so the rule is: nothing enters a page
 * unless the session produced an explicit, verifiable conclusion. This module
 * is deliberately conservative — when in doubt it returns nothing, because a
 * missing update is cheap and a wrong page poisons every future recall.
 */

export interface CandidateVerdict {
  accepted: boolean;
  confidence: Confidence;
  reason: string;
  signals: string[];
}

const HEDGE = [
  '可能', '也许', '大概', '或许', '感觉', '似乎', '好像', '不确定', '待定', '待确认',
  '尚未', '还没', '未验证', '猜测', '估计', '应该吧', '也许吧',
  'maybe', 'perhaps', 'probably', 'not sure', 'unsure', 'might', 'could be',
  'tbd', 'todo', 'hypothesis', 'guess', 'uncertain', 'likely',
];

const QUESTION_ONLY = /^[^。.!?！？]*[?？]\s*$/;

/**
 * Markers that a statement records a *result*: something was confirmed, fixed,
 * measured or diagnosed. These can lift a sentence to `high` on their own when
 * a number is present.
 */
const DECIDED = [
  '确认', '确认了', '已确认', '结论', '最终', '定下来', '决定了', '采用', '改成',
  '改为', '已经修复', '已修复', '修复了', '已解决', '解决了', '验证通过', '测试通过',
  '实测', '根因是', '原因是',
  'confirmed', 'decided', 'root cause', 'fixed', 'resolved', 'verified',
];

/**
 * Markers that only express a *rule*: "must / never / can only". They are real
 * conclusions but far more prone to being generic advice, so on their own they
 * cap out at `medium` and never reach `high`.
 */
const DECIDED_WEAK = [
  '必须', '不允许', '只能', '不能', '禁止', '注意', '需要注意',
  '就好了', '就可以了', '就行了', '搞定', '解决',
  'must', 'never', 'always',
];

/** Pure admonishment with no concrete subject: "别乱改", "注意一下安全". */
const VAGUE_ADVICE = /(别乱|不要乱|别动|小心点|注意一下|注意点|谨慎|多看文档|写规范点)/;

/** A revision marker anywhere in the sentence — this is a changed verdict. */
const REVISION = /(改为|改成|改用|换成|替换|不再|不是|instead|no longer|replaced)/;

const EVIDENCE = [
  /\b[0-9a-f]{7,40}\b/, // commit sha
  /\b(?:PR|MR|issue|ticket|JIRA|BUG)[-\s#:]?\d{2,}/i,
  /\b\d{4}-\d{2}-\d{2}\b/, // date
  /`[^`\n]{2,80}`/, // code / path / command
  /\b[\w-]+\.(?:ts|js|java|py|md|json|yml|yaml|sql|proto|scala)\b/,
  /\d+\s*(?:个)?(?:测试|用例|test|tests)\b/i,
];

const REJECTED_OPENERS = [
  '我再看看', '让我想想', '可以试试', '要不要', '是不是', '能不能', '如何', '怎么',
  '我觉得', '我认为', '个人感觉', '我猜',
  'why', 'how', 'what if', 'should we', 'can we', 'i think',
];

/**
 * Tentative phrasing anywhere in the sentence — an experiment or a pending
 * check, not a decision. `(?:再|待|需要|还要|要|去|先)?确认一下|确认下` covers
 * "我再确认下" / "待确认", which contain 确认 but mean the opposite.
 */
const TENTATIVE =
  /(试试|看一看|看看效果|试一下|待定|再说吧|先这样|试试看|不然后面再看|(?:再|待|需要|还要|要|去|先)?确认一下|(?:再|待|需要|还要|要|去|先)确认下|确认一下|确认下)/;

export function judgeConclusion(raw: string, opts: { explicit?: boolean } = {}): CandidateVerdict {
  const text = collapseWhitespace(raw);
  const signals: string[] = [];

  if (text.length < 8) {
    return { accepted: false, confidence: 'low', reason: 'too short', signals };
  }

  const lower = text.toLowerCase();

  if (QUESTION_ONLY.test(text) || /[?？]$/.test(text)) {
    return { accepted: false, confidence: 'low', reason: 'ends as a question', signals };
  }

  for (const opener of REJECTED_OPENERS) {
    if (lower.startsWith(opener)) {
      return { accepted: false, confidence: 'low', reason: `open-ended: ${opener}`, signals };
    }
  }

  const tentative = TENTATIVE.exec(text);
  if (tentative) {
    return {
      accepted: false,
      confidence: 'low',
      reason: `tentative: ${tentative[1]}`,
      signals: [...signals, `tentative:${tentative[1]}`],
    };
  }

  // Bare admonishment ("别乱改", "注意一下安全") carries no fact. Only reject it
  // when nothing else in the sentence anchors it to a subject.
  const vague = VAGUE_ADVICE.exec(text);
  if (vague && !DECIDED.some((d) => lower.includes(d))) {
    return {
      accepted: false,
      confidence: 'low',
      reason: `vague advice: ${vague[1]}`,
      signals: [...signals, `vague:${vague[1]}`],
    };
  }

  const hedge = HEDGE.find((h) => lower.includes(h));
  if (hedge) signals.push(`hedge:${hedge}`);

  const decided = DECIDED.filter((d) => lower.includes(d));
  const weakDecided = DECIDED_WEAK.filter((d) => lower.includes(d));
  if (decided.length > 0) signals.push(`decided:${decided.slice(0, 2).join(',')}`);
  if (weakDecided.length > 0) signals.push(`rule:${weakDecided.slice(0, 2).join(',')}`);

  const evidence = EVIDENCE.some((re) => re.test(text));
  if (evidence) signals.push('evidence');

  const hasNumbers = /\d/.test(text);
  const hasRevision = REVISION.test(text);
  const tokenCount = tokenize(text).length;

  if (hedge && !evidence && decided.length === 0 && weakDecided.length === 0) {
    return {
      accepted: false,
      confidence: 'low',
      reason: `hedged without evidence (${hedge})`,
      signals,
    };
  }

  if (hedge && !evidence) {
    return {
      accepted: false,
      confidence: 'low',
      reason: 'hedged: an unconfirmed statement cannot enter the wiki',
      signals,
    };
  }

  // An explicit `kb:` / `结论:` marker is the user declaring a conclusion, so the
  // bar drops to "concrete enough to be useful" rather than "proof attached".
  if (opts.explicit) {
    const confidence: Confidence = evidence ? 'high' : tokenCount >= 8 ? 'medium' : 'low';
    return {
      accepted: true,
      confidence,
      reason: 'explicitly marked as a conclusion',
      signals: [...signals, 'explicit'],
    };
  }

  // `high` requires a recorded outcome: confirmation, fix, measurement, or a
  // revision of an existing decision — plus something concrete (a number, a
  // code reference, or enough substance). A bare "must" stays at `medium`,
  // because that is where generic advice lives.
  const concrete = hasNumbers || tokenCount >= 12;
  if ((decided.length > 0 && concrete) || (hasRevision && concrete)) {
    return { accepted: true, confidence: 'high', reason: 'explicit decision with support', signals };
  }
  if (decided.length > 0 || weakDecided.length > 0 || hasRevision) {
    return { accepted: true, confidence: 'medium', reason: 'explicit decision or rule', signals };
  }
  if (evidence && tokenCount >= 8) {
    return { accepted: true, confidence: 'medium', reason: 'concrete evidence', signals };
  }
  if (tokenCount >= 16) {
    return { accepted: true, confidence: 'low', reason: 'long declarative statement', signals };
  }
  return { accepted: false, confidence: 'low', reason: 'no decision marker', signals };
}

export function isAccepted(v: CandidateVerdict, min: Confidence): boolean {
  if (!v.accepted) return false;
  const rank: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
  return rank[v.confidence] >= rank[min];
}

// ---------------------------------------------------------------- extraction

const NOTE_PREFIX = /^\s*(?:kb[:\s]|知识库[：:]\s*|结论[：:]\s*|conclusion[：:]\s*)/i;

export interface ExtractedConclusion {
  text: string;
  source: Conclusion['source'];
  confidence: Confidence;
  evidence?: string;
}

/** Pull explicit `kb:` / `结论:` notes out of a prompt or transcript chunk. */
export function extractExplicitNotes(text: string): ExtractedConclusion[] {
  const out: ExtractedConclusion[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const m = NOTE_PREFIX.exec(line);
    if (!m) continue;
    const body = line.slice(m[0].length).trim();
    if (body === '') continue;
    const verdict = judgeConclusion(body, { explicit: true });
    if (!verdict.accepted) continue;
    out.push({
      text: stripTrailingPunctuation(body),
      source: 'note',
      confidence: verdict.confidence,
      evidence: verdict.signals.includes('evidence') ? 'inline' : undefined,
    });
  }
  return out;
}

const SENTENCE_SPLIT = /(?<=[。！？!?;；])\s*|\n+/;

/** Heuristic distillation of a transcript chunk into candidate conclusions. */
export function distillTranscript(
  messages: Array<{ role: 'user' | 'assistant' | 'system'; text: string }>,
): ExtractedConclusion[] {
  const out: ExtractedConclusion[] = [];
  const seen = new Set<string>();

  const push = (text: string, source: Conclusion['source'], confidence: Confidence, evidence?: string) => {
    const clean = stripTrailingPunctuation(collapseWhitespace(text));
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ text: truncate(clean, 240), source, confidence, evidence });
  };

  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const notes = extractExplicitNotes(msg.text);
    for (const n of notes) push(n.text, 'note', n.confidence, n.evidence);

    const sentences = msg.text.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
    for (const sentence of sentences) {
      if (sentence.length < 12 || sentence.length > 400) continue;
      if (/^(所以|那么|但是|如果|假设|比如)/.test(sentence) && !sentence.includes('结论')) {
        continue;
      }
      const verdict = judgeConclusion(sentence);
      if (verdict.confidence === 'low') continue;
      if (msg.role === 'user' && verdict.confidence !== 'high') continue;
      push(sentence, 'transcript', verdict.confidence, verdict.signals.includes('evidence') ? 'inline' : undefined);
    }
  }
  return out;
}

/** User confirmation phrases that settle the immediately preceding statement. */
export function isConfirmation(text: string): boolean {
  const t = collapseWhitespace(text).toLowerCase();
  return /^(对|是|是的|正确|没错|确认|同意|可以|好的|ok|okay|yes|yep|right|correct|confirmed)([。.!！\s]|$)/.test(t) ||
    /^(就这样|按这个来|照这个做|用这个方案)/.test(t);
}

/** Reject assistant-only, tool-noise-shaped lines from becoming conclusions. */
export function isNoise(text: string): boolean {
  const t = collapseWhitespace(text);
  if (t === '') return true;
  if (t.length < 8) return true;
  if (/^\$ /.test(t)) return true;
  if (/^\[?[\d:.]+\]?\s*(?:ERROR|WARN|INFO|DEBUG)\b/.test(t)) return true;
  if (/^(stack trace|at [\w$.]+\([^)]*\))/.test(t)) return true;
  if (/^[-=]{3,}$/.test(t)) return true;
  if ((t.match(/[{}<>]/g)?.length ?? 0) > t.length * 0.15) return true;
  return false;
}

export function stripTrailingPunctuation(s: string): string {
  return s.replace(/[\s;；]+$/, '').replace(/[。\.]$/, '').trim();
}
