import { after } from "next/server";
import { historyDatabase } from "@/lib/history/database";
import { refreshInsight } from "./generate";
import type { Insight } from "./store";
import { readCurrentInsight } from "./read";

/**
 * The latest insight to show, and today's date. When today's isn't ready, it starts generating after the
 * response is sent. Null when the database is unavailable.
 */
export async function currentInsight(): Promise<{ insight: Insight | null; today: string } | null> {
  try {
    const database = await historyDatabase();
    if (!database) return null;
    const { insight, today } = await readCurrentInsight(database);
    if (insight?.day !== today) after(() => refreshInsight(database));
    return { insight, today };
  } catch {
    return null;
  }
}
