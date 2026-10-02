export type ImageKind = "thumbnail" | "ui" | "other";
export type ImageStage = "concept" | "final" | "asset";
export type ImageLibraryQuery = {
  q: string;
  kind: "all" | ImageKind;
  stage: "all" | ImageStage;
  projectId: string | null;
  limit: number;
  after: { createdAt: string; id: string } | null;
};
export type LibraryImage = {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  createdAt: string;
  width: number;
  height: number;
  byteLength: number;
  generation: {
    kind: ImageKind;
    stage: ImageStage | null;
    provider: string | null;
    model: string | null;
    mode: "test" | "paid" | null;
  };
};
export type LibraryImageDetail = LibraryImage & { prompt: string | null; promptTruncated: boolean };
export type ImageLibraryPage = { images: LibraryImage[]; nextCursor: string | null };
export type ImageFile =
  | { status: "ready"; bytes: Uint8Array; mimeType: "image/png" }
  | { status: "missing" | "expired" };

/** Read-only private storage. Every method must enforce owner AND parent ownership.
 * Expiry is an adapter outcome, never an invented TTL for persisted database assets.
 */
export interface ImageLibraryStorage {
  list(ownerId: string, query: ImageLibraryQuery): Promise<ImageLibraryPage>;
  detail(ownerId: string, id: string): Promise<LibraryImageDetail | null>;
  file(ownerId: string, id: string): Promise<ImageFile>;
}
