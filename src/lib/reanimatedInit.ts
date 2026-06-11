// Native: reanimated must be imported once at the app entry so its runtime /
// worklets initialise before any animated component mounts. The web build uses
// the `.web` sibling (a no-op), which is how react-native-reanimated is kept
// out of the web bundle entirely — web animations are done with CSS in the
// `*.web.tsx` component variants instead.
import 'react-native-reanimated';
