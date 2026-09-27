// What a credit is worth, kept free of server imports so the interface can format balances too.

/** One credit is worth one US cent (owner decision, 2026-09-27). */
export const CENTS_PER_CREDIT = 1;

/** "$0.50" for 50 credits. */
export function creditsInDollars(credits: number): string {
  return ((credits * CENTS_PER_CREDIT) / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** "50", "1.2K": short enough to sit under the avatar on the collapsed sidebar. */
export function compactCredits(credits: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(credits);
}
