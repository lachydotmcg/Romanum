import { buildAdminReport, type AdminProjection } from "./report";

export const FIXTURE_AS_OF = "2026-10-02T04:00:00.000Z";
export type AdminPreviewState = "overview" | "empty" | "unavailable";
export function adminPreviewState(value: unknown): AdminPreviewState {
  return value === "empty" || value === "unavailable" ? value : "overview";
}
export function adminFixtureProjection(): AdminProjection {
  const identities = ["a", "b", "c", "d", "e"];
  const balances = [200, 54, 1200, 0, null];
  const reserved = [0, 3, 120, 0, null];
  const accounts = identities.map((id, index) => ({ id: `fixture-${id}`, ownerId: `fixture:${id}`, username: `fixture_creator_${index + 1}`, displayName: `Example creator ${index + 1}`, createdAt: `2026-09-${String(10 + index * 3).padStart(2, "0")}T12:00:00.000Z`, balance: balances[index], reserved: reserved[index] }));
  const messages: AdminProjection["messages"] = [];
  for (const [ownerId, createdAt] of [["fixture:a", "2026-09-29T12:00:00Z"], ["fixture:c", "2026-09-30T12:00:00Z"], ["fixture:b", "2026-10-01T03:00:00Z"], ["fixture:a", "2026-10-01T06:00:00Z"], ["fixture:b", "2026-10-01T20:00:00Z"], ["guest:fixture", "2026-10-02T01:00:00Z"], ["fixture:a", "2026-10-02T02:00:00Z"]]) {
    messages.push({ ownerId, createdAt, role: "user" }, { ownerId, createdAt, role: "assistant" });
  }
  const ledger: AdminProjection["ledger"] = [
    ["fixture:a", "2026-09-26T12:00:00Z", 11], ["fixture:b", "2026-09-27T12:00:00Z", 24], ["fixture:a", "2026-09-28T12:00:00Z", 15], ["fixture:c", "2026-09-29T12:00:00Z", 40], ["fixture:a", "2026-09-30T12:00:00Z", 18], ["fixture:b", "2026-10-01T02:00:00Z", 10], ["fixture:a", "2026-10-01T06:00:00Z", 12], ["fixture:b", "2026-10-01T20:00:00Z", 8], ["guest:fixture", "2026-10-02T02:00:00Z", 3], ["closed:fixture", "2026-10-02T03:00:00Z", 4],
  ].map(([ownerId, createdAt, amount]) => ({ ownerId: String(ownerId), createdAt: String(createdAt), amount: Number(amount), balanceChange: -Number(amount), entryType: "capture" }));
  ledger.push(
    { ownerId: "fixture:a", createdAt: "2026-10-01T08:00:00Z", entryType: "grant", amount: 200, balanceChange: 200 },
    { ownerId: "fixture:a", createdAt: "2026-10-01T09:00:00Z", entryType: "reserve", amount: 20, balanceChange: 0 },
    { ownerId: "fixture:a", createdAt: "2026-10-01T10:00:00Z", entryType: "release", amount: 20, balanceChange: 0 },
    { ownerId: "fixture:b", createdAt: "2026-10-01T12:00:00Z", entryType: "adjust", amount: 2, balanceChange: 2 },
    { ownerId: "fixture:b", createdAt: "2026-10-01T13:00:00Z", entryType: "adjust", amount: 1, balanceChange: -1 },
  );
  const usage: AdminProjection["usage"] = [
    ["fixture:a", "2026-10-01T06:00:00Z", 70_000_000, 115_500_000, 12], ["fixture:b", "2026-10-01T20:00:00Z", 50_000_000, 82_500_000, 8], ["guest:fixture", "2026-10-02T01:00:00Z", 20_000_000, 33_000_000, 3], ["closed:fixture", "2026-10-02T03:00:00Z", 30_000_000, 49_500_000, 4],
  ].map(([ownerId, createdAt, cost, price, charged]) => ({ ownerId: String(ownerId), createdAt: String(createdAt), costNanoUsd: Number(cost), priceNanoUsd: Number(price), creditsCharged: Number(charged), modelCalls: 1, inputTokens: 2400, outputTokens: 600 }));
  usage.push({ ownerId: "fixture:a", createdAt: "2026-10-01T06:30:00Z", costNanoUsd: 0, priceNanoUsd: 1_200_000, creditsCharged: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0 });
  return { accounts, messages, ledger, usage,
    tools: [{ status: "settled", createdAt: "2026-10-01T06:10:00Z" }, { status: "settled", createdAt: "2026-10-01T06:20:00Z" }, { status: "released", createdAt: "2026-10-01T06:25:00Z" }, { status: "reserved", createdAt: "2026-10-02T03:50:00Z" }],
    runs: [{ status: "complete", finishedAt: "2026-10-01T06:30:00Z" }, { status: "failed", finishedAt: "2026-10-02T02:10:00Z" }, { status: "cancelled", finishedAt: "2026-10-01T22:00:00Z" }],
    insights: [{ costNanoUsd: 10_000_000, finishedAt: "2026-10-01T23:00:00Z" }],
  };
}
export function adminFixtureReport(state: AdminPreviewState = "overview") {
  if (state === "unavailable") return null;
  const projection = state === "empty" ? { accounts: [], messages: [], ledger: [], usage: [], tools: [], runs: [], insights: [] } : adminFixtureProjection();
  return buildAdminReport(projection, FIXTURE_AS_OF);
}
