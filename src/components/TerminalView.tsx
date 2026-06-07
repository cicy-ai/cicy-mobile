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
    m.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    (document.head || document.documentElement).appendChild(m);
  })();
  true;
`;

const MOBILE_XTERM_INJECT = `
  (function(){
    var FONT_SIZE = 12;
    var LINE_HEIGHT = 1.15;
    var FONT_FAMILY = 'Menlo, "SF Mono", Consolas, monospace';
    var tries = 0;
    function looksLikeTerm(t){
      return t && typeof t === 'object' && t.options && typeof t.resize === 'function';
    }
    function findTerm(){
      if (looksLikeTerm(window.term)) return window.term;
      if (window.tty && looksLikeTerm(window.tty.term)) return window.tty.term;
      if (window.terminal && looksLikeTerm(window.terminal)) return window.terminal;
      return null;
    }
    function findFit(){
      if (window.fitAddon && typeof window.fitAddon.fit === 'function') return window.fitAddon;
      return null;
    }
    function tune(){
      var t = findTerm();
      if (!t) return false;
      try {
        if (t.options) {
          t.options.fontSize = FONT_SIZE;
          t.options.lineHeight = LINE_HEIGHT;
          t.options.fontFamily = FONT_FAMILY;
        } else {
          t.setOption && t.setOption('fontSize', FONT_SIZE);
          t.setOption && t.setOption('lineHeight', LINE_HEIGHT);
          t.setOption && t.setOption('fontFamily', FONT_FAMILY);
        }
        var fit = findFit();
        if (fit) {
          fit.fit();
        } else if (typeof t.fit === 'function') {
          t.fit();
        }
        document.documentElement.style.background = '#000';
        document.body && (document.body.style.background = '#000');
        return true;
      } catch (e) {
        return false;
      }
    }
    function loop(){
      if (tune() || tries++ > 30) return;
      setTimeout(loop, 250);
    }
    if (document.readyState === 'complete') loop();
    else window.addEventListener('load', loop);
    window.addEventListener('resize', function(){ setTimeout(tune, 100); });
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
