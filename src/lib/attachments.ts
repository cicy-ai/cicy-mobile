import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

export type PendingAttachment = {
  // Stable local key for list rendering / removal.
  key: string;
  uri: string;
  name: string;
  mime: string;
  kind: 'image' | 'file';
  size?: number;
};

let counter = 0;
function nextKey() {
  counter += 1;
  return `att-${Date.now()}-${counter}`;
}

function guessName(uri: string, fallback: string) {
  const base = uri.split(/[\\/?#]/).pop();
  return base && base.includes('.') ? base : fallback;
}

// Pick one or more images from the library. Compressed via the picker's quality
// setting (no separate resize dep). Returns [] if the user cancels.
export async function pickImages(): Promise<PendingAttachment[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) throw new Error('photos-denied');
  const res = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    quality: 0.7,
  });
  if (res.canceled) return [];
  return res.assets.map((a) => ({
    key: nextKey(),
    uri: a.uri,
    name: a.fileName || guessName(a.uri, 'image.jpg'),
    mime: a.mimeType || 'image/jpeg',
    kind: 'image' as const,
    size: a.fileSize,
  }));
}

// Take a photo with the camera.
export async function takePhoto(): Promise<PendingAttachment[]> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('camera-denied');
  const res = await ImagePicker.launchCameraAsync({ quality: 0.7 });
  if (res.canceled) return [];
  return res.assets.map((a) => ({
    key: nextKey(),
    uri: a.uri,
    name: a.fileName || guessName(a.uri, 'photo.jpg'),
    mime: a.mimeType || 'image/jpeg',
    kind: 'image' as const,
    size: a.fileSize,
  }));
}

// Open the system camera allowing BOTH photo capture and video recording (the
// camera UI's own toggle) — the composer's camera button jumps straight here,
// no menu in between.
export async function captureMedia(): Promise<PendingAttachment[]> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('camera-denied');
  const res = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images', 'videos'],
    quality: 0.7,
    videoMaxDuration: 300,
  });
  if (res.canceled) return [];
  return res.assets.map((a) => {
    const isVideo = (a.type || '').includes('video') || (a.mimeType || '').startsWith('video/');
    return {
      key: nextKey(),
      uri: a.uri,
      name: a.fileName || guessName(a.uri, isVideo ? 'video.mp4' : 'photo.jpg'),
      mime: a.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
      kind: (isVideo ? 'file' : 'image') as 'image' | 'file',
      size: a.fileSize,
    };
  });
}

// Pick arbitrary documents.
export async function pickDocuments(): Promise<PendingAttachment[]> {
  const res = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (res.canceled) return [];
  return res.assets.map((a) => ({
    key: nextKey(),
    uri: a.uri,
    name: a.name || guessName(a.uri, 'file'),
    mime: a.mimeType || 'application/octet-stream',
    kind: 'file' as const,
    size: a.size ?? undefined,
  }));
}
