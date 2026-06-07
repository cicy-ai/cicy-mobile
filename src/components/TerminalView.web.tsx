// Web terminal view: react-native-webview has no web implementation, so on web
// we render the ttyd page in a plain iframe. The native version's injected
// scripts (mobile viewport / xterm font tuning) are skipped here — on a desktop
// browser ttyd already lays out fine, and we can't inject across the iframe's
// origin anyway.
export function TerminalView({ url, onLoadEnd }: { url: string; onLoadEnd?: () => void }) {
  return (
    <iframe
      src={url}
      onLoad={onLoadEnd}
      title="terminal"
      allow="clipboard-read; clipboard-write"
      style={{
        flex: 1,
        width: '100%',
        height: '100%',
        border: 'none',
        background: '#000',
      }}
    />
  );
}
