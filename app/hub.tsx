// Copyright 2026 CiCy AI
// SPDX-License-Identifier: Apache-2.0

// The Hub's coordinator "big chat" is hidden — teams are sourced from the
// connected hub(s) (see HubConnector at the layout root) and the home is the
// team agents list. Any lingering navigation to /hub just lands there.
import { Redirect } from 'expo-router';

export default function HubScreen() {
  return <Redirect href="/agents" />;
}
