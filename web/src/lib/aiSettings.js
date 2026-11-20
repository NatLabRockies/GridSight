/**
 * aiSettings — user-facing assistant settings, persisted to localStorage.
 *
 * Both live in Settings rather than environment variables because they are
 * things a user tunes while working, not deployment configuration:
 *
 *   reasoningEffort — the main latency lever on a reasoning model. A
 *     "turn this layer on" turn does not need deep thinking, and on
 *     shared/spare hardware the difference is the gap between a snappy tool
 *     call and a visible wait. 'default' defers to whatever the deployment
 *     set (CUSTOM_LLM_REASONING_EFFORT), so choosing nothing changes nothing.
 *
 *   extraInstructions — appended to the assembled system prompt, last, so it
 *     outranks the general guidance. Appended and not substituted: the tool
 *     contracts, data catalog and live view state are what make the tools
 *     usable, and replacing them wholesale breaks the assistant in ways that
 *     look like model failure.
 */

const KEY_EFFORT = 'gridsight.ai.reasoningEffort';
const KEY_INSTRUCTIONS = 'gridsight.ai.extraInstructions';

export const REASONING_EFFORTS = [
  { id: 'default', label: 'Server default', hint: 'whatever this deployment configured' },
  { id: 'low', label: 'Low', hint: 'fastest — best for tool calls and simple asks' },
  { id: 'medium', label: 'Medium', hint: 'balanced' },
  { id: 'high', label: 'High', hint: 'slowest — for multi-step analysis' },
];

const VALID = new Set(REASONING_EFFORTS.map((e) => e.id));

export function getReasoningEffort() {
  try {
    const v = localStorage.getItem(KEY_EFFORT);
    return VALID.has(v) ? v : 'default';
  } catch {
    return 'default';
  }
}

export function setReasoningEffort(value) {
  try {
    if (VALID.has(value)) localStorage.setItem(KEY_EFFORT, value);
  } catch { /* storage unavailable — setting just won't persist */ }
}

export function getExtraInstructions() {
  try {
    return localStorage.getItem(KEY_INSTRUCTIONS) || '';
  } catch {
    return '';
  }
}

export function setExtraInstructions(value) {
  try {
    localStorage.setItem(KEY_INSTRUCTIONS, value ?? '');
  } catch { /* storage unavailable */ }
}

/** Request fields for sendChatMessage. 'default' effort is omitted entirely
 *  so the server's own configuration still applies. */
export function aiRequestOverrides() {
  const effort = getReasoningEffort();
  const instructions = getExtraInstructions().trim();
  return {
    reasoningEffort: effort === 'default' ? null : effort,
    extraInstructions: instructions || null,
  };
}
