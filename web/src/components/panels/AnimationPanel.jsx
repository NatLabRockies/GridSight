/**
 * AnimationPanel — registered panel that hosts the full ClockController
 * (the same component the main animation tray uses), in `embedded` mode
 * so it skips its own Paper + primary-color banner and lets the
 * ChartFrame chrome provide the title.
 *
 * Reuses ClockController to keep the operator's command-center experience
 * identical to the main display's animation tray (date pickers, scrub
 * slider, speed slider, play / pause / step buttons). Sync stays in the
 * caller's hands — this panel just takes `clockState` + `onClockChange`.
 */

import ClockController from '../controllers/clockController.jsx';

export default function AnimationPanel({ clockState, onClockChange, currentTimeLabel }) {
  return (
    <ClockController
      embedded
      props={clockState}
      onChange={onClockChange}
      currentTimeLabel={currentTimeLabel}
    />
  );
}
