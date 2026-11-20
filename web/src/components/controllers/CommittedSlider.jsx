/**
 * CommittedSlider — MUI Slider wrapper that updates internally while the
 * user drags and only fires the parent `onChange` once, on release.
 *
 * Why: the styling sliders feed a chain of expensive work (bus publish,
 * deck.gl re-layer, mapping diffs). Firing onChange on every pointer
 * tick pegs the main thread and the thumb lags behind the cursor. We
 * keep a local draft value for instant visual feedback and only commit
 * to the parent when the pointer is released (onChangeCommitted).
 *
 * Drop-in replacement: accepts all normal Slider props. Use exactly
 * like <Slider>; the parent sees onChange only on commit.
 */

import { useEffect, useRef, useState } from 'react';
import Slider from '@mui/material/Slider';

export default function CommittedSlider({ value, onChange, ...rest }) {
  const [draft, setDraft] = useState(value);
  const draggingRef = useRef(false);

  // Sync external value changes in when we're not actively dragging.
  // During drag, ignore parent updates so the thumb doesn't snap back.
  useEffect(() => {
    if (!draggingRef.current) setDraft(value);
  }, [value]);

  return (
    <Slider
      {...rest}
      value={draft}
      onChange={(_, v) => { draggingRef.current = true; setDraft(v); }}
      onChangeCommitted={(ev, v) => {
        draggingRef.current = false;
        setDraft(v);
        onChange?.(ev, v);
      }}
    />
  );
}
