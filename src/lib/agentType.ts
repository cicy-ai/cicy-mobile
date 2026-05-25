// Mirrors cicy-code/app/src/lib/agentType.ts. Mobile uses static `require`s for
// images (Metro bundler needs string literals) so the icon map exposes
// already-resolved module IDs rather than asset URLs.

import type { ImageSourcePropType } from 'react-native';

type NormalizedAgentType =
  | ''
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'cursor'
  | 'kiro-cli'
  | 'copilot'
  | 'openclaw'
  | 'hermes'
  | 'cicy-claude';

export type AgentTypeIconMeta = {
  label: string;
  /** require()'d image — supplied for agents that ship a logo file. */
  src?: ImageSourcePropType;
  /** Text glyph used when there's no image (emoji or short caps). */
  text?: string;
};

const ICONS: Record<Exclude<NormalizedAgentType, ''>, AgentTypeIconMeta> = {
  claude: { label: 'Claude', src: require('../../assets/logos/claude-symbol.png') },
  codex: { label: 'Codex', src: require('../../assets/logos/openai.png') },
  opencode: { label: 'OpenCode', src: require('../../assets/logos/opencode.png') },
  cursor: { label: 'Cursor', src: require('../../assets/logos/cursor.png') },
  'kiro-cli': { label: 'Kiro', src: require('../../assets/logos/kiro.png') },
  copilot: { label: 'Copilot', src: require('../../assets/logos/copilot.png') },
  openclaw: { label: 'OpenClaw', text: '🦞' },
  hermes: { label: 'Hermes', text: 'HE' },
  'cicy-claude': { label: 'CiCy', src: require('../../assets/logos/cicy.png') },
};

export function normalizeAgentType(agentType?: string): NormalizedAgentType {
  switch ((agentType || '').trim().toLowerCase()) {
    case 'openclaw':
    case 'opencraw':
      return 'openclaw';
    case 'codex':
    case 'openai':
    case 'gemini':
      return 'codex';
    case 'cursor':
    case 'cursor-agent':
    case 'cursor agent':
      return 'cursor';
    case 'kiro-cli':
    case 'kiro':
    case 'kiro-cli chat':
      return 'kiro-cli';
    case 'copilot':
    case 'github-copilot':
    case 'ghcopilot':
      return 'copilot';
    case 'claude':
    case 'claude code':
    case 'claude-code':
      return 'claude';
    case 'cicy':
    case 'cicy-claude':
      return 'cicy-claude';
    case 'opencode':
    case 'open code':
    case 'open-code':
      return 'opencode';
    case 'hermes':
    case 'hermes-agent':
    case 'hermes agent':
      return 'hermes';
    default:
      return '';
  }
}

export function getAgentTypeIconMeta(agentType?: string): AgentTypeIconMeta | null {
  const n = normalizeAgentType(agentType);
  if (!n) return null;
  return ICONS[n];
}
