export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";
export type ImageRequest = {
  prompt: string;
  size: ImageSize;
  quality: "low" | "medium" | "high";
  transparent: boolean;
  references: { bytes: Uint8Array; mimeType: "image/png" }[];
};
export type ImageResult = {
  bytes: Uint8Array;
  mimeType: "image/png";
  requestId?: string;
};
export interface ImageProvider {
  readonly id: string;
  readonly model: string;
  readonly mode: "test" | "paid";
  readonly available: boolean;
  generate(request: ImageRequest): Promise<ImageResult>;
}

// An ambiguous provider/network failure must never be retried automatically:
// the upstream request may have run even if its response was lost.
export class ImageProviderError extends Error {
  readonly code: "disabled" | "rejected" | "uncertain";
  constructor(code: ImageProviderError["code"]) {
    super(code === "disabled" ? "Image generation is unavailable." : code === "rejected" ? "Image generation could not be completed." : "Image generation needs reconciliation.");
    this.name = "ImageProviderError";
    this.code = code;
  }
}

// Bounded PNG envelope validation before storing or forwarding image bytes.
// This is not a decoder or a moderation check. Public uploads need both before release.
export function inspectPng(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 45 || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("Invalid image size.");
  const buffer = Buffer.from(bytes);
  if (!buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || buffer.toString("ascii", 12, 16) !== "IHDR" || buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", buffer.length - 8, buffer.length - 4) !== "IEND") throw new Error("Invalid PNG envelope.");
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 8_388_608) throw new Error("Invalid image dimensions.");
  return { width, height };
}
