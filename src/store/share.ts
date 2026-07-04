import { create } from 'zustand';

// Content shared into the app from outside (Android share sheet / PWA Web
// Share Target). Parked here until the user picks an agent; the chat screen
// consumes it into the composer (prefill, never auto-send).
type ShareState = {
  text: string | null;
  setShare: (text: string) => void;
  clear: () => void;
  /** Read-and-clear — the chat composer takes the text exactly once. */
  consume: () => string | null;
};

export const useShareStore = create<ShareState>((set, get) => ({
  text: null,
  setShare: (text) => set({ text: text.trim() || null }),
  clear: () => set({ text: null }),
  consume: () => {
    const t = get().text;
    if (t) set({ text: null });
    return t;
  },
}));
