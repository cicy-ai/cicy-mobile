import { useVideoPlayer, VideoView } from 'expo-video';
import { StyleSheet } from 'react-native';

// Inline video player (native) — expo-video. The source carries the Bearer
// header cloud needs to serve /assets/files. Not autoplaying; native controls.
export function InlineVideo({ uri, headers }: { uri: string; headers?: Record<string, string> }) {
  const player = useVideoPlayer({ uri, headers }, (p: { loop: boolean }) => {
    p.loop = false;
  });
  return (
    <VideoView
      player={player}
      style={styles.video}
      contentFit="contain"
      nativeControls
      allowsFullscreen
    />
  );
}

const styles = StyleSheet.create({
  video: {
    width: 240,
    height: 180,
    maxWidth: '100%',
    borderRadius: 12,
    backgroundColor: '#000',
  },
});
