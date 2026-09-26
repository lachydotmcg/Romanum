export const PREFILL_EVENT = "romanum:assistant-prefill";
export type AssistantPrefill = { prompt: string };

export function prefillAssistant(detail: AssistantPrefill) {
  window.dispatchEvent(new CustomEvent(PREFILL_EVENT, { detail }));
  document.getElementById("ai-prompt")?.focus();
  document.getElementById("ai-prompt")?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "center" });
}
