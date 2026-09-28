import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";

// Assemble locally: no duplicate export containing private data is stored on
// the server. Pages/chunks stay below serverless response limits. The archive
// is published only after every requested file has arrived successfully.
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 50_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
type Image = { kind: "chat" | "creative"; id: string; mime: string; size: number };
type Options = { signal: AbortSignal; includeImages: boolean; progress?: (message: string) => void; fetch?: typeof fetch };

export async function buildAccountArchive(options: Options): Promise<Blob> {
  const startedAt = new Date().toISOString();
  const fetcher = options.fetch ?? fetch;
  let account: string | null = null;
  let files = 0, archiveBytes = 0;
  const chunks: BlobPart[] = [];
  let zipError: Error | null = null, finished = false;
  const zip = new Zip((error, bytes, final) => {
    if (error) { zipError = error; return; }
    archiveBytes += bytes.length;
    if (archiveBytes > MAX_ARCHIVE_BYTES) { zipError = new Error("This download exceeds 128 MB. Try without images."); return; }
    chunks.push(new Uint8Array(bytes));
    finished = final;
  });
  const check = () => { options.signal.throwIfAborted(); if (zipError) throw zipError; };
  const add = (name: string, compress: boolean) => {
    check();
    if (++files > MAX_FILES) throw new Error("This download contains too many files.");
    const file = compress ? new ZipDeflate(name, { level: 1 }) : new ZipPassThrough(name);
    zip.add(file);
    return file;
  };
  const jsonFile = (name: string, data: unknown) => {
    add(name, true).push(strToU8(JSON.stringify(data, null, 2)), true);
    check();
  };
  async function request(params: URLSearchParams) {
    check();
    const response = await fetcher(`/api/account/export?${params}`, {
      credentials: "same-origin", cache: "no-store", redirect: "error",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]),
      headers: account ? { "X-Romanum-Export-Account": account } : {},
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("The download was interrupted. Try again.");
    const parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("A record exceeds the download limit."); }
        parts.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.length; }
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: "Sign in to download your data.", 409: "Your account changed. Start the download again.",
        404: "Your data changed during the download. Try again.", 413: "A record exceeds the download limit.",
      };
      throw new Error(messages[response.status] ?? "Data unavailable. Try again later.");
    }
    const identity = response.headers.get("x-romanum-export-account");
    if (!identity || !UUID.test(identity) || (account && account !== identity)) throw new Error("Your account changed. Start the download again.");
    account = identity;
    check();
    return { response, bytes };
  }
  const json = async (params: URLSearchParams) => JSON.parse(new TextDecoder().decode((await request(params)).bytes));

  try {
    options.progress?.("Preparing download…");
    const manifest = await json(new URLSearchParams());
    if (manifest.format !== "romanum-data-v1" || !Array.isArray(manifest.sections) || manifest.sections.length > 40 ||
      !manifest.sections.every((section: unknown) => typeof section === "string" && /^[a-z_]{1,40}$/.test(section)) ||
      new Set(manifest.sections).size !== manifest.sections.length) throw new Error("Invalid export format.");
    const images: Image[] = [];
    const inventory: { section: string; pages: number; records: number }[] = [];
    for (const section of manifest.sections as string[]) {
      let after: string | null = null, pageNumber = 0, recordCount = 0;
      const cursors = new Set<string>();
      do {
        options.progress?.(`Collecting data (${inventory.length + 1}/${manifest.sections.length})…`);
        const params = new URLSearchParams({ section });
        if (after) params.set("after", after);
        const page = await json(params);
        if (page.section !== section || !Array.isArray(page.records) || page.records.length > 100 ||
          !(page.nextCursor === null || typeof page.nextCursor === "string" && page.nextCursor.length > 0 && page.nextCursor.length <= 2048)) throw new Error("Invalid export page.");
        recordCount += page.records.length;
        jsonFile(`records/${section}/${String(++pageNumber).padStart(5, "0")}.json`, page.records);
        if (options.includeImages && (section === "chat_attachments" || section === "creative_assets")) {
          for (const image of page.records) {
            if (!image || !UUID.test(image.id) || !EXTENSIONS[image.mime_type] || !Number.isInteger(image.byte_length) || image.byte_length < 1 || image.byte_length > 10 * 1024 * 1024) throw new Error("Invalid image record.");
            images.push({ kind: section === "chat_attachments" ? "chat" : "creative", id: image.id, mime: image.mime_type, size: image.byte_length });
            if (images.length > MAX_FILES) throw new Error("This download contains too many images.");
          }
        }
        after = page.nextCursor;
        if (after && cursors.has(after)) throw new Error("The download stopped advancing. Try again.");
        if (after) cursors.add(after);
      } while (after);
      inventory.push({ section, pages: pageNumber, records: recordCount });
    }
    const imageIds = new Set<string>();
    for (const [index, image] of images.entries()) {
      options.progress?.(`Collecting images (${index + 1}/${images.length})…`);
      const path = `images/${image.kind}/${image.id}.${EXTENSIONS[image.mime]}`;
      if (imageIds.has(path)) throw new Error("Duplicate image record.");
      imageIds.add(path);
      const file = add(path, false);
      let offset = 0;
      while (offset < image.size) {
        const { response, bytes } = await request(new URLSearchParams({ image: image.kind, id: image.id, offset: String(offset) }));
        const end = offset + bytes.length;
        const next = response.headers.get("x-next-offset");
        if (response.headers.get("x-image-type") !== image.mime || Number(response.headers.get("x-image-bytes")) !== image.size ||
          bytes.length < 1 || bytes.length > 512 * 1024 || end > image.size || next !== (end === image.size ? "done" : String(end))) throw new Error("The image download was interrupted. Try again.");
        file.push(bytes, end === image.size);
        offset = end;
        check();
      }
    }
    jsonFile("manifest.json", { format: manifest.format, accountId: account, startedAt, finishedAt: new Date().toISOString(), includeImages: options.includeImages, inventory, imageCount: images.length });
    add("README.txt", true).push(strToU8(
      "Romanum account data\n\n" +
      "records/ contains JSON pages. Read all pages within a section for its records.\n" +
      "images/ contains stored chat and project images when selected. Uploaded images may have been resized and stripped of metadata; these are the stored copies.\n" +
      "Account data is read in pages during the period in manifest.json, not from a frozen database snapshot. Changes made during the download may affect the result.\n" +
      "Credentials, session tokens and internal security or operator identifiers are excluded. This archive does not include public Roblox datasets, hosting/provider logs or copies separately held by third parties.\n" +
      "Credit units and nano-USD fields retain their stored precision. Some IDs and large numbers are strings.\n" +
      "Downloading does not delete or change your data.\n"
    ), true);
    zip.end(); check();
    if (!finished) throw new Error("The download did not finish. Try again.");
    return new Blob(chunks, { type: "application/zip" });
  } catch (error) {
    zip.terminate();
    chunks.length = 0;
    throw error;
  }
}
