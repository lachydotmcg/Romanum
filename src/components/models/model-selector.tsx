"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Info, X } from "lucide-react";
import type { ModelQuote, ModelsResponse, ModelSelection, ProviderId, PublicModel, RouteDecision, RouteReason } from "@/lib/models/types";
import { claimAutoRecommendation, parseAutoRecommendationContext, UNKNOWN_RECOMMENDATION_CONTEXT } from "../../lib/models/auto-recommendation.ts";
import { ModelPreview, type ModelEvaluation } from "./model-preview.tsx";
import { AutoModelRange } from "./estimated-model-card.tsx";

const REASONS = {
  explicit_selection: "Your selected model is retained.",
  auto_affordable: "Auto chose the lowest estimated cost among enabled models within the request budget.",
  auto_cache_scenario: "Auto chose an affordable model using a compatible cache scenario. A cache hit is not guaranteed.",
  invalid_selection: "Choose a valid model.",
  invalid_request: "The request could not be quoted. Check its settings.",
  model_unavailable: "The selected model is unavailable. It has not been replaced.",
  capability_mismatch: "The selected model cannot support this request's tools or images.",
  context_limit: "The request exceeds the model's supported limits.",
  insufficient_balance: "There are not enough credits for the reservation ceiling.",
  minimum_hold: "There are not enough credits for the minimum reservation.",
  no_ready_model: "No supported model is enabled for this request.",
} satisfies Record<RouteReason, string>;

/** Official upstream marks; local masks preserve their paths and inherit the row's monochrome tone. */
function ModelMark({ provider }: { provider: ProviderId | "romanum" }) {
  const image = { deepseek: 'url("/brand/providers/deepseek.svg")', openai: 'url("/brand/providers/openai.svg")', anthropic: 'url("/brand/providers/anthropic.svg")', romanum: 'url("/brand/romanum-wordmark-compact.svg")' }[provider];
  return <span aria-hidden="true" className="inline-block size-4 shrink-0 bg-current"
    style={{ maskImage: image, maskSize: "contain", maskRepeat: "no-repeat", maskPosition: "center",
      WebkitMaskImage: image, WebkitMaskSize: "contain", WebkitMaskRepeat: "no-repeat", WebkitMaskPosition: "center" }} />;
}

function enabled(model: PublicModel | undefined, catalog: ModelsResponse | null): boolean {
  return !!model && !!catalog && catalog.models.filter((entry) => entry.id === model.id).length === 1 &&
    model.modelId === model.id && model.rateCardVersion === catalog.rateCardVersion && model.configured &&
    model.adapterSupported && model.executionEnabled && model.selectable && model.reason === "ready";
}

function unavailableReason(model: PublicModel, catalog: ModelsResponse): string {
  if (catalog.models.filter((entry) => entry.id === model.id).length !== 1 || model.id !== model.modelId || model.rateCardVersion !== catalog.rateCardVersion) return "Availability unverified";
  if (!model.configured || model.reason === "missing_key") return "Not configured";
  if (!model.adapterSupported || model.reason === "adapter_not_supported") return "Integration not supported";
  if (!model.executionEnabled || model.reason === "execution_disabled") return "Execution disabled";
  return "Unavailable";
}

const credits = (value: number) => new Intl.NumberFormat("en-GB", { maximumSignificantDigits: 6 }).format(value);
function usableQuote(quote: ModelQuote | undefined, modelId: string | undefined, catalog: ModelsResponse | null): quote is ModelQuote {
  return !!quote && !!catalog && quote.modelId === modelId && quote.rateCardVersion === catalog.rateCardVersion &&
    Number.isFinite(quote.estimatedCredits) && quote.estimatedCredits >= 0 &&
    Number.isSafeInteger(quote.reservationCredits) && quote.minimumReservationCredits === 2 &&
    quote.reservationCredits >= quote.minimumReservationCredits && quote.cacheHitGuaranteed === false &&
    (quote.estimateBasis === "uncached" || quote.estimateBasis === "compatible_cache_scenario");
}

async function readRecommendationContext(signal: AbortSignal) {
  try {
    const response = await fetch("/api/models/preferences", { cache: "no-store", signal });
    return parseAutoRecommendationContext(response.ok ? await response.json() : null);
  } catch { return UNKNOWN_RECOMMENDATION_CONTEXT; }
}

/** Controlled presentation only: metadata and quotes come from trusted integration, never browser estimates.
 * Catalog refreshes retain explicit selections. Changing a choice does not execute or reserve anything.
 * Callers clear decision when the prompt, token budget or capability requirements change.
 */
export function ModelSelector({
  catalog, selection, onChange, decision = null, disabled = false, loading = false, error = null, id, className = "", compact = false, evaluations = [],
}: {
  catalog: ModelsResponse | null;
  selection: ModelSelection;
  onChange: (selection: ModelSelection) => void;
  decision?: RouteDecision | null;
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  id?: string;
  className?: string;
  /** Compact composer pill keeps its explanatory status available to assistive technology. */
  compact?: boolean;
  /** Optional shared-suite benchmark data. No production ratings are supplied today. */
  evaluations?: readonly ModelEvaluation[];
}) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const helpId = `${selectId}-help`, statusId = `${selectId}-status`, listId = `${selectId}-options`, recommendationId = `${selectId}-recommendation`;
  const trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLDivElement>(null), closeDetailsTimer = useRef<number | null>(null);
  const focusDetails = useRef(false), skipDetailsFocus = useRef(false);
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const [peekId, setPeekId] = useState<string | null>(null), [detailsPinned, setDetailsPinned] = useState(false);
  const [detailsPosition, setDetailsPosition] = useState<{ top?: number; bottom?: number; left: number; width: number }>({ top: 8, left: 8, width: 224 });
  const [recommendationContext, setRecommendationContext] = useState(UNKNOWN_RECOMMENDATION_CONTEXT);
  const [recommendationShown, setRecommendationShown] = useState(false);
  const switchedAway = useRef(false);
  const preferenceRequest = useRef<AbortController | null>(null);
  const [position, setPosition] = useState<{ top?: number; bottom?: number; left: number; width: number; height: number }>({ top: 0, left: 8, width: 255, height: 320 });
  const models = catalog ? [...new Map(catalog.models.map((model) => [model.id, model])).values()] : [];
  const hasEnabled = models.some((model) => enabled(model, catalog));
  const value = selection.mode === "auto" ? "auto" : selection.modelId;
  const selected = selection.mode === "explicit" ? models.find((model) => model.id === selection.modelId) : undefined;
  const locked = disabled || loading || !!error || catalog === null;
  const visible = open && !locked;
  const options = [
    { value: "auto", label: "Auto", provider: null, description: hasEnabled ? "Budget and cache aware." : "No enabled models", disabled: !hasEnabled },
    ...(selection.mode === "explicit" && !selected ? [{ value: selection.modelId, label: selection.modelId, provider: null, description: "Unavailable", disabled: true }] : []),
    ...models.map((model) => ({ value: model.id, label: model.label, provider: model.provider, description: enabled(model, catalog) ? "" : unavailableReason(model, catalog!), disabled: !enabled(model, catalog) })),
  ];
  const selectedIndex = options.findIndex((option) => option.value === value);
  const enabledIndices = options.flatMap((option, index) => option.disabled ? [] : [index]);
  const peekModel = models.find(model => model.id === peekId && model.id === model.modelId && model.rateCardVersion === catalog?.rateCardVersion &&
    models.filter(entry => entry.id === model.id).length === 1);
  const peekAuto = peekId === "auto";
  const detailIndex = peekAuto ? 0 : peekModel ? options.findIndex(option => option.value === peekModel.id) : options[active]?.provider || options[active]?.value === "auto" ? active
    : selectedIndex >= 0 && (options[selectedIndex]?.provider || options[selectedIndex]?.value === "auto") ? selectedIndex : 0;
  const keepDetails = useCallback(() => { if (closeDetailsTimer.current !== null) { window.clearTimeout(closeDetailsTimer.current); closeDetailsTimer.current = null; } }, []);
  const hideDetails = useCallback(() => { keepDetails(); setPeekId(null); setDetailsPinned(false); }, [keepDetails]);
  function dismissDetails() { hideDetails(); skipDetailsFocus.current = document.activeElement !== trigger.current; trigger.current?.focus(); }
  function leaveDetails() { keepDetails(); if (!detailsPinned) closeDetailsTimer.current = window.setTimeout(() => setPeekId(null), 180); }
  function inspect(index: number, pinned = false, focus = false) {
    keepDetails(); const option = options[index];
    if (!option || (!option.provider && option.value !== "auto")) { setPeekId(null); return; }
    focusDetails.current = focus; setPeekId(option.value); setDetailsPinned(pinned);
    if (focus && peekId === option.value && details.current) { details.current.focus(); focusDetails.current = false; }
  }
  function detailsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismissDetails(); return; }
    // Browsing information includes unavailable models; selecting still uses the existing readiness gate.
    if (event.target !== event.currentTarget || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const indices = options.flatMap((option, index) => option.provider || option.value === "auto" ? [index] : []);
    if (!indices.length) return;
    event.preventDefault();
    const index = event.key === "Home" ? indices[0] : event.key === "End" ? indices[indices.length - 1]
      : indices[(indices.indexOf(detailIndex) + (event.key === "ArrowDown" ? 1 : -1) + indices.length) % indices.length];
    inspect(index, true, true);
  }
  const locateDetails = useCallback(() => {
    const rect = (visible ? popup.current : trigger.current)?.getBoundingClientRect();
    if (!rect) return;
    if (window.innerWidth < 620) {
      const width = Math.min(320, window.innerWidth - 16);
      setDetailsPosition({ bottom: 16, left: Math.max(8, (window.innerWidth - width) / 2), width });
    } else {
      const width = 224, right = rect.right + 8, left = rect.left - width - 8;
      setDetailsPosition({ top: Math.max(8, Math.min(rect.top, window.innerHeight - 240)),
        left: right + width <= window.innerWidth - 8 ? right : left >= 8 ? left : Math.max(8, window.innerWidth - width - 8), width });
    }
  }, [visible]);
  useEffect(() => {
    const controller = new AbortController();
    preferenceRequest.current = controller;
    void readRecommendationContext(controller.signal).then(value => { if (!controller.signal.aborted) setRecommendationContext(value); });
    return () => { preferenceRequest.current?.abort(); if (closeDetailsTimer.current !== null) window.clearTimeout(closeDetailsTimer.current); };
  }, []);
  function dismissRecommendation() { setRecommendationShown(false); trigger.current?.focus(); }
  function changeSelection(next: ModelSelection) {
    hideDetails();
    // Apply the deliberate choice immediately. Advice never blocks or substitutes it.
    onChange(next);
    if (next.mode === "auto") setRecommendationShown(false);
    else if (selection.mode === "auto" && !switchedAway.current) {
      switchedAway.current = true;
      // Unknown state on this first switch is skipped, never deferred to a later click.
      try { if (claimAutoRecommendation(recommendationContext, window.localStorage)) setRecommendationShown(true); }
      catch { /* A browser may deny access to localStorage itself. */ }
    }
  }
  function locate() {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.max(0, Math.min(255, window.innerWidth - 16));
    const above = rect.top - 12, below = window.innerHeight - rect.bottom - 12;
    const upwards = above >= 320 || above >= below;
    const height = Math.max(0, Math.min(320, Math.max(88, upwards ? above : below), window.innerHeight - 16));
    const anchor = upwards ? window.innerHeight - rect.top + 8 : rect.bottom + 8;
    const offset = Math.max(8, Math.min(anchor, window.innerHeight - height - 8));
    setPosition({ ...(upwards ? { bottom: offset } : { top: offset }),
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width, height });
  }
  function show(index = selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : enabledIndices[0] ?? 0) {
    if (locked) return;
    setRecommendationShown(false);
    // The sidebar may have established the guest after this composer's first read.
    // Opening the picker can refresh unknown identity without blocking model choices.
    if (recommendationContext.subscription === "unknown" && !switchedAway.current) {
      preferenceRequest.current?.abort();
      const controller = new AbortController(); preferenceRequest.current = controller;
      void readRecommendationContext(controller.signal).then(value => { if (!controller.signal.aborted) setRecommendationContext(value); });
    }
    locate(); setActive(index); setOpen(true);
  }
  function choose(index: number) {
    if (locked || !options[index] || options[index].disabled) return;
    const next = options[index].value;
    if (next === "auto") changeSelection({ mode: "auto" });
    else {
      const model = models.find((entry) => entry.id === next);
      if (!model || !enabled(model, catalog)) return;
      changeSelection({ mode: "explicit", modelId: model.id });
    }
    setOpen(false); trigger.current?.focus();
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (locked) return;
    if (event.key === "Escape") {
      hideDetails();
      if (visible) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
      else if (recommendationShown) { event.preventDefault(); event.stopPropagation(); dismissRecommendation(); }
      return;
    }
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "ArrowRight") {
      if (detailIndex >= 0) { event.preventDefault(); inspect(detailIndex, true, true); }
      return;
    }
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (visible) choose(active); else { show(); inspect(selectedIndex, true); } return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!enabledIndices.length) { show(0); return; }
      if (event.key === "Home") { show(enabledIndices[0]); inspect(enabledIndices[0], true); }
      else if (event.key === "End") { const last = enabledIndices[enabledIndices.length - 1]; show(last); inspect(last, true); }
      else if (!visible) show();
      else {
        const next = enabledIndices[(enabledIndices.indexOf(active) + (event.key === "ArrowDown" ? 1 : -1) + enabledIndices.length) % enabledIndices.length];
        setActive(next); inspect(next, true);
      }
    }
  }
  useEffect(() => {
    if (!visible) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node) && !details.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", locate);
    window.addEventListener("scroll", locate, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", locate); window.removeEventListener("scroll", locate, true); };
  }, [visible]);
  useEffect(() => { if (visible) popup.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" }); }, [visible, active]);
  useEffect(() => {
    if (!recommendationShown) return;
    window.addEventListener("resize", locate);
    window.addEventListener("scroll", locate, true);
    return () => { window.removeEventListener("resize", locate); window.removeEventListener("scroll", locate, true); };
  }, [recommendationShown]);
  useEffect(() => {
    if (!peekId) return;
    const frame = window.requestAnimationFrame(locateDetails);
    if (focusDetails.current) { details.current?.focus(); focusDetails.current = false; }
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node) && !details.current?.contains(event.target as Node)) hideDetails();
    };
    const focusOutside = (event: FocusEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node) && !details.current?.contains(event.target as Node)) hideDetails();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); hideDetails(); }
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("focusin", focusOutside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", locateDetails); window.addEventListener("scroll", locateDetails, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", focusOutside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", locateDetails); window.removeEventListener("scroll", locateDetails, true);
    };
  }, [peekId, visible, detailsPinned, locateDetails, hideDetails]);
  const autoDecision = decision?.reason === "auto_affordable" || decision?.reason === "auto_cache_scenario";
  const relevant = !!decision && !locked && (selection.mode === "auto"
    ? decision.status === "selected" ? autoDecision : decision.modelId === undefined
    : decision.modelId === selection.modelId && !autoDecision);
  const routed = relevant && decision.status === "selected" ? models.find((model) => model.id === decision.modelId) : undefined;
  const quote = relevant && usableQuote(decision.quote, decision.modelId, catalog) ? decision.quote : undefined;
  const alternative = relevant && decision.status === "blocked" && decision.fallback
    ? models.find((model) => model.id === decision.fallback!.modelId) : undefined;
  const alternativeQuote = relevant && decision.status === "blocked" && decision.fallback && alternative && enabled(alternative, catalog) &&
    usableQuote(decision.fallback.quote, alternative.id, catalog) ? decision.fallback.quote : undefined;
  const peekQuote = peekModel && quote?.modelId === peekModel.id ? quote : peekModel && alternativeQuote?.modelId === peekModel.id ? alternativeQuote : undefined;

  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={selectId} className="sr-only">Select model</label>
      <button ref={trigger} id={selectId} value={value} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={visible}
        aria-controls={visible ? listId : undefined} aria-activedescendant={visible && options[active] ? `${listId}-${active}` : undefined}
        disabled={locked} aria-describedby={`${helpId} ${statusId}${recommendationShown ? ` ${recommendationId}` : ""}`} aria-busy={loading || undefined} onKeyDown={keyDown} onClick={() => visible ? setOpen(false) : show()}
        onPointerEnter={event => { if (event.pointerType === "mouse" && (selected || selection.mode === "auto") && !visible && !recommendationShown) inspect(selectedIndex); }} onPointerLeave={leaveDetails}
        onFocus={event => { if (skipDetailsFocus.current) { skipDetailsFocus.current = false; return; } if ((selected || selection.mode === "auto") && !visible && !recommendationShown && event.currentTarget.matches(":focus-visible")) inspect(selectedIndex, true); }}
        className="inline-flex min-h-7 pointer-coarse:min-h-11 max-w-full items-center gap-1.5 rounded-full bg-surface-hover px-[9px] text-[13px] text-fg outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70 disabled:cursor-not-allowed disabled:opacity-50">
        {selected ? <ModelMark provider={selected.provider} /> : selection.mode === "auto" && <ModelMark provider="romanum" />}<span className="min-w-0 truncate">{options[selectedIndex]?.label ?? value}</span><ChevronDown className="size-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
      </button>
      {visible && createPortal(<div ref={popup} id={listId} role="listbox" aria-labelledby={`${listId}-heading`}
        style={{ top: position.top, bottom: position.bottom, left: position.left, width: position.width, maxHeight: position.height }}
        className="fixed z-[100] overflow-hidden rounded-[18px] border border-white/[0.06] bg-[#2b2a2b] p-2 shadow-lg">
        <p id={`${listId}-heading`} className="mb-1 mt-1 px-1 text-xs text-fg-muted">Select model</p>
        <div className="overflow-y-auto overscroll-contain [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/10" style={{ maxHeight: Math.max(0, position.height - 40) }}>
          {options.map((option, index) => <div key={option.value} id={`${listId}-${index}`} role="option" data-index={index} aria-selected={value === option.value} aria-disabled={option.disabled || undefined}
            title={option.disabled ? option.description : undefined}
            onPointerDown={(event) => event.preventDefault()} onPointerMove={() => { if (!option.disabled) setActive(index); }}
            onPointerEnter={event => { if (event.pointerType === "mouse") inspect(index); }} onPointerLeave={leaveDetails}
            onClick={() => { if (option.disabled && window.matchMedia?.("(pointer: coarse)")?.matches) inspect(index, true, true); else choose(index); }}
            className={`flex ${option.value === "auto" ? "min-h-11" : "min-h-7"} pointer-coarse:min-h-11 items-center justify-between gap-3 rounded-lg px-1 ${option.disabled ? "cursor-not-allowed text-fg-muted" : "cursor-pointer text-fg"} ${index === active && option.value !== value && !option.disabled ? "bg-white/[0.04]" : ""}`}>
            <div className="flex min-w-0 items-center gap-2">
              {option.provider ? <ModelMark provider={option.provider} /> : option.value === "auto" ? <ModelMark provider="romanum" /> : <span aria-hidden="true" className="size-4 shrink-0" />}
              <div className="min-w-0"><p className="text-[13px] leading-5">{option.label}</p>{option.description && <p className={option.disabled ? "sr-only" : "text-[11px] leading-4 text-fg-muted"}>{option.description}</p>}</div>
            </div>
            {value === option.value && <Check className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />}
          </div>)}
        </div>
      </div>, document.body)}
      {visible && detailIndex >= 0 && createPortal(<button type="button" tabIndex={-1} aria-label={`About ${options[detailIndex].label}`}
        onPointerDown={event => { event.preventDefault(); event.stopPropagation(); }} onClick={() => inspect(detailIndex, true, true)}
        style={{ left: position.left + position.width - 42, top: (position.top ?? window.innerHeight - (position.bottom ?? 0) - position.height) + (window.matchMedia?.("(pointer: coarse)")?.matches ? -12 : 4) }}
        className="fixed z-[101] inline-flex size-7 pointer-coarse:size-11 cursor-pointer items-center justify-center rounded-full text-fg-muted outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70">
        <Info className="size-3.5 pointer-coarse:translate-y-2.5" aria-hidden="true" />
      </button>, document.body)}
      {(peekModel || peekAuto) && !locked && !recommendationShown && createPortal(<div ref={details} role="dialog" aria-label={`About ${peekAuto ? "Auto" : peekModel!.label}`} tabIndex={-1}
        style={{ ...detailsPosition, maxHeight: Math.max(0, window.innerHeight - (detailsPosition.top ?? 16) - 16) }}
        onPointerEnter={keepDetails} onPointerLeave={leaveDetails} onKeyDown={detailsKeyDown}
        className="fixed z-[110] overflow-y-auto rounded-[18px] border border-white/[0.06] bg-[#2b2a2b] p-3 shadow-lg outline-none">
        <div className="mb-2 flex items-center gap-2">
          <ModelMark provider={peekAuto ? "romanum" : peekModel!.provider} /><h3 className="min-w-0 flex-1 text-[13px] font-normal text-fg">{peekAuto ? "Auto" : peekModel!.label}</h3>
          <button type="button" aria-label="Close model details" onClick={dismissDetails}
            className="-mr-2 inline-flex size-7 pointer-coarse:size-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-muted outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70"><X className="size-3.5" aria-hidden="true" /></button>
        </div>
        {peekAuto ? <div className="space-y-3"><p className="text-xs leading-5 text-fg-muted">Balances model capability with price.</p><AutoModelRange /><p className="text-[11px] leading-4 text-fg-muted">Adapts to the request and enabled models.</p></div>
          : <ModelPreview model={peekModel!} quote={peekQuote} evaluation={evaluations.find(value => value.modelId === peekModel!.id)} />}
      </div>, document.body)}
      {recommendationShown && selection.mode === "explicit" && recommendationContext.subscription === "none" &&
        createPortal(<div role="group" aria-label="Auto recommendation"
          style={{ top: position.top, bottom: position.bottom, left: position.left, width: position.width, maxHeight: position.height }}
          className="fixed z-[100] overflow-y-auto rounded-[18px] border border-white/[0.06] bg-[#2b2a2b] px-3 py-2 shadow-lg" onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismissRecommendation(); }
        }}>
          <div className="flex items-start gap-2">
            <span className="mt-1"><ModelMark provider="romanum" /></span>
            <p id={recommendationId} role="status" aria-live="polite" className="flex-1 py-1 text-xs leading-[18px] text-fg-muted">
              Auto balances model capability with price.
            </p>
            <button type="button" aria-label="Dismiss Auto recommendation" onClick={dismissRecommendation}
              className="-mr-2 -mt-1 inline-flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-muted hover:bg-surface-hover outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70">
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            <button type="button" aria-label={`Keep choice: ${selected?.label ?? selection.modelId}`} onClick={dismissRecommendation}
              className="min-h-11 cursor-pointer rounded-full px-2 text-xs text-fg hover:bg-surface-hover outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70">
              Keep choice
            </button>
            <button type="button" disabled={locked || !hasEnabled} onClick={() => {
              if (!locked && hasEnabled) { changeSelection({ mode: "auto" }); trigger.current?.focus(); }
            }} className="min-h-11 cursor-pointer rounded-full px-2 text-xs text-fg-muted hover:bg-surface-hover outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70 disabled:cursor-not-allowed disabled:opacity-50">
              Use Auto
            </button>
          </div>
        </div>, document.body)}
      <p id={helpId} className={compact ? "sr-only" : "mt-1.5 text-xs leading-5 text-fg-subtle"}>
        {selection.mode === "auto" ? "Auto considers enabled models, your request budget and compatible cache scenarios. Cache savings are not guaranteed."
          : "Your choice is retained. Unavailable models are not replaced automatically."}
        <span className="sr-only"> Press Right Arrow for model details, then Up or Down Arrow to browse models.</span>
      </p>
      <div id={statusId} role="status" aria-live="polite" aria-atomic="true" className={compact && !alternativeQuote ? "sr-only" : "mt-1 text-xs leading-5 text-fg-muted"}>
        {loading ? <p>Loading model options. Your choice is retained.</p>
          : error ? <p>Model options could not be loaded. Your choice is retained.</p>
          : !catalog ? <p>Model options are not available yet.</p>
          : selected && !enabled(selected, catalog) ? <p>{selected.label}: {unavailableReason(selected, catalog)}. Your choice is retained.</p>
          : selection.mode === "explicit" && !selected ? <p>The selected model is unavailable. Choose another model to continue.</p>
          : !hasEnabled ? <p>No supported model is enabled.</p>
          : relevant && decision.status === "selected" && !enabled(routed, catalog) ? <p>The proposed model is no longer enabled. Routing must be checked again.</p>
          : relevant ? <>
            <p>{decision.status === "selected" && routed ? `${routed.label}. ` : ""}{REASONS[decision.reason]}</p>
            {quote ? <>
              <p>Estimated cost: {credits(quote.estimatedCredits)} credits per model call. Reservation ceiling: {credits(quote.reservationCredits)} credits.</p>
              <p>{quote.estimateBasis === "compatible_cache_scenario" ? "Cache scenario estimate; a cache hit is not guaranteed. " : "Estimate assumes uncached input. "}Final charge uses reported usage.</p>
              <p>Tool fees and additional model calls are not included in this estimate.</p>
            </> : <p>Request estimate not available.</p>}
          </> : <p>Request estimate not available.</p>}
        {alternative && alternativeQuote && <button type="button" disabled={locked} onClick={() => {
          if (!locked && enabled(alternative, catalog)) changeSelection({ mode: "explicit", modelId: alternative.id });
        }} className="mt-2 min-h-10 rounded-lg border border-line px-3 text-left text-xs text-fg hover:bg-surface-hover outline-offset-2 focus-visible:outline-2 focus-visible:outline-fg/70 disabled:cursor-not-allowed disabled:opacity-50">
          Choose {alternative.label} instead — estimated {credits(alternativeQuote.estimatedCredits)} credits per model call; reservation ceiling {credits(alternativeQuote.reservationCredits)} credits
        </button>}
      </div>
    </div>
  );
}
