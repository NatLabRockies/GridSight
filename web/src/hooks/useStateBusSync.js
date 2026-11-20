/**
 * useStateBusSync — React hook that syncs state with the StateBus.
 *
 * Publishes local state changes to the bus (for other windows to receive)
 * and applies incoming bus messages to the local React state.
 *
 * Usage:
 *   useStateBusSync('viewport', viewState, setViewState);
 *   useStateBusSync('controls', controlRefreshKey, setControlRefreshKey, {
 *     transformOutgoing: (key) => ({ refreshKey: key }),
 *     transformIncoming: (payload) => payload.refreshKey,
 *   });
 */

import { useEffect, useRef } from 'react';
import bus from '../lib/stateBus.js';

/**
 * @param {string} channel - bus channel name
 * @param {any} value - current React state value
 * @param {function} setter - React setState function
 * @param {object} [options]
 * @param {function} [options.transformOutgoing] - transform value before publishing
 * @param {function} [options.transformIncoming] - transform payload before setting state
 * @param {boolean} [options.publishOnly=false] - only publish, don't subscribe
 * @param {boolean} [options.subscribeOnly=false] - only subscribe, don't publish
 * @param {function} [options.onSyncRequest] - called when another window requests full state
 * @param {boolean} [options.requestOnMount=false] - fire `bus.publish(channel, null,
 *   'sync-request')` on mount with a short retry loop. Use this for late-
 *   joining tabs that need to learn the current value from a peer; the
 *   peer's responder publishes a `sync-response` which lands in the
 *   subscribe effect like any other update.
 */
export default function useStateBusSync(channel, value, setter, options = {}) {
  const {
    transformOutgoing,
    transformIncoming,
    publishOnly = false,
    subscribeOnly = false,
    onSyncRequest,
    requestOnMount = false,
  } = options;

  // Stash callbacks + the live value in refs so the effects can read the
  // freshest references without listing them as deps. Without this, a
  // caller that swaps transforms or onSyncRequest mid-lifecycle would
  // silently keep using the old closures — the subscribe effect only
  // re-runs on channel/publishOnly change.
  const transformOutgoingRef = useRef(transformOutgoing);
  const transformIncomingRef = useRef(transformIncoming);
  const onSyncRequestRef = useRef(onSyncRequest);
  const setterRef = useRef(setter);
  const latestValueRef = useRef(value);
  transformOutgoingRef.current = transformOutgoing;
  transformIncomingRef.current = transformIncoming;
  onSyncRequestRef.current = onSyncRequest;
  setterRef.current = setter;
  latestValueRef.current = value;

  // Echo guard: track the last value applied from the bus so the publish
  // effect can skip echoing it back out. Reference equality is enough —
  // bus payloads always produce a fresh reference (transformIncoming
  // returns new objects; primitives round-trip identically and de-dupe
  // naturally on the publish side), so any locally-originated change has
  // a different reference. Replaces the old `fromBusRef` flag, which had
  // a race when React batched multiple state updates: the flag could
  // clear before the publish effect observed the bus-originated value,
  // or persist past it and suppress a legitimate local change.
  const lastBusValueRef = useRef();
  // Last value we actually published, to suppress republishing on
  // unrelated dep changes (e.g. StrictMode's double-mount in dev).
  const lastPublishedRef = useRef(value);

  // Subscribe to incoming messages from other windows
  useEffect(() => {
    if (publishOnly) return;

    const unsubscribe = bus.subscribe(channel, (payload, msg) => {
      if (msg.action === 'sync-request') {
        // Another window is requesting our current state. Force-publish
        // even when our per-channel publish flag is false (e.g. follower
        // role): the requester explicitly asked, so the policy that
        // suppresses our outbound traffic shouldn't apply.
        if (onSyncRequestRef.current) {
          onSyncRequestRef.current();
        } else {
          const t = transformOutgoingRef.current;
          const outgoing = t ? t(latestValueRef.current) : latestValueRef.current;
          bus.publish(channel, outgoing, 'sync-response', { force: true });
        }
        return;
      }

      // Apply the incoming state
      const t = transformIncomingRef.current;
      const incoming = t ? t(payload) : payload;
      lastBusValueRef.current = incoming;
      setterRef.current(incoming);
    });

    return unsubscribe;
  }, [channel, publishOnly]);

  // Publish local state changes to the bus
  useEffect(() => {
    if (subscribeOnly) return;
    // Skip if this value just came in from the bus (prevent echo).
    if (value === lastBusValueRef.current) return;
    // Skip if we already published this exact value.
    if (value === lastPublishedRef.current) return;
    lastPublishedRef.current = value;

    const t = transformOutgoingRef.current;
    const outgoing = t ? t(value) : value;
    bus.publish(channel, outgoing);
  }, [value, channel, subscribeOnly]);

  // Initial sync-request retries for late-joining tabs. 5 attempts at
  // 2500ms covers the ~13s window during which session transports finish
  // setting up and peer subscribers are ready to respond.
  useEffect(() => {
    if (!requestOnMount) return;
    let attempts = 0;
    const MAX = 5;
    const fire = () => {
      if (attempts >= MAX) return;
      attempts++;
      bus.publish(channel, null, 'sync-request');
    };
    const t0 = setTimeout(fire, 400);
    const iv = setInterval(fire, 2500);
    return () => { clearTimeout(t0); clearInterval(iv); };
  }, [channel, requestOnMount]);
}
