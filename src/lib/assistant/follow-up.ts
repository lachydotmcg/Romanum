import type OpenAI from "openai";

const PROMPT = `You write the next message a Roblox developer is most likely to send after reading an assistant's answer.
- Write it the way they would type it: plain, specific, under 10 words.
- If the answer ends by offering more (like "Want the numbers behind this?"), ask for exactly that as a direct request, not a bare yes (for example "Show me the numbers behind these", "Why is Brookhaven ahead?" or "Show me the full design for Scrap Beast").
- Otherwise ask the most useful next question about the same topic.
- Reply with the message only: no quotes, no preamble.`;

const QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g;

/**
 * Predicts the user's likely next question, offered as a suggestion they can accept with Tab.
 * Optional by design: any failure returns a null suggestion and the answer stands on its own. The call's token
 * usage comes back too, so it can be charged with the answer.
 */
export async function suggestFollowUp(
  client: OpenAI,
  model: string,
  question: string,
  answer: string,
  signal: AbortSignal,
): Promise<{ text: string | null; usage: OpenAI.CompletionUsage | null }> {
  if (!answer.trim()) return { text: null, usage: null };
  // DeepSeek-specific: a one-line prediction doesn't need its reasoning mode.
  const params = {
    model,
    max_tokens: 40,
    thinking: { type: "disabled" },
    messages: [
      { role: "system", content: PROMPT },
      { role: "user", content: `Question:\n${question.slice(0, 1000)}\n\nAnswer:\n${answer.slice(0, 4000)}` },
    ],
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

  try {
    const completion = await client.chat.completions.create(params, { signal, timeout: 8000, maxRetries: 0 });
    const line = (completion.choices[0]?.message?.content ?? "").split("\n").map((part) => part.trim()).find(Boolean);
    const text = line?.replace(QUOTES, "").trim();
    return { text: text && text.length <= 90 ? text : null, usage: completion.usage ?? null };
  } catch {
    return { text: null, usage: null };
  }
}
