/**
 * zoomAnchorProps — fix MUI Popover/Menu placement under `body { zoom: S }`.
 *
 * DisplayScaleProvider scales the UI for the video wall with CSS `zoom`. MUI
 * positions a Popover's (portaled, position:fixed) paper using the anchor's
 * `getBoundingClientRect()`, which under `zoom` returns ZOOMED/device coords —
 * and the body zoom then re-applies to the fixed paper, landing the menu at
 * S× the intended offset (it drifts down-right off the anchor). Empirically
 * confirmed in-app: a fixed element at left:1200 under zoom:3 renders at 3600.
 *
 * The fix switches the Popover to explicit `anchorPosition` coordinates
 * divided by the current zoom: `zoom × (rect / zoom) = rect`, so the menu
 * lands on its anchor — and stays enlarged because the paper is still inside
 * the zoomed body. Returns {} at scale 1 so default anchorEl behaviour (and
 * MUI's edge-flipping) is unchanged on normal displays.
 *
 * Spread the result onto a MUI <Menu>/<Popover>; pass the same origin you'd
 * use for anchorOrigin so the corrected point matches.
 *
 * @param {Element|null} anchorEl
 * @param {{vertical?: 'top'|'center'|'bottom', horizontal?: 'left'|'center'|'right'}} [origin]
 */
export function zoomAnchorProps(anchorEl, origin = {}) {
  if (!anchorEl || typeof anchorEl.getBoundingClientRect !== 'function') return {};
  let z = 1;
  try { z = parseFloat(getComputedStyle(document.body).zoom) || 1; } catch { /* noop */ }
  if (!z || z === 1) return {};
  const { vertical = 'bottom', horizontal = 'left' } = origin;
  const r = anchorEl.getBoundingClientRect();
  const top = (vertical === 'top' ? r.top : vertical === 'center' ? (r.top + r.bottom) / 2 : r.bottom) / z;
  const left = (horizontal === 'left' ? r.left : horizontal === 'center' ? (r.left + r.right) / 2 : r.right) / z;
  return { anchorReference: 'anchorPosition', anchorPosition: { top, left } };
}
