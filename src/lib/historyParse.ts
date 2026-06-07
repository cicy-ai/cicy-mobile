// Two-part history parser — ported verbatim (logic-for-logic) from cicy-code's
// desktop CurrentHistoryView.tsx (the authoritative implementation, owned by
// w-10001). Turns the RAW current.json message items returned by
// /api/agents/current-history into rendered HistoryTurn[]. These are pure
// functions with no DOM / storage deps, so they drop straight into RN.
//
// Covers the three provider shapes (Anthropic content[] blocks / OpenAI
// Responses top-level function_call+output / OpenAI Chat tool_calls[]+role:tool),
// folds each call↔result into ONE tool card, preserves thinking/reasoning order,
// and dedupes by history_id. See docs/history-view-two-part-architecture.md §10.
import type { HistoryStep, HistoryTurn, RawHistoryItem } from '@/src/api/types';

function extractContentText(content: any): string {
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (part && typeof part === 'object') return String((part as any).text || '').trim();
        return '';
      })
      .filter(Boolean);
    return parts.join('\n').trim();
  }
  return String(content || '').trim();
}

// ── Harness-injected leading blocks (folded out of a user turn) ──
const HARNESS_BLOCK_RE = /^\s*<(system-reminder|task-notification|local-command-caveat|local-command-stdout|command-name|command-message|command-args)>([\s\S]*?)<\/\1>\s*/;
const AGENTS_PREFIX_RE = /^\s*#*\s*(?:AGENTS|CLAUDE)\.md instructions for [^\n]*\n+<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/;
const ENV_CONTEXT_RE = /^\s*<environment_context>[\s\S]*?<\/environment_context>\s*/;
const RECAP_BUNDLED_RE = /^\s*The user (?:stepped away and is coming back|is back)\.\s*Recap[\s\S]*?\n\s*\n[\s\S]*?\.\s{2,}(?=\S)/;
const RECAP_PREFIX_RE = /^\s*The user (?:stepped away and is coming back|is back)\.\s*Recap[\s\S]*?(?:\n\s*\n|$)/;
const CONTINUATION_PREFIX_RE = /^\s*This session is being continued from a previous conversation[\s\S]*$/;

// Peel harness-injected wrappers off the START of a user message, leaving the
// real question. Returns the folded blocks + the remaining real text.
export function splitLeadingHarnessBlocks(text: string): { blocks: string[]; remaining: string } {
  let remaining = String(text || '');
  const blocks: string[] = [];
  for (let i = 0; i < 50; i += 1) {
    const m =
      remaining.match(HARNESS_BLOCK_RE) ||
      remaining.match(AGENTS_PREFIX_RE) ||
      remaining.match(ENV_CONTEXT_RE) ||
      remaining.match(RECAP_BUNDLED_RE) ||
      remaining.match(RECAP_PREFIX_RE) ||
      remaining.match(CONTINUATION_PREFIX_RE);
    if (!m) break;
    blocks.push(m[0].trim());
    remaining = remaining.slice(m[0].length);
  }
  return { blocks, remaining: remaining.trim() };
}

// ── single raw item → one HistoryTurn ──
function normalizeRawHistoryItem(
  raw: any,
  toolNameByCallId?: Map<string, string>,
  toolResultByCallId?: Map<string, string>,
): HistoryTurn | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as any;
  const historyId = Number(item.history_id || item.id || 0);
  const conversationId = String(item.conversation_id || '').trim();
  const role = String(item.role || '').trim();
  const itemType = String(item.type || '').trim();
  const model = String(item.model || '').trim();
  const status = String(item.status || '').trim() || 'text';

  // system / developer = harness notices (fold whole message, not an AI bubble).
  if (role === 'system' || role === 'developer') {
    const sysText = extractContentText(item.content) || String(item.text || '').trim();
    if (!sysText) return null;
    return { history_id: historyId || undefined, conversation_id: conversationId, role: 'system', q: '', text: sysText, a: '', steps: [], status, model };
  }

  if (role === 'user') {
    const question = extractContentText(item.content) || String(item.text || item.q || '').trim();
    if (question) {
      return { history_id: historyId || undefined, conversation_id: conversationId, role: 'user', q: question, text: question, a: '', steps: [], status, model };
    }
    // Anthropic tool_result lives in a role:user message with no text.
    const toolSteps: HistoryStep[] = [];
    if (Array.isArray(item.content)) {
      for (const part of item.content as any[]) {
        const pt = String(part?.type || '').trim();
        if (pt === 'tool_result' || pt === 'function_call_output') {
          const callId = String(part?.tool_use_id || part?.tool_id || '').trim();
          let name = String(part?.name || part?.tool_name || '').trim();
          if (!name && callId && toolNameByCallId?.has(callId)) name = toolNameByCallId.get(callId) || 'tool_result';
          if (!name) name = 'tool_result';
          toolSteps.push({
            type: 'tool',
            tools: [{ name, arg: '', result: typeof part.content === 'string' ? part.content.trim() : part.content ? JSON.stringify(part.content).trim() : '' }],
          });
        }
      }
    }
    if (toolSteps.length) {
      return { history_id: historyId || undefined, conversation_id: conversationId, role: 'assistant', q: '', text: '', a: '', steps: toolSteps, status, model };
    }
    return null;
  }

  // OpenAI Chat tool-result message (role:tool / role:function).
  if (role === 'tool' || role === 'function') {
    const callId = String(item.tool_call_id || item.tool_id || item.call_id || '').trim();
    let name = String(item.name || '').trim();
    if (!name && callId && toolNameByCallId?.has(callId)) name = toolNameByCallId.get(callId) || '';
    if (!name) name = 'tool_result';
    const result = typeof item.content === 'string' ? item.content.trim() : item.content ? JSON.stringify(item.content).trim() : '';
    if (!result) return null;
    return { history_id: historyId || undefined, conversation_id: conversationId, role: 'assistant', q: '', text: '', a: '', steps: [{ type: 'tool', tools: [{ name, arg: '', result }] }], status, model };
  }

  // assistant
  const steps: HistoryStep[] = [];
  // Anthropic content[] thinking blocks lead the message.
  if (Array.isArray(item.content)) {
    const thinkingText = (item.content as any[])
      .filter((p) => p && typeof p === 'object' && String(p.type || '').trim() === 'thinking')
      .map((p) => String(p.thinking || '').trim())
      .filter(Boolean)
      .join('\n\n');
    if (thinkingText) steps.push({ type: 'thinking', text: thinkingText });
  }
  // OpenAI Chat / opencode: top-level reasoning_content string.
  const reasoningText = String(item.reasoning_content || item.reasoning || '').trim();
  if (reasoningText) steps.push({ type: 'thinking', text: reasoningText });

  const assistantText = extractContentText(item.content);
  if (assistantText) steps.push({ type: 'text', text: assistantText });

  if (itemType === 'custom_tool_call') {
    steps.push({ type: 'tool', tools: [{ name: String(item.name || 'tool'), arg: String(item.input || '').trim(), result: String(item._tool_output || '').trim() }] });
  }
  if (itemType === 'custom_tool_call_output') {
    steps.push({ type: 'tool', tools: [{ name: String(item.name || item.tool_name || 'tool'), arg: '', result: String(item.output || item.result || '').trim() }] });
  }
  // OpenAI Responses: top-level function_call.
  if (itemType === 'function_call') {
    steps.push({
      type: 'tool',
      tools: [{
        name: String(item.name || 'tool'),
        arg: typeof item.arguments === 'string' ? item.arguments.trim() : item.arguments ? JSON.stringify(item.arguments).trim() : item.input ? JSON.stringify(item.input).trim() : '',
        result: String(item._tool_output || '').trim(),
      }],
    });
  }
  // OpenAI Responses: top-level function_call_output (name-less result).
  if (itemType === 'function_call_output') {
    const callId = String(item.call_id || item.tool_id || '').trim();
    let name = '';
    if (callId && toolNameByCallId?.has(callId)) name = toolNameByCallId.get(callId) || '';
    if (!name) name = 'tool';
    steps.push({ type: 'tool', tools: [{ name, arg: '', result: String(item.output || item.result || '').trim() }] });
  }
  // OpenAI Chat: assistant.tool_calls[].
  if (Array.isArray(item.tool_calls)) {
    for (const tc of item.tool_calls as any[]) {
      const fn = tc?.function || {};
      const callId = String(tc?.id || '').trim();
      const result = (callId && toolResultByCallId?.get(callId)) || '';
      steps.push({
        type: 'tool',
        tools: [{ name: String(fn.name || tc?.name || 'tool'), arg: typeof fn.arguments === 'string' ? fn.arguments.trim() : fn.arguments ? JSON.stringify(fn.arguments).trim() : '', result: String(result).trim() }],
      });
    }
  }
  // Anthropic content[] tool_use / tool_result.
  if (itemType !== 'custom_tool_call' && itemType !== 'custom_tool_call_output' && Array.isArray(item.content)) {
    for (const part of item.content as any[]) {
      const pt = String(part?.type || '').trim();
      if (pt === 'tool_use') {
        steps.push({ type: 'tool', tools: [{ name: String(part.name || 'tool'), arg: typeof part.input === 'string' ? part.input.trim() : part.input ? JSON.stringify(part.input).trim() : '', result: String(part?._tool_result || '').trim() }] });
      }
      if (pt === 'tool_result' || pt === 'function_call_output') {
        const callId = String(part?.tool_use_id || part?.tool_id || '').trim();
        let name = String(part?.name || part?.tool_name || '').trim();
        if (!name && callId && toolNameByCallId?.has(callId)) name = toolNameByCallId.get(callId) || 'tool';
        if (!name) name = 'tool_result';
        steps.push({ type: 'tool', tools: [{ name, arg: '', result: typeof part.content === 'string' ? part.content.trim() : part.content ? JSON.stringify(part.content).trim() : '' }] });
      }
    }
  }
  if (!steps.length) return null;
  const answer = steps
    .filter((step) => step.type === 'text')
    .map((step) => String((step as any).text || '').trim())
    .filter(Boolean)
    .join('\n\n');
  return { history_id: historyId || undefined, conversation_id: conversationId, role: 'assistant', q: '', text: '', a: answer, steps, status, model };
}

// ── raw items[] → turns[] (with call↔result folding across the three shapes) ──
export function buildTurnsFromRawItems(rawItems: RawHistoryItem[]): HistoryTurn[] {
  const toolNameByCallId = new Map<string, string>();
  const fnOutputByCallId = new Map<string, string>();
  const fnCallIds = new Set<string>();
  const chatToolResultByCallId = new Map<string, string>();
  const chatToolCallIds = new Set<string>();

  for (const raw of rawItems) {
    const item: any = raw || {};
    const it = String(item?.type || '').trim();
    if (it === 'function_call' || it === 'custom_tool_call') {
      const cid = String(item?.call_id || item?.id || '').trim();
      if (cid) fnCallIds.add(cid);
    }
    if (it === 'function_call_output' || it === 'custom_tool_call_output') {
      const cid = String(item?.call_id || item?.tool_id || item?.id || '').trim();
      const rawOut = item?.output ?? item?.result;
      const out = typeof rawOut === 'string' ? rawOut : rawOut != null ? JSON.stringify(rawOut) : '';
      if (cid && out) fnOutputByCallId.set(cid, out);
    }
    if (Array.isArray(item?.tool_calls)) {
      for (const tc of item.tool_calls as any[]) {
        const cid = String(tc?.id || '').trim();
        if (cid) chatToolCallIds.add(cid);
      }
    }
    const role = String(item?.role || '').trim();
    if (role === 'tool' || role === 'function') {
      const cid = String(item?.tool_call_id || item?.tool_id || item?.call_id || '').trim();
      const rawC = item?.content ?? item?.output;
      const res = typeof rawC === 'string' ? rawC : rawC != null ? JSON.stringify(rawC) : '';
      if (cid && res) chatToolResultByCallId.set(cid, res);
    }
  }

  // Build the call-id → tool-name table across all shapes.
  for (const raw of rawItems) {
    const item: any = raw || {};
    if (Array.isArray(item.content)) {
      for (const part of item.content as any[]) {
        if (String(part?.type || '').trim() === 'tool_use' && String(part?.name || '').trim()) {
          const callId = String(part?.id || part?.call_id || '').trim();
          if (callId) toolNameByCallId.set(callId, String(part.name).trim());
        }
      }
    }
    if (String(item?.type || '').trim() === 'custom_tool_call' && String(item?.name || '').trim()) {
      const callId = String(item?.call_id || item?.id || '').trim();
      if (callId) toolNameByCallId.set(callId, String(item.name).trim());
    }
    if (String(item?.type || '').trim() === 'function_call' && String(item?.name || '').trim()) {
      const callId = String(item?.call_id || item?.id || '').trim();
      if (callId) toolNameByCallId.set(callId, String(item.name).trim());
    }
    if (Array.isArray(item?.tool_calls)) {
      for (const tc of item.tool_calls as any[]) {
        const callId = String(tc?.id || '').trim();
        const name = String(tc?.function?.name || tc?.name || '').trim();
        if (callId && name) toolNameByCallId.set(callId, name);
      }
    }
  }

  const merged: any[] = [];
  for (let i = 0; i < rawItems.length; i += 1) {
    const current: any = rawItems[i] || {};
    if (i + 1 < rawItems.length) {
      const next: any = rawItems[i + 1] || {};
      const currentRole = String(current?.role || '').trim();
      const nextRole = String(next?.role || '').trim();
      if (currentRole === 'assistant' && nextRole === 'user') {
        const currentContent = Array.isArray(current?.content) ? current.content : [];
        const nextContent = Array.isArray(next?.content) ? next.content : [];
        // Index EVERY tool_result in the next user message by id (parallel calls).
        const resultById = new Map<string, string>();
        for (const p of nextContent) {
          const t = String(p?.type || '').trim();
          if (t !== 'tool_result' && t !== 'function_call_output') continue;
          const rid = String(p?.tool_use_id || p?.tool_id || p?.call_id || '').trim();
          if (!rid) continue;
          const r = p?.content ?? p?.output;
          const result = typeof r === 'string' ? r : r != null ? JSON.stringify(r) : '';
          if (result) resultById.set(rid, result);
        }
        const toolUseIds = currentContent
          .filter((p: any) => String(p?.type || '').trim() === 'tool_use')
          .map((p: any) => String(p?.id || '').trim());
        if (toolUseIds.some((id: string) => id && resultById.has(id))) {
          const it = JSON.parse(JSON.stringify(current));
          const itemContent = Array.isArray(it?.content) ? it.content : [];
          for (let j = 0; j < itemContent.length; j += 1) {
            if (String(itemContent[j]?.type || '').trim() !== 'tool_use') continue;
            const id = String(itemContent[j]?.id || '').trim();
            const result = id ? resultById.get(id) : '';
            if (result) itemContent[j] = { ...itemContent[j], _tool_result: result };
          }
          it.content = itemContent;
          it._has_tool_result = true;
          merged.push(it);
          i += 1;
          continue;
        }
      }
    }
    const ct = String(current?.type || '').trim();
    if (ct === 'function_call' || ct === 'custom_tool_call') {
      const cid = String(current?.call_id || current?.id || '').trim();
      const out = cid ? fnOutputByCallId.get(cid) : '';
      if (out) { merged.push({ ...current, _tool_output: out }); continue; }
    }
    if (ct === 'function_call_output' || ct === 'custom_tool_call_output') {
      const cid = String(current?.call_id || current?.tool_id || current?.id || '').trim();
      if (cid && fnCallIds.has(cid)) continue;
    }
    const cRole = String(current?.role || '').trim();
    if (cRole === 'tool' || cRole === 'function') {
      const cid = String(current?.tool_call_id || current?.tool_id || current?.call_id || '').trim();
      if (cid && chatToolCallIds.has(cid)) continue;
    }
    merged.push(current);
  }

  return merged
    .map((raw) => normalizeRawHistoryItem(raw, toolNameByCallId, chatToolResultByCallId))
    .filter(Boolean) as HistoryTurn[];
}

// ── dedupe + order by history_id ──
function historyTurnScore(turn: HistoryTurn): number {
  const answerLen = String(turn?.a || '').trim().length;
  const stepLen = Array.isArray(turn?.steps)
    ? turn.steps.reduce((sum, step) => sum + String((step as any)?.text || '').trim().length, 0)
    : 0;
  return answerLen + stepLen;
}

function historyTurnOrderValue(turn: HistoryTurn): number {
  const historyID = Number(turn?.history_id || 0);
  if (historyID > 0) return historyID;
  return Number(turn?.ts || turn?.start_ts || 0);
}

function mergeHistoryTurnVersions(prev: HistoryTurn | undefined, incoming: HistoryTurn): HistoryTurn {
  if (!prev) return incoming;
  const base = historyTurnScore(incoming) >= historyTurnScore(prev) ? incoming : prev;
  const fallback = base === incoming ? prev : incoming;
  return {
    ...fallback,
    ...base,
    history_id: Number(base?.history_id || fallback?.history_id || 0) || undefined,
    conversation_id: String(base?.conversation_id || fallback?.conversation_id || ''),
    q: String(base?.q || fallback?.q || ''),
    role: String(base?.role || fallback?.role || ''),
    text: String(base?.text || fallback?.text || ''),
    a: String(base?.a || fallback?.a || ''),
    steps: Array.isArray(base?.steps) && base.steps.length ? base.steps : fallback?.steps,
    status: String(base?.status || fallback?.status || ''),
    model: String(base?.model || fallback?.model || ''),
  };
}

export function normalizeHistoryTurns(items: HistoryTurn[]): HistoryTurn[] {
  const byHistoryID = new Map<number, HistoryTurn>();
  const withoutHistoryID: HistoryTurn[] = [];
  for (const item of items) {
    const historyID = Number(item?.history_id || 0);
    if (historyID > 0) {
      byHistoryID.set(historyID, mergeHistoryTurnVersions(byHistoryID.get(historyID), item));
      continue;
    }
    withoutHistoryID.push(item);
  }
  const ordered = Array.from(byHistoryID.values()).sort((a, b) => historyTurnOrderValue(a) - historyTurnOrderValue(b));
  if (!withoutHistoryID.length) return ordered;
  return [...withoutHistoryID.sort((a, b) => historyTurnOrderValue(a) - historyTurnOrderValue(b)), ...ordered];
}
