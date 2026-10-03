import { cookies } from "next/headers";
import { SESSION_COOKIE } from "../accounts/session";
import { sessionAccount } from "../accounts/store";
import { historyDatabase } from "../history/database.ts";
import { requestOrigin } from "../turnstile";
import { databaseImageLibraryStorage } from "./storage.ts";
import type { ImageLibraryDependencies } from "./http.ts";

export const imageLibraryDependencies: ImageLibraryDependencies = {
  // Keep an expired/missing session distinct from a failure to verify its storage.
  account: async () => {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const database = await historyDatabase();
    if (!database) throw new Error("Image library unavailable.");
    return sessionAccount(database, token);
  },
  storage: async () => { const database = await historyDatabase(); return database ? databaseImageLibraryStorage(database) : null; },
  origin: requestOrigin,
};
