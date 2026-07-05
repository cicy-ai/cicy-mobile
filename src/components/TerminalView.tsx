import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { useTheme } from '@/src/theme';

type Props = {
  url: string;
  onLoadEnd?: () => void;
};

// Native terminal view: an embedded ttyd page rendered in react-native-webview.
// Design: the phone is a VIEWER of the desktop-sized terminal, never a driver
// of its size. Resizing xterm from the phone sends the new cols/rows to tmux,
// which reflows every attached client and loses TUI content — so after gotty's
// initial fit we freeze #terminal at that size and let the user pinch-zoom/pan.
// On web this component is replaced by TerminalView.web.tsx (an iframe) since
// react-native-webview has no web implementation.
export function TerminalView({ url, onLoadEnd }: Props) {
  const theme = useTheme();
  return (
    <WebView
      source={{ uri: url }}
      originWhitelist={['*']}
      javaScriptEnabled
      domStorageEnabled
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      onLoadEnd={onLoadEnd}
      startInLoadingState
      // Pinch zoom: the viewport meta below allows scaling; these two make
      // Android's built-in pinch work without showing the +/- buttons.
      setBuiltInZoomControls
      setDisplayZoomControls={false}
      injectedJavaScriptBeforeContentLoaded={MOBILE_VIEWPORT_INJECT}
      injectedJavaScript={MOBILE_XTERM_INJECT}
      renderLoading={() => (
        <View style={styles.loading}>
          <ActivityIndicator color={theme.textMuted} />
        </View>
      )}
      style={{ flex: 1, backgroundColor: '#000' }}
    />
  );
}

// Desktop-width layout on purpose: with a ~980px layout the initial xterm fit
// lands near the desktop's cols, so the phone joins tmux without shrinking
// anyone. Wide zoom range because reading a desktop terminal on a phone IS a
// zoom/pan workflow.
const MOBILE_VIEWPORT_INJECT = `
  (function(){
    var existing = document.querySelector('meta[name="viewport"]');
    if (existing) existing.remove();
    var m = document.createElement('meta');
    m.name = 'viewport';
    m.content = 'width=980, user-scalable=yes, minimum-scale=0.1, maximum-scale=5';
    (document.head || document.documentElement).appendChild(m);
  })();
  true;
`;

// Freeze the terminal at its initially-fitted size. gotty's resize handlers
// (window resize + a ResizeObserver on #terminal) refit xterm and SEND the new
// cols/rows to tmux — on a phone that means the soft keyboard shrinking the
// webview reflows the shared desktop terminal and loses TUI content. A
// stylesheet rule with !important outguns gotty's inline "height:100%" writes,
// so the element's computed size never changes again: the ResizeObserver stays
// quiet and any later fit() recomputes the exact same cols/rows (no-op, no
// resize message). The keyboard then simply overlays the page.
const MOBILE_XTERM_INJECT = `
  (function(){
    var tries = 0;
    function freeze(){
      var el = document.getElementById('terminal');
      var w = el && el.clientWidth;
      var h = el && el.clientHeight;
      if (!w || !h) { if (tries++ < 40) setTimeout(freeze, 250); return; }
      var style = document.createElement('style');
      style.textContent = '#terminal{width:' + w + 'px !important;height:' + h + 'px !important;}';
      document.head.appendChild(style);
      document.documentElement.style.background = '#000';
      if (document.body) document.body.style.background = '#000';
    }
    // Wait out gotty's own initial fit passes (it refits at +0/50/200ms after
    // load) so we freeze the settled size, not a transient one.
    setTimeout(freeze, 700);
  })();
  true;
`;

const styles = StyleSheet.create({
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
