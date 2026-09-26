export const PREFILL_EVENT = "romanum:assistant-prefill";
export type AssistantPrefill = { prompt: string };

export function prefillAssistant(detail: AssistantPrefill) {
  window.dispatchEvent(new CustomEvent(PREFILL_EVENT, { detail }));
  // The prompt bar is pinned to the top of the screen, so it's already in view.
  document.getElementById("ai-prompt")?.focus({ preventScroll: true });
}
