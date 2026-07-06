// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

import { create } from 'zustand';

import { storage } from './storage';

const SETTINGS_KEY = 'cicy_settings_v1';

type SettingsState = {
  /** Show the live meeting-record button in chat. Opt-in — off by default. */
  liveRecord: boolean;
  hydrated: boolean;
  setLiveRecord: (on: boolean) => void;
};

export const useSettingsStore = create<SettingsState>((set) => ({
  liveRecord: false,
  hydrated: false,
  setLiveRecord: (on) => {
    set({ liveRecord: on });
    void storage.setItem(SETTINGS_KEY, JSON.stringify({ liveRecord: on }));
  },
}));

// Self-hydrate on import. All settings default to their safe/off value, so the
// worst case before hydration lands is a feature briefly rendered hidden.
void storage
  .getItem(SETTINGS_KEY)
  .then((raw) => {
    let liveRecord = false;
    if (raw) {
      try {
        liveRecord = JSON.parse(raw)?.liveRecord === true;
      } catch {
        /* corrupt blob — keep defaults */
      }
    }
    useSettingsStore.setState({ liveRecord, hydrated: true });
  })
  .catch(() => useSettingsStore.setState({ hydrated: true }));
