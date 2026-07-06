// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Thin shim over the VERBATIM web-chat parser (src/lib/history/*, copied from
// cicy-code app/src/components/chat/history/lib). User rule: the web chat has
// already stepped on every provider-format pitfall — copy it, never re-invent.
// Only stripHarnessNoise is mobile-specific (display layer shows ZERO system
// noise, vs web which folds it into SystemNoticeCard chips).
import {
  HARNESS_BLOCK_RE,
  splitLeadingHarnessBlocks,
} from './history/normalizeItem';

export {
  splitLeadingHarnessBlocks,
  parseCicyOutcome,
  parseEnvironmentContext,
  cicyCompactSummaryOf,
} from './history/normalizeItem';
export {
  buildTurnsFromRawItems,
  normalizeHistoryTurns,
  replyItemsToSteps,
  extractContentText,
} from './history/turns';

// Same harness tags as the web HARNESS_BLOCK_RE but matched ANYWHERE (global),
// so a system-reminder / task-notification sitting mid-message or trailing is
// also removed. Derived from the web regex source so new tags (e.g.
// fork-inherited-context) stay in sync automatically.
const TAGS = String(HARNESS_BLOCK_RE.source).match(/\(([a-z|-]+)\)/)?.[1] ?? 'system-reminder';
const HARNESS_BLOCK_GLOBAL_RE = new RegExp(`<(${TAGS})>[\\s\\S]*?</\\1>`, 'g');

// Thorough system-noise stripper for the DISPLAY layer: peel the leading
// harness wrappers + prefix patterns (AGENTS.md / environment_context / recap /
// continuation), then delete any remaining harness tag-blocks wherever they
// sit. Returns the real human text only ("" when pure system noise).
export function stripHarnessNoise(text: string): string {
  let s = splitLeadingHarnessBlocks(text).remaining;
  s = s.replace(HARNESS_BLOCK_GLOBAL_RE, '');
  return s.trim();
}
