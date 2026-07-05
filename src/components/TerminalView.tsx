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

// Target terminal geometry. Without pinning, gotty fits xterm to the phone's
// freak layout (980px-wide × keyboard-height → measured 123 cols × 140 ROWS)
// and pushes that onto the shared tmux window — a stretched, unreadable
// terminal that persists after disconnect. 120×32 is a normal desktop-ish
// shape; tmux gets a sane resize and the phone reads it via pinch-zoom.
const TARGET_COLS = 120;
const TARGET_ROWS = 32;
// fontSize-13 monospace cell estimate — refined in-page by measuring xterm's
// own char-measure element once it exists.
const EST_CHAR_W = 7.83;
const EST_CHAR_H = 15;

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

// Pin #terminal to TARGET_COLS×TARGET_ROWS worth of pixels with !important
// (outguns gotty's inline "height:100%" writes). gotty's own ResizeObserver
// then refits xterm to exactly the target geometry and sends it to tmux once.
// Because the pixel size is fixed, later webview/viewport changes (soft
// keyboard, rotation churn) can never re-fit — no more resize storms into the
// shared tmux session. Two passes: an immediate estimate, then a calibrated
// pass using xterm's own char-measure element for exact cell metrics.
const MOBILE_XTERM_INJECT = `
  (function(){
    var COLS = ${TARGET_COLS}, ROWS = ${TARGET_ROWS};
    var style = document.createElement('style');
    (document.head || document.documentElement).appendChild(style);
    function pin(cw, ch){
      var w = Math.ceil(COLS * cw) + 2;
      var h = Math.ceil(ROWS * ch) + 2;
      style.textContent = '#terminal{width:' + w + 'px !important;height:' + h + 'px !important;}';
      // the before-load meta can be discarded by the HTML parser — recreate
      var m = document.querySelector('meta[name="viewport"]');
      if (!m) {
        m = document.createElement('meta');
        m.name = 'viewport';
        (document.head || document.documentElement).appendChild(m);
      }
      m.content = 'width=' + w + ', user-scalable=yes, minimum-scale=0.1, maximum-scale=5';
    }
    pin(${EST_CHAR_W}, ${EST_CHAR_H});
    var tries = 0;
    function calibrate(){
      var meas = document.querySelector('.xterm-char-measure-element');
      var r = meas && meas.getBoundingClientRect();
      // the measure element holds a run of reference chars — width per char
      var n = meas && meas.textContent ? meas.textContent.length : 1;
      if (!r || !r.height || !r.width) { if (tries++ < 40) setTimeout(calibrate, 250); return; }
      pin(r.width / Math.max(1, n), r.height);
      document.documentElement.style.background = '#000';
      if (document.body) document.body.style.background = '#000';
    }
    setTimeout(calibrate, 400);
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
