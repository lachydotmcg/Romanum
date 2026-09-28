import sharp from "sharp";
import { MAX_ATTACHMENT_BYTES } from "./limits.ts";

const MAX_INPUT_PIXELS = 16_000_000;
const MAX_INPUT_DIMENSION = 8192;
const MAX_OUTPUT_DIMENSION = 1600;

export class ImageInputError extends Error {
  constructor() {
    super("Use a still PNG, JPEG or WebP image, up to 5 MB and 16 megapixels.");
    this.name = "ImageInputError";
  }
}

/** Decode untrusted uploads before storage or model input; never forward originals or metadata. */
export async function normalizeChatImage(bytes: Uint8Array): Promise<{ bytes: Uint8Array; mimeType: "image/webp" }> {
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new ImageInputError();
  const prefix = Buffer.from(bytes.subarray(0, 12));
  const raster = prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255) ||
    (prefix.toString("ascii", 0, 4) === "RIFF" && prefix.toString("ascii", 8, 12) === "WEBP");
  if (!raster) throw new ImageInputError();
  try {
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: MAX_INPUT_PIXELS });
    const metadata = await image.metadata();
    if (!metadata.format || !["png", "jpeg", "webp"].includes(metadata.format) || (metadata.pages ?? 1) !== 1 ||
        !metadata.width || !metadata.height || metadata.width > MAX_INPUT_DIMENSION || metadata.height > MAX_INPUT_DIMENSION) {
      throw new ImageInputError();
    }
    // Sharp drops EXIF/XMP/ICC by default. Auto-orient before discarding EXIF;
    // bound the output size while preserving transparency for UI references.
    const output = await image.rotate().resize(MAX_OUTPUT_DIMENSION, MAX_OUTPUT_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90, effort: 2 }).timeout({ seconds: 5 }).toBuffer();
    if (output.length > MAX_ATTACHMENT_BYTES) throw new ImageInputError();
    return { bytes: output, mimeType: "image/webp" };
  } catch {
    // Decoder messages may contain metadata from the upload. Don't expose them.
    throw new ImageInputError();
  }
}
