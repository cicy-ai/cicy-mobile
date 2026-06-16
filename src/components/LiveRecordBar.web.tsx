// Live recording is native-only (on-device speech recognition + keep-awake).
// The chat composer hides the entry button on web, so this never renders.
type Props = {
  agentTitle: string;
  onTurn: (text: string) => void;
  onClose: () => void;
  onError?: (msg: string) => void;
  language?: string;
};

export function LiveRecordBar(_props: Props) {
  return null;
}
