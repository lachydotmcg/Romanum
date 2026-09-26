import OpenAI, { toFile, type ClientOptions } from "openai";
import {
  ImageProviderError,
  MAX_IMAGE_BYTES,
  inspectPng,
  type ImageProvider,
  type ImageRequest,
  type ImageResult,
} from "./image-provider.ts";

// Paid adapter for OpenAI's GPT Image models.
// Reference: https://developers.openai.com/api/docs/guides/image-generation
//
// This adapter reads no environment variables and has no default model: it is
// unavailable until a caller supplies a model and key explicitly. It never
// retries, never follows a returned URL and never logs a prompt, key or byte.

/** Deadline for one image request, in milliseconds. */
export const OPENAI_IMAGE_REQUEST_TIMEOUT_MS = 180_000;

/** GPT Image prompt limit, per the reference above. */
const MAX_PROMPT_CHARS = 32_000;

/** Reference images this adapter accepts per request. */
const MAX_REFERENCES = 4;

/** Most base64 characters a MAX_IMAGE_BYTES payload can occupy, checked before decoding. */
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

/** Longest upstream request ID worth keeping; anything else is dropped. */
const MAX_REQUEST_ID_CHARS = 128;

// DALL-E is refused: the contract always asks for PNG output and reference
// editing, and the DALL-E generation/edit flags for both differ from GPT Image.
const SUPPORTED_MODEL = /^gpt-image-[a-z0-9][a-z0-9.-]*$/;

// Definitive API rejections. Every other failure (transport, 429, 5xx,
// malformed output) is uncertain: the upstream call may have completed and billed.
const REJECTED_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Response shape this adapter reads; `_request_id` is attached by the SDK. */
export type OpenAIImageResponse = OpenAI.ImagesResponse & { _request_id?: string | null };

/** Per-request options, applied to injected clients too, that forbid retries. */
export type OpenAIImageCallOptions = { maxRetries: number; timeout: number };

/** The slice of the SDK client this adapter uses. Injected test doubles match it. */
export type OpenAIImageClient = {
  images: {
    generate(body: OpenAI.ImageGenerateParamsNonStreaming, options: OpenAIImageCallOptions): Promise<OpenAIImageResponse>;
    edit(body: OpenAI.ImageEditParamsNonStreaming, options: OpenAIImageCallOptions): Promise<OpenAIImageResponse>;
  };
};

export type OpenAIImageProviderOptions = { enabled?: boolean; apiKey?: string; model?: string };

export type OpenAIImageProviderInjection = {
  client?: OpenAIImageClient;
  createClient?: () => OpenAIImageClient;
};

/** Client options: zero retries and a bounded deadline, so a lost response cannot double-bill. */
export function openAIImageClientOptions(apiKey: string): ClientOptions {
  return { apiKey, maxRetries: 0, timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS };
}

export function createOpenAIImageProvider(
  options: OpenAIImageProviderOptions = {},
  injection: OpenAIImageProviderInjection = {},
): ImageProvider {
  const model = typeof options.model === "string" ? options.model.trim() : "";
  const apiKey = typeof options.apiKey === "string" ? options.apiKey : "";
  const available = options.enabled === true && apiKey.trim().length > 0 && SUPPORTED_MODEL.test(model);

  let client: OpenAIImageClient | undefined;
  const sdk = () => {
    if (!client) client = injection.client ?? injection.createClient?.() ?? new OpenAI(openAIImageClientOptions(apiKey));
    return client;
  };

  const generate = async (request: ImageRequest): Promise<ImageResult> => {
    // An unavailable provider rejects before any client is built or any request is made.
    if (!available) throw new ImageProviderError("disabled");

    const prompt = validPrompt(request.prompt);
    const references = validReferences(request.references);
    const params = {
      model,
      prompt,
      n: 1,
      size: request.size,
      quality: request.quality,
      output_format: "png" as const,
      background: request.transparent ? ("transparent" as const) : ("opaque" as const),
    };
    const callOptions: OpenAIImageCallOptions = { maxRetries: 0, timeout: OPENAI_IMAGE_REQUEST_TIMEOUT_MS };

    let response: OpenAIImageResponse;
    try {
      response = references.length
        ? await sdk().images.edit({ ...params, image: await referenceFiles(references) }, callOptions)
        : await sdk().images.generate(params, callOptions);
    } catch (error) {
      throw new ImageProviderError(failureCode(error));
    }
    return readImage(response);
  };

  return { id: "openai", model, mode: "paid", available, generate };
}

const validPrompt = (prompt: unknown): string => {
  if (typeof prompt !== "string" || prompt.trim().length === 0 || prompt.length > MAX_PROMPT_CHARS) {
    throw new ImageProviderError("rejected");
  }
  return prompt;
};

const validReferences = (references: unknown): Uint8Array[] => {
  if (!Array.isArray(references) || references.length > MAX_REFERENCES) throw new ImageProviderError("rejected");
  return references.map((reference) => {
    const bytes = (reference as { bytes?: unknown } | undefined)?.bytes;
    if (!(bytes instanceof Uint8Array)) throw new ImageProviderError("rejected");
    try {
      inspectPng(bytes);
    } catch {
      throw new ImageProviderError("rejected");
    }
    return bytes;
  });
};

// References travel as PNG file parts, never as base64 or a URL.
const referenceFiles = (references: Uint8Array[]) =>
  Promise.all(references.map((bytes, index) => toFile(bytes, `reference-${index + 1}.png`, { type: "image/png" })));

const readImage = (response: OpenAIImageResponse): ImageResult => {
  const entry = Array.isArray(response?.data) ? response.data[0] : undefined;
  const encoded = typeof entry?.b64_json === "string" ? entry.b64_json : undefined;
  // Missing or URL-only output is never fetched: it cannot be validated or stored.
  if (!encoded) throw new ImageProviderError("uncertain");

  const bytes = decodePng(encoded);
  const requestId = safeRequestId(response?._request_id);
  return requestId ? { bytes, mimeType: "image/png", requestId } : { bytes, mimeType: "image/png" };
};

const decodePng = (encoded: string): Uint8Array => {
  // Bound the encoded length before decoding so an oversized response cannot be buffered.
  if (encoded.length === 0 || encoded.length > MAX_BASE64_CHARS || encoded.length % 4 !== 0 || !BASE64.test(encoded)) {
    throw new ImageProviderError("uncertain");
  }
  try {
    const bytes = new Uint8Array(Buffer.from(encoded, "base64"));
    inspectPng(bytes);
    return bytes;
  } catch {
    throw new ImageProviderError("uncertain");
  }
};

const safeRequestId = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REQUEST_ID_CHARS) return undefined;
  return /^[\x20-\x7e]+$/.test(value) ? value : undefined;
};

const failureCode = (error: unknown): "rejected" | "uncertain" => {
  const status = typeof error === "object" && error !== null ? (error as { status?: unknown }).status : undefined;
  return typeof status === "number" && REJECTED_STATUS_CODES.has(status) ? "rejected" : "uncertain";
};
