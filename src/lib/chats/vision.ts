import type { ApiMessage } from "../assistant/types.ts";
import { messageText } from "../assistant/message-text.ts";
import { MAX_ATTACHMENTS } from "./limits.ts";

/** Only freshly decoded, owner-supplied uploads are added to this call, never remote URLs or other chats. */
export function withReferenceImages(question: ApiMessage, images: { mimeType: "image/webp"; bytes: Uint8Array }[]): ApiMessage {
  if (question.role !== "user" || images.length > MAX_ATTACHMENTS) throw new Error("Invalid image question.");
  if (!images.length) return question;
  return {
    role: "user",
    content: [
      { type: "text", text: messageText(question) },
      ...images.map((image) => ({ type: "image_url" as const, image_url: { url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`, detail: "high" as const } })),
    ],
  };
}
