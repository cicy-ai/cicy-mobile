import * as Haptics from 'expo-haptics';
import { Pressable, type PressableProps } from 'react-native';

type Props = PressableProps & {
  haptic?: boolean | Haptics.ImpactFeedbackStyle;
  scaleTo?: number;
};

// Web variant of PressableScale: a plain Pressable, no reanimated. The native
// file already disabled the press-scale animation on web (it's polish-only and
// reanimated's AnimatedPressable doesn't reliably forward DOM events), and
// haptics throw on web — so the web build never needed reanimated at all.
// Splitting it out keeps reanimated out of the web bundle. `haptic`/`scaleTo`
// are destructured off so they don't leak onto the DOM via `...rest`.
export function PressableScale({ haptic, scaleTo, ...rest }: Props) {
  void haptic;
  void scaleTo;
  return <Pressable {...rest} />;
}
