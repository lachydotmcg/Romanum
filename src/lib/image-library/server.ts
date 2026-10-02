import { readAccount } from "../accounts/session";
import { historyDatabase } from "../history/database.ts";
import { requestOrigin } from "../turnstile";
import { databaseImageLibraryStorage } from "./storage.ts";
import type { ImageLibraryDependencies } from "./http.ts";

export const imageLibraryDependencies: ImageLibraryDependencies = {
  account: readAccount,
  storage: async () => { const database = await historyDatabase(); return database ? databaseImageLibraryStorage(database) : null; },
  origin: requestOrigin,
};
