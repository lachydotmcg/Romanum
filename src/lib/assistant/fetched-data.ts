import type { ChartColor, MetricKey } from "@/lib/charts/spec";
import { METRIC_KEYS } from "../charts/spec.ts";
import type { ApiMessage } from "./types";
import { isRobloxImageUrl } from "../roblox-icons.ts";

export type GameRecord = { universeId: number; name: string; fetchedAt?: string; iconUrl?: string | null; rootPlaceId?: number } & Partial<Record<MetricKey, number>>;
export const HISTORY_METRICS = ["playing", "visits", "favorites", "likes", "dislikes", "likeRatio"] as const;
export type HistoryMetric = typeof HISTORY_METRICS[number];
export type HistoryRecord = { name: string; points: ({ time: number } & Record<HistoryMetric, number | null>)[] };

/**
 * Everything the tools have fetched in a conversation, keyed by universe ID.
 * Charts resolve their values from here, so a chart can only show numbers a tool returned.
 */
export class FetchedData {
  private games = new Map<number, GameRecord>();
  private histories = new Map<number, HistoryRecord>();
  /** Colours given to games in earlier charts, so a game keeps its colour across charts. */
  readonly colors = new Map<string, ChartColor>();

  static fromMessages(messages: ApiMessage[]): FetchedData {
    const data = new FetchedData();
    for (const message of messages) {
      if (message.role !== "tool" || typeof message.content !== "string") continue;
      try {
        data.add(JSON.parse(message.content));
      } catch {
        // Not JSON, so it holds no data.
      }
    }
    return data;
  }

  /** Records every game object in a tool result, and colours assigned by earlier charts. */
  add(result: unknown) {
    if (!result || typeof result !== "object") return;
    const { games, fetchedAt, chartColors } = result as Record<string, unknown>;
    this.addHistory(result as Record<string, unknown>);
    if (Array.isArray(games)) {
      for (const game of games) this.addGame(game, typeof fetchedAt === "string" ? fetchedAt : undefined);
    }
    if (chartColors && typeof chartColors === "object") {
      for (const [key, color] of Object.entries(chartColors)) {
        if (typeof color === "string") this.colors.set(key, color as ChartColor);
      }
    }
  }

  get(universeId: number): GameRecord | undefined {
    return this.games.get(universeId);
  }

  getHistory(universeId: number): HistoryRecord | undefined {
    return this.histories.get(universeId);
  }

  private addHistory(result: Record<string, unknown>) {
    const { universeId, game, points } = result;
    if (!Number.isSafeInteger(universeId) || (universeId as number) <= 0 || !Array.isArray(points)) return;
    // A later empty/unavailable read must invalidate older history in this conversation.
    this.histories.delete(universeId as number);
    if (result.available !== true || !game || typeof game !== "object" || points.length > 8642) return;
    const metadata = game as Record<string, unknown>;
    if (metadata.universeId !== universeId || typeof metadata.name !== "string") return;
    const rows = new Map<number, HistoryRecord["points"][number]>();
    for (const raw of points) {
      if (!raw || typeof raw !== "object") continue;
      const point = raw as Record<string, unknown>;
      const time = typeof point.observedAt === "string" ? Date.parse(point.observedAt) : NaN;
      if (!Number.isFinite(time)) continue;
      const metric = (key: string) => point.status === "observed" && typeof point[key] === "number" && Number.isFinite(point[key]) && point[key] >= 0 ? point[key] as number : null;
      const likes = metric("likes"), dislikes = metric("dislikes");
      rows.set(time, { time, playing: metric("playing"), visits: metric("visits"), favorites: metric("favorites"), likes, dislikes,
        likeRatio: likes !== null && dislikes !== null && likes + dislikes > 0 ? likes / (likes + dislikes) : null });
    }
    this.histories.set(universeId as number, { name: metadata.name, points: [...rows.values()].sort((a, b) => a.time - b.time) });
  }

  private addGame(value: unknown, fetchedAt?: string) {
    if (!value || typeof value !== "object") return;
    const game = value as Record<string, unknown>;
    if (typeof game.universeId !== "number" || typeof game.name !== "string") return;

    const record: GameRecord = {
      ...this.games.get(game.universeId),
      universeId: game.universeId,
      name: game.name,
      ...(fetchedAt ? { fetchedAt } : {}),
    };
    for (const key of METRIC_KEYS) {
      const metric = game[key];
      if (typeof metric === "number" && Number.isFinite(metric)) record[key] = metric;
    }
    if ("iconUrl" in game) record.iconUrl = isRobloxImageUrl(game.iconUrl) ? game.iconUrl : null;
    if (typeof game.rootPlaceId === "number" && Number.isSafeInteger(game.rootPlaceId) && game.rootPlaceId > 0) record.rootPlaceId = game.rootPlaceId;
    // Search and chart results carry likes and dislikes but no ratio; derive it so it stays current.
    const likes = game.likes;
    const dislikes = game.dislikes;
    if (typeof game.likeRatio !== "number" && typeof likes === "number" && typeof dislikes === "number") {
      if (likes + dislikes > 0) record.likeRatio = likes / (likes + dislikes);
    }
    this.games.set(game.universeId, record);
  }
}
