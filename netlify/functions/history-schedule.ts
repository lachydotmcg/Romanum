import { dispatchCollection } from "../../src/lib/history/scheduled.ts";

export default async function historySchedule() {
  try {
    await dispatchCollection();
    console.log("History collector dispatched.");
  } catch {
    // Netlify logs must not include the credential or a raw upstream response.
    throw new Error("History collector dispatch failed. Check its production configuration.");
  }
}

export const config = { schedule: "*/5 * * * *" };
