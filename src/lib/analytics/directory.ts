import { cache } from "react";
import { getMarketData } from "../market-data";
import { publicData } from "../public-data";
import { mergeGameDetails } from "./explorer";

/** Public observations only. Batch metadata rather than making requests per table row. */
export const getGameDirectory = cache(async () => {
  const market = await getMarketData();
  const ids = market.analysis.games.map((game) => game.universeId);
  const batches = [];
  for (let offset = 0; offset < ids.length; offset += 50) batches.push(ids.slice(offset, offset + 50));
  const results = await Promise.allSettled(batches.map((batch) => publicData.stats(batch)));
  const details = results.flatMap((result) => result.status === "fulfilled" ? result.value.games : []);
  return { ...market, games: mergeGameDetails(market.analysis.games, details) };
});
