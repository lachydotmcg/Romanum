import type { ChartColor, MetricKey } from "@/lib/charts/spec";
import { METRIC_KEYS } from "@/lib/charts/spec";
import type { ApiMessage } from "./types";
import { isRobloxImageUrl } from "@/lib/roblox-icons";

export type GameRecord = { universeId: number; name: string; fetchedAt?: string; iconUrl?: string | null; rootPlaceId?: number } & Partial<Record<MetricKey, number>>;

/**
 * Everything the tools have fetched in a conversation, keyed by universe ID.
 * Charts resolve their values from here, so a chart can only show numbers a tool returned.
 */
export class FetchedData {
  private games = new Map<number, GameRecord>();
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
