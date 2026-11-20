/**
 * useClockEngine — clock animation + cross-tab sync.
 *
 * Replaces the old "setInterval per tab + publish full clockState every
 * tick" pattern, which oscillated when both tabs ran their interval.
 *
 * Sync model: only the *anchor* travels over the bus —
 *   { animate, frequency, start_index, end_index,
 *     startWallTime, startIndex, showClock, senderTime }
 *
 * Each tab computes its own current index locally from the anchor on a
 * requestAnimationFrame loop:
 *   adjustedNow  = Date.now() + clockOffset
 *   stepsElapsed = floor((adjustedNow - startWallTime) / frequency)
 *   index        = start_index + ((startIndex - start_index + stepsElapsed) mod range)
 *
 * `clockOffset` is set on every receive to (senderTime - localNow), which
 * corrects for clock skew between machines (NTP keeps a LAN within a few
 * ms; a tablet on Wi-Fi can be tens of ms off — the offset closes that
 * gap so all tabs land on the same frame, modulo network latency).
 *
 * Pause / resume / scrub / speed-change all *re-anchor*: startWallTime
 * jumps to "now" and startIndex captures the current frame. The smart
 * setter detects which fields trigger a re-anchor and handles it for
 * callers that just write `{...prev, animate: !prev.animate}` etc.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import bus from '../lib/stateBus.js';

// Math-affecting fields. Changes here re-anchor: stamp a fresh
// startWallTime + capture the current frame as startIndex. `index`
// counts because a manual seek is "set startIndex to this and reset
// the wall-time origin"; `showClock` is purely cosmetic and does not.
const ANCHOR_TRIGGERING = ['animate', 'frequency', 'start_index', 'end_index', 'index'];

// Sync payload = the full clockState minus `index`, which is locally
// derived from the anchor on every rAF tick and would oscillate if
// shipped over the bus per-tick. Everything else (math anchor +
// metadata like timestamps / startDate / endDate / bounds + UI flags)
// rides along: a control-center tab that doesn't load buffer data
// relies on this metadata for slider labels and date pickers.
function pickPayload(s) {
  if (!s) return {};
  const out = {};
  for (const k of Object.keys(s)) {
    if (k === 'index') continue;
    out[k] = s[k];
  }
  return out;
}

// Cheap signature used to dedupe publishes: detects changes in any
// synced field. Timestamps are summarized by length + endpoints so a
// fresh-but-identical array doesn't trigger redundant publishes.
function payloadSig(s) {
  if (!s) return '';
  const ts = s.timestamps || [];
  return [
    s.animate, s.frequency, s.start_index, s.end_index,
    s.startWallTime, s.startIndex, s.showClock,
    s.startDate, s.endDate, s.min_index, s.max_index,
    ts.length, ts[0] || '', ts[ts.length - 1] || '',
  ].join(':');
}

const DEFAULT_STATE = {
  timestamps: [],
  startDate: '',
  endDate: '',
  start_index: 0,
  end_index: 0,
  index: 0,
  min_index: 0,
  max_index: 0,
  frequency: 750,
  animate: false,
  showClock: false,
  startWallTime: 0,
  startIndex: 0,
};

/**
 * @param {object} [opts]
 * @param {object} [opts.initial] - merge over DEFAULT_STATE for first render
 * @param {boolean} [opts.requestOnMount=false] - publish 'clock' sync-request
 *   with retry on mount. Use this for follower/late-joining tabs that need
 *   to learn the current anchor from peers.
 * @returns {[clockState, updateClockState]}
 */
export default function useClockEngine({ initial, requestOnMount = false } = {}) {
  const [clockState, _setClockState] = useState({ ...DEFAULT_STATE, ...(initial || {}) });
  const stateRef = useRef(clockState);
  stateRef.current = clockState;

  // Skew between local Date.now() and the publisher's wall clock. 0 when
  // we are the publisher; updated on every receive to (sender - local).
  const clockOffsetRef = useRef(0);
  // Last published payload sig — suppresses re-publish when only the
  // rAF-derived `index` changed (payloadSig excludes `index`).
  const lastPubSigRef = useRef(payloadSig(clockState));
  // Last applied live index — short-circuits redundant setState calls
  // from rAF when floor(elapsed / frequency) hasn't moved since last paint.
  const liveIndexRef = useRef(clockState.index);

  // ── Smart setter: re-anchors when math-affecting fields change ─────────
  const updateClockState = useCallback((updater) => {
    _setClockState((prev) => {
      const updates = typeof updater === 'function' ? updater(prev) : updater;
      if (!updates || typeof updates !== 'object') return prev;
      let triggered = false;
      for (const k of ANCHOR_TRIGGERING) {
        if (k in updates && updates[k] !== prev[k]) { triggered = true; break; }
      }
      if (!triggered) return { ...prev, ...updates };
      // Local mutation: we are the publisher for this anchor, so reset
      // the skew offset to 0 and stamp startWallTime with our local clock.
      clockOffsetRef.current = 0;
      const newIndex = ('index' in updates) ? updates.index : prev.index;
      return {
        ...prev,
        ...updates,
        index: newIndex,
        startIndex: newIndex,
        startWallTime: Date.now(),
      };
    });
  }, []);

  // ── Tick: advances index based on the anchor when animating ───────────
  // Self-scheduling setTimeout, NOT requestAnimationFrame: the clock
  // advances at most once per `frequency` ms, so a 60 Hz rAF loop would
  // spend 59/60 of its callbacks doing the same math and bailing. With
  // two tabs open that doubled the per-frame chatter on the compositor
  // thread alongside deck.gl's own paint work, which the user reported
  // as visible animation lag. setTimeout aligns each callback with an
  // actual step boundary instead — one tick per advance, one timer.
  useEffect(() => {
    if (!clockState.animate) return;
    const range = clockState.end_index - clockState.start_index + 1;
    if (range <= 0 || !clockState.frequency) return;
    let timer;
    const tick = () => {
      const adjustedNow = Date.now() + clockOffsetRef.current;
      const elapsed = adjustedNow - clockState.startWallTime;
      const stepsElapsed = Math.max(0, Math.floor(elapsed / clockState.frequency));
      const offset = ((clockState.startIndex - clockState.start_index + stepsElapsed) % range + range) % range;
      const liveIndex = clockState.start_index + offset;
      if (liveIndex !== liveIndexRef.current) {
        liveIndexRef.current = liveIndex;
        _setClockState((prev) => (prev.index === liveIndex ? prev : { ...prev, index: liveIndex }));
      }
      // Sleep until the next step boundary. Timers are imprecise so add
      // a 1ms floor to avoid a runaway 0-delay loop if the wall clock
      // skewed past the boundary mid-tick.
      const nextBoundary = clockState.startWallTime + (stepsElapsed + 1) * clockState.frequency;
      const wait = Math.max(1, nextBoundary - adjustedNow);
      timer = setTimeout(tick, wait);
    };
    tick();
    return () => clearTimeout(timer);
  }, [
    clockState.animate, clockState.frequency,
    clockState.startWallTime, clockState.startIndex,
    clockState.start_index, clockState.end_index,
  ]);

  // ── Publish state changes ──────────────────────────────────────────────
  const sig = payloadSig(clockState);
  useEffect(() => {
    if (lastPubSigRef.current === sig) return;
    lastPubSigRef.current = sig;
    if (!bus.getChannelSync('clock').publish) return;
    bus.publish('clock', { ...pickPayload(stateRef.current), senderTime: Date.now() });
  }, [sig]);

  // ── Subscribe to incoming snapshots ────────────────────────────────────
  useEffect(() => {
    return bus.subscribe('clock', (payload, msg) => {
      if (msg?.action === 'sync-request') {
        // Always respond — the requester explicitly asked, even when our
        // publish flag is false (follower role).
        const cur = stateRef.current;
        bus.publish('clock', { ...pickPayload(cur), senderTime: Date.now() }, 'sync-response', { force: true });
        return;
      }
      if (!payload || typeof payload !== 'object') return;
      // Skew correction. `senderTime` is the publisher's local clock at
      // the moment of publish; ours is Date.now() at receive. The wire
      // delay biases offset by ~one round trip's worth, but sub-second
      // animation frequencies are well above that floor.
      const senderTime = Number.isFinite(payload.senderTime) ? payload.senderTime : Date.now();
      clockOffsetRef.current = senderTime - Date.now();
      _setClockState((prev) => {
        const next = { ...prev };
        for (const k of Object.keys(payload)) {
          if (k === 'index' || k === 'senderTime') continue;
          next[k] = payload[k];
        }
        // For paused, snap directly to the anchor's startIndex so the
        // playhead matches even before rAF runs again. For playing, the
        // rAF tick will compute the correct frame on next paint.
        next.index = next.animate ? prev.index : (next.startIndex ?? prev.index);
        // Suppress the re-publish that would otherwise echo this snapshot
        // straight back out — compute the sig of what we just applied.
        lastPubSigRef.current = payloadSig(next);
        return next;
      });
      // Force rAF's first post-receive tick to publish the computed
      // frame even if it lands on the same int as before.
      liveIndexRef.current = -1;
    });
  }, []);

  // ── Initial sync request (followers ask peers for current anchor) ─────
  useEffect(() => {
    if (!requestOnMount) return;
    let attempts = 0;
    const fire = () => {
      if (attempts >= 5) return;
      attempts++;
      bus.publish('clock', null, 'sync-request');
    };
    const t0 = setTimeout(fire, 400);
    const iv = setInterval(fire, 2500);
    const stop = setTimeout(() => clearInterval(iv), 13000);
    return () => { clearTimeout(t0); clearInterval(iv); clearTimeout(stop); };
  }, [requestOnMount]);

  // Force-publish the current snapshot. Used by the host's peer-join
  // handler to proactively bring a freshly-discovered peer up to speed
  // without waiting for its sync-request retry to land.
  const broadcastAnchor = useCallback((opts = {}) => {
    bus.publish(
      'clock',
      { ...pickPayload(stateRef.current), senderTime: Date.now() },
      'update',
      opts,
    );
  }, []);

  return [clockState, updateClockState, broadcastAnchor];
}
