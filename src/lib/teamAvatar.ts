// Stable hashed colors + initial letter for a workspace, so the avatar in
// the drawer, header and modal all look identical. Same id → same color
// every time.

const PALETTE = [
  '#E0815B', // accent orange (brand)
  '#7AA77A', // sage green
  '#5B86C2', // dusty blue
  '#A06CB6', // muted purple
  '#C25B86', // rose
  '#5BA8B8', // teal
  '#B8995B', // ochre
  '#8B6F4E', // warm brown
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function teamAvatarColor(id: string): string {
  return PALETTE[hashStr(id) % PALETTE.length];
}

export function teamInitial(title: string): string {
  // Prefer the first non-whitespace grapheme; tolerate emoji and CJK by just
  // grabbing the first code point we see.
  const trimmed = title.trim();
  if (!trimmed) return '?';
  // Array.from handles surrogate pairs (emoji) correctly where slice(0,1)
  // would split them.
  return Array.from(trimmed)[0]!.toUpperCase();
}
