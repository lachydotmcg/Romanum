import { cache } from "react";
import { publicData } from "./public-data";

export { MARKET_CHARTS } from "./public-data";

// Share assembly within a render; the same timed observations also serve the assistant and MCP.
export const getMarketData = cache(() => publicData.market());
