import type { ApiMessage } from "./types.ts";

/** Text only: follow-up prompts and persisted history must not copy inline image bytes. */
export function messageText(message: Pick<ApiMessage, "content"> | undefined): string {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
