// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// Web build intentionally excludes react-native-reanimated (its runtime +
// worklets are a heavy chunk of the startup bundle). Web animations are pure
// CSS via the `*.web.tsx` component variants, so there is nothing to init here.
export {};
