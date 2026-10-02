"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ModelsResponse, ModelSelection } from "@/lib/models/types";

/** UI readiness is advisory. Submission and every provider attempt recheck on the server. */
export function selectionEnabled(catalog: ModelsResponse | null, selection: ModelSelection): boolean {
  if (!catalog) return false;
  const ready = catalog.models.filter(model => model.id === model.modelId && model.rateCardVersion === catalog.rateCardVersion &&
    model.configured && model.adapterSupported && model.executionEnabled && model.selectable && model.reason === "ready" &&
    catalog.models.filter(entry => entry.id === model.id).length === 1);
  return selection.mode === "auto" ? ready.length > 0 : ready.some(model => model.id === selection.modelId);
}

/** Per-composer controlled selection. Refreshes and server failures never substitute an explicit choice. */
export function useModelCatalog(initialSelection: ModelSelection = { mode: "auto" }) {
  const [selection, setSelection] = useState<ModelSelection>(initialSelection);
  const [catalog, setCatalog] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoading(true);
    try {
      const response = await fetch("/api/models", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Model catalog unavailable.");
      const value = await response.json() as ModelsResponse;
      if (!value || typeof value.rateCardVersion !== "string" || !Array.isArray(value.models)) throw new Error("Invalid catalog.");
      if (!controller.signal.aborted) { setCatalog(value); setError(null); }
    } catch {
      if (!controller.signal.aborted) setError("Model options could not be loaded.");
    } finally {
      if (active.current === controller && !controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => { if (mounted) void refresh(); });
    const focused = () => { void refresh(); };
    window.addEventListener("focus", focused);
    return () => { mounted = false; active.current?.abort(); window.removeEventListener("focus", focused); };
  }, [refresh]);
  return { selection, setSelection, catalog, loading, error, refresh,
    canSend: !loading && !error && selectionEnabled(catalog, selection) };
}
