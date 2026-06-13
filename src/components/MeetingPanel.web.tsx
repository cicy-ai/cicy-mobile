// Real-time meeting transcription is native-only (on-device speech recognition
// + keep-awake). On web we render nothing; the chat composer hides the entry
// button on web anyway.
type Props = {
  open: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
  onError?: (msg: string) => void;
  language?: string;
};

export function MeetingPanel(_props: Props) {
  return null;
}
