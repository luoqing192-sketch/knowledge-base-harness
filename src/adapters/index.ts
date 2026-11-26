import { claudeCodeAdapter } from './claude-code.js';
import { codexAdapter } from './codex.js';
import { qoderAdapter } from './qoder.js';
import {
  dshAdapter,
  genericAdapter,
  traeAdapter,
  workbuddyAdapter,
} from './simple.js';
import { type HarnessAdapter } from './types.js';

export const ADAPTERS: HarnessAdapter[] = [
  claudeCodeAdapter,
  codexAdapter,
  qoderAdapter,
  workbuddyAdapter,
  traeAdapter,
  dshAdapter,
  genericAdapter,
];

export function getAdapter(id: string): HarnessAdapter {
  const found = ADAPTERS.find((a) => a.id === id);
  if (!found) {
    throw new Error(`kb: unknown harness "${id}". Known: ${ADAPTERS.map((a) => a.id).join(', ')}`);
  }
  return found;
}

export function tryGetAdapter(id: string): HarnessAdapter | null {
  return ADAPTERS.find((a) => a.id === id) ?? null;
}
