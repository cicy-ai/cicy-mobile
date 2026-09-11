// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Pure bookkeeping for reply notifications: which of the prompts we sent to an
// agent are still being answered. Several prompts to the SAME agent may be in
// flight (one running, the rest queued by cicy-code), and each one gets its own
// notification, so each is matched to its own history prompt id:
//
//   history-ids.prompts  = the agent's recent user prompts {id, ts, content}
//   history-ids.id       = maxID, the id of the latest question (q_last)
//   current-reply        = the answer to q_last (history_id == maxID + 1)
//
// A tracked prompt is "claimed" once its text shows up in history-ids.prompts
// (it left the queue and became a turn). It is finished when either the
// current reply for it completes, or a LATER question has already started
// (the agent moved on, so ours was answered).
export type TrackedPrompt = {
  /** notification identifier (unique per prompt) */
  id: string;
  prompt: string;
  startedAt: number;
  /** history id of the user turn, once matched */
  promptId?: number;
};

export type HistoryIdsLike = { id?: number; prompts?: { id: number; ts?: string; content?: string }[] } | null | undefined;
export type CurrentReplyLike =
  | { history_id?: number; complete?: boolean; status?: string; question?: string; answer?: string }
  | null
  | undefined;

export type Settled = { id: string; state: 'done' | 'failed'; answer: string };

const TERMINAL = new Set(['completed', 'done', 'idle', 'failed', 'error', 'cancelled', 'canceled', 'blocked', 'timeout']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled', 'blocked', 'timeout']);
// A queued prompt may sit behind a long reply; only match history prompts that
// are not older than this before our send (clock skew + queue is generous).
const MATCH_WINDOW_MS = 5 * 60 * 1000;

export function firstLine(s: string, max = 80): string {
  const line = String(s || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function norm(s: string): string {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Does the committed prompt text correspond to what we sent? The node may
 *  wrap the text (attachment refs, trimmed whitespace), so accept prefix
 *  matches either way once they share a meaningful head. */
export function promptMatches(sent: string, committed: string): boolean {
  const a = norm(sent);
  const b = norm(committed);
  if (!a || !b) return false;
  if (a === b) return true;
  const head = Math.min(a.length, b.length, 120);
  if (head < 6) return false;
  return a.slice(0, head) === b.slice(0, head);
}

/**
 * One poll step. Mutates `pending` (assigns promptId, removes finished
 * entries) and returns the entries that reached a terminal state.
 */
export function settle(pending: TrackedPrompt[], ids: HistoryIdsLike, reply: CurrentReplyLike): Settled[] {
  const out: Settled[] = [];
  const prompts = Array.isArray(ids?.prompts) ? ids!.prompts! : [];
  const maxId = Number(ids?.id ?? 0) || 0;

  // 1. Claim history prompt ids, oldest tracked prompt first, never reusing an
  //    id and never going backwards (prompts are answered in send order).
  const claimed = new Set<number>(pending.map((p) => p.promptId).filter((x): x is number => typeof x === 'number'));
  let floor = 0;
  for (const p of pending) {
    if (typeof p.promptId === 'number') {
      floor = Math.max(floor, p.promptId);
      continue;
    }
    const hit = prompts.find((h) => {
      if (claimed.has(h.id) || h.id <= floor) return false;
      const ts = h.ts ? Date.parse(h.ts) : NaN;
      if (Number.isFinite(ts) && ts < p.startedAt - MATCH_WINDOW_MS) return false;
      return promptMatches(p.prompt, String(h.content || ''));
    });
    if (hit) {
      p.promptId = hit.id;
      claimed.add(hit.id);
      floor = hit.id;
    }
  }
  // Fallback for nodes that don't list prompts: the in-flight question itself.
  if (!prompts.length && reply?.question && maxId > 0 && !claimed.has(maxId)) {
    const p = pending.find((x) => typeof x.promptId !== 'number' && promptMatches(x.prompt, String(reply.question)));
    if (p) {
      p.promptId = maxId;
      claimed.add(maxId);
    }
  }

  // 2. Finish what is answered.
  const status = String(reply?.status || '').toLowerCase();
  const replyDone = reply?.complete === true || TERMINAL.has(status);
  const replyFailed = FAILED.has(status);
  const replyFor = Number(reply?.history_id ?? 0) - 1; // the question the reply answers
  for (const p of [...pending]) {
    if (typeof p.promptId !== 'number') continue;
    let done: Settled | null = null;
    if (p.promptId === replyFor || p.promptId === maxId) {
      if (replyDone) {
        done = {
          id: p.id,
          state: replyFailed ? 'failed' : 'done',
          answer: firstLine(String(reply?.answer || ''), 100),
        };
      }
    } else if (p.promptId < maxId) {
      // The agent already started a later question: ours is over.
      done = { id: p.id, state: 'done', answer: '' };
    }
    if (done) {
      out.push(done);
      pending.splice(pending.indexOf(p), 1);
    }
  }
  return out;
}
