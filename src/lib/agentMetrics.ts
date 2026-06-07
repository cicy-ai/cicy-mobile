// Per-agent live header metrics (status / model / context usage / cost), derived
// from /api/agents/current-reply (reply.json). Ported verbatim from cicy-code's
// app/src/lib/agentMetrics.ts so the team list shows the same battle-tested math.

export interface AgentLiveMetrics {
  working: boolean;
  model: string;
  /** context usage 0-100 (%) */
  ctx: number;
  /** context window size in k tokens (for tooltip) */
  ctxK: number;
  /** cumulative cost in $ (cost_credit) */
  cost: number;
  /** change signature — skip re-render when unchanged */
  sig: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// 模型基础上下文窗口(k tokens)。粗映射,未知给 200k。
export function modelWindowK(model: string): number {
  const m = (model || '').toLowerCase();
  if (m.includes('gemini')) return 1000;
  if (m.includes('opus')) return 2000;
  if (m.includes('claude')) return 200;
  if (m.includes('gpt') || m.includes('o1') || m.includes('o3') || m.includes('o4')) return 256;
  if (m.includes('deepseek')) return 128;
  return 200;
}

// 整段 prompt 的 token 数(= 上下文占用)。网关已把 cache_read 计进 input_tokens,
// 标准 Anthropic 则分开 — 取较大解释避免重复计数。
export function promptTokens(d: any): number {
  const inp = Number(d?.input_tokens || 0),
    cr = Number(d?.cache_read_input_tokens || 0),
    cc = Number(d?.cache_creation_input_tokens || 0);
  return inp >= cr ? inp + cc : inp + cr + cc;
}

const TERMINAL_STATUSES = ['completed', 'complete', 'done', 'idle', 'aborted', 'error', 'canceled', 'cancelled', 'failed', 'stopped'];

/** Fold one current-reply payload into metrics; prev carries last-known values. */
export function metricsFromCurrentReply(d: any, prev?: AgentLiveMetrics | null): AgentLiveMetrics {
  const st = String(d?.status || '').trim().toLowerCase();
  const done = d?.complete === true || st === '' || TERMINAL_STATUSES.includes(st);
  const working = !done;
  const model = String(d?.model || prev?.model || '');
  const inTok = promptTokens(d);
  // Claude Code 自报的权威用量优先;没有才按 token/窗口估算。
  const realPct = d?.context_used_pct;
  const useReal = typeof realPct === 'number' && realPct >= 0;
  const winK = useReal && d?.context_window_size ? Math.round(d.context_window_size / 1000) : modelWindowK(model);
  const ctx = useReal
    ? clamp(Math.round(realPct), 0, 100)
    : winK > 0 && inTok > 0
      ? clamp(Math.round((inTok / (winK * 1000)) * 100), 0, 100)
      : (prev?.ctx ?? 0);
  const cost = Number(d?.cost_credit || 0) || (prev?.cost ?? 0);
  const sig = `${working ? 1 : 0}|${model}|${ctx}|${cost}`;
  return { working, model, ctx, ctxK: winK, cost, sig };
}

// Compact "$" formatting matching TeamPanel's fmtCost.
export function fmtCost(cost: number): string {
  return cost >= 100 ? `$${Math.round(cost)}` : cost >= 0.05 ? `$${cost.toFixed(1)}` : '$0';
}

// Model display helpers — ported from cicy-code's lib/modelTag.tsx so long raw
// ids (claude-opus-4-8, deepseek-v3.1-2025xxxx) collapse to the same friendly,
// space-frugal labels everywhere.
type ModelFamily =
  | 'opus' | 'sonnet' | 'haiku' | 'gpt' | 'o' | 'deepseek' | 'gemini'
  | 'qwen' | 'kimi' | 'grok' | 'glm' | 'llama' | 'mistral' | 'other';

// lowercase, strip provider path prefix (anthropic/, openai/, …) and trailing
// date/build suffixes (-20250101, @20250101, :latest, -preview, -exp, -beta).
function normalizeModel(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z0-9.+-]+\//, '')
    .replace(/[-@:](\d{6,8}|latest|preview|exp|beta)$/, '');
}

function modelFamily(raw?: string): ModelFamily {
  if (!raw || !raw.trim()) return 'other';
  const m = normalizeModel(raw);
  if (/opus/.test(m)) return 'opus';
  if (/sonnet/.test(m)) return 'sonnet';
  if (/haiku/.test(m)) return 'haiku';
  if (/^deepseek|^ds-/.test(m)) return 'deepseek';
  if (/^o\d/.test(m)) return 'o';
  if (/^gpt/.test(m)) return 'gpt';
  if (/^gemini/.test(m)) return 'gemini';
  if (/^qwen/.test(m)) return 'qwen';
  if (/^kimi|^moonshot/.test(m)) return 'kimi';
  if (/^grok/.test(m)) return 'grok';
  if (/^glm|^chatglm/.test(m)) return 'glm';
  if (/^llama|^codellama/.test(m)) return 'llama';
  if (/^mistral|^mixtral/.test(m)) return 'mistral';
  return 'other';
}

// Collapse a raw id to a friendly short label (claude-opus-4-8 → opus-4.8,
// deepseek-v4-pro → ds-v4-pro, long unknown → last two dash segments).
export function modelShort(raw?: string): string {
  if (!raw || !raw.trim()) return '—';
  const m = normalizeModel(raw.trim());
  let c = m.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (c) return `${c[1]}-${c[2]}.${c[3]}`;
  c = m.match(/^claude-(\d+)-(\d+)-(opus|sonnet|haiku)/);
  if (c) return `${c[3]}-${c[1]}.${c[2]}`;
  c = m.match(/^claude-(opus|sonnet|haiku)-(\d+)/);
  if (c) return `${c[1]}-${c[2]}`;
  if (m.startsWith('deepseek')) return m.replace(/^deepseek-?/, 'ds-') || 'ds';
  if (/^(gpt|o\d|qwen|gemini|kimi|grok|glm|llama|mistral|mixtral)/.test(m)) return m;
  if (m.length > 16) {
    const parts = m.split('-');
    if (parts.length > 2) return parts.slice(-2).join('-');
  }
  return m;
}

const FAMILY_COLOR: Record<ModelFamily, string> = {
  opus: '#8b5cf6', // violet
  sonnet: '#0ea5e9', // sky
  haiku: '#14b8a6', // teal
  gpt: '#10b981', // emerald
  o: '#84cc16', // lime
  deepseek: '#6366f1', // indigo
  gemini: '#3b82f6', // blue
  qwen: '#f59e0b', // amber
  kimi: '#d946ef', // fuchsia
  grok: '#a1a1aa', // zinc
  glm: '#06b6d4', // cyan
  llama: '#f97316', // orange
  mistral: '#f43f5e', // rose
  other: '#a1a1aa', // zinc
};

// Family color for the model chip (one hue per family, mirrors ModelTag).
export function modelColor(model: string): string {
  return FAMILY_COLOR[modelFamily(model)];
}

// Context ring color thresholds (mirrors CtxRing): <50 gray, <80 amber, ≥80 red.
export function ctxColor(pct: number): string {
  return pct > 80 ? '#f87171' : pct > 50 ? '#facc15' : '#71717a';
}
