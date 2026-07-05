import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { useTheme } from '@/src/theme';

type Props = {
  url: string;
  onLoadEnd?: () => void;
};

// Native terminal view: an embedded ttyd page rendered in react-native-webview.
// The two injected scripts make the desktop ttyd/xterm layout usable on a phone
// (force a mobile viewport, shrink the xterm font, and fit the terminal to the
// webview). On web this component is replaced by TerminalView.web.tsx (an
// iframe) since react-native-webview has no web implementation.
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

const MOBILE_VIEWPORT_INJECT = `
  (function(){
    var existing = document.querySelector('meta[name="viewport"]');
    if (existing) existing.remove();
    var m = document.createElement('meta');
    m.name = 'viewport';
    m.content = 'width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes, viewport-fit=cover';
    (document.head || document.documentElement).appendChild(m);
  })();
  true;
`;

// The gotty bundle keeps its Terminal instance inside the module closure —
// nothing is exposed on window — so we cannot call term/fitAddon directly.
// What we CAN do is drive the page geometry: gotty installs a ResizeObserver
// on #terminal that refits xterm whenever the element's size changes. Sizing
// #terminal to the *visual* viewport therefore (a) keeps the prompt above the
// soft keyboard (Android edge-to-edge never resizes the window for the IME,
// but the visual viewport does shrink) and (b) guarantees the terminal exactly
// fills the screen — no clipped rows.
const MOBILE_XTERM_INJECT = `
  (function(){
    function apply(){
      var el = document.getElementById('terminal');
      if (!el) return;
      var vv = window.visualViewport;
      // While pinch-zoomed in, vv.height is the zoomed slice — resizing the
      // layout to it would wreck the page. Only track the viewport at 1x.
      if (vv && vv.scale > 1.01) return;
      var h = vv ? Math.round(vv.height) : window.innerHeight;
      document.documentElement.style.height = h + 'px';
      if (document.body) document.body.style.height = h + 'px';
      el.style.height = h + 'px';
      window.scrollTo(0, 0);
      document.documentElement.style.background = '#000';
      if (document.body) document.body.style.background = '#000';
    }
    function applySoon(){ apply(); setTimeout(apply, 60); setTimeout(apply, 250); }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', applySoon);
      window.visualViewport.addEventListener('scroll', function(){ window.scrollTo(0, 0); });
    }
    window.addEventListener('resize', applySoon);
    if (document.readyState === 'complete') applySoon();
    else window.addEventListener('load', applySoon);
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
