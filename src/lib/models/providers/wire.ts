import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

/** Strict JSON snapshot: no getters, lossy values, exotic prototypes or cyclic private data. */
export function safeJson(value: unknown, maxBytes: number): string {
  let nodes = 0;
  const ancestors = new Set<object>();
  function walk(item: unknown, depth: number): void {
    if (++nodes > 20_000 || depth > 32) throw new Error("Invalid adapter JSON.");
    if (typeof item === "string") {
      if (Buffer.byteLength(item) > maxBytes) throw new Error("Invalid adapter JSON.");
      return;
    }
    if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return;
    if (!item || typeof item !== "object" || ancestors.has(item) || Object.getOwnPropertySymbols(item).length ||
        (Array.isArray(item) ? Object.getPrototypeOf(item) !== Array.prototype
          : ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) throw new Error("Invalid adapter JSON.");
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === "length") continue;
      if (Array.isArray(item) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) throw new Error("Invalid adapter JSON.");
      if (["__proto__", "constructor", "prototype"].includes(key) || !descriptor.enumerable || !("value" in descriptor)) throw new Error("Invalid adapter JSON.");
      walk(descriptor.value, depth + 1);
    }
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new Error("Invalid adapter JSON.");
    ancestors.delete(item);
  }
  walk(value, 0);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > maxBytes) throw new Error("Invalid adapter JSON.");
  return json;
}

export function freezeWire<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeWire);
    Object.freeze(value);
  }
  return value;
}

/** Exact UTF-8 request bytes plus nonsecret transport/version settings. Never a credential hash. */
export function compileWire<T>(body: T, settings: Record<string, string>, maxBytes: number) {
  const json = safeJson(body, maxBytes);
  const requestHash = createHash("sha256").update(JSON.stringify(["romanum-provider-request-v1", settings, json])).digest("hex");
  return Object.freeze({ body: freezeWire(JSON.parse(json) as T), json, requestHash });
}

export function canonicalTime(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
