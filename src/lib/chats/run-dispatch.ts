import { createHmac, timingSafeEqual } from "node:crypto";
import { secretsKey } from "../secrets.ts";
import { isChatId } from "./store.ts";

const signature = (key: Buffer, id: string, at: number) => createHmac("sha256", key).update(`romanum-chat-run:v1:${id}:${at}`).digest("hex");
export function chatRunDispatchProof(key: Buffer, id: string, at = Date.now()): string {
  if (!isChatId(id)) throw new Error("Invalid run ID.");
  return `${at}.${signature(key, id, at)}`;
}
export function validChatRunDispatch(key: Buffer, id: string, proof: string, now = Date.now()): boolean {
  const match = /^(\d{13})\.([0-9a-f]{64})$/.exec(proof);
  if (!isChatId(id) || !match || Math.abs(now - Number(match[1])) > 300_000) return false;
  return timingSafeEqual(Buffer.from(match[2], "hex"), Buffer.from(signature(key, id, Number(match[1])), "hex"));
}

/** Uses only trusted deployment configuration, never a browser-supplied callback or Host header. */
export const usesBackgroundChatWorker = () => Boolean(process.env.ROMANUM_CHAT_RUN_ORIGIN || process.env.SITE_ID || process.env.NETLIFY === "true");

export async function dispatchChatRun(id: string): Promise<void> {
  const origin = process.env.ROMANUM_CHAT_RUN_ORIGIN || process.env.DEPLOY_URL || process.env.URL || process.env.HISTORY_COLLECTOR_ORIGIN;
  if (!origin) throw new Error("Background review origin is not configured.");
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid review origin.");
  const response = await fetch(new URL("/.netlify/functions/chat-review-background", url), { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/json", "x-romanum-dispatch": chatRunDispatchProof(await secretsKey(), id) }, body: JSON.stringify({ runId: id }) });
  if (response.status !== 202) throw new Error("The review could not start.");
}
