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

/** An answer's price as a number to show beside the coin: "0.23", "<0.01", "1". */
export function creditAmount(credits: number): string {
  if (credits > 0 && credits < 0.01) return "<0.01";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(credits);
}

/** An answer's price in words, for tooltips and screen readers: "0.23 credits", "<0.01 credits", "1 credit". */
export function formatCredits(credits: number): string {
  const amount = creditAmount(credits);
  return `${amount} ${amount === "1" ? "credit" : "credits"}`;
}
