/**
 * What a question cost, in US dollars, from the token counts the two services report with each reply.
 * A price is a fact about a date, so the page says "about". Per million tokens, as published in September 2026:
 *   Jev 1.13.0 (docs.typesafe.ai/models): $0.042 in, output free.
 *   Claude Haiku 4.5 (Anthropic's price list): $1 in, $5 out.
 */
export const PRICES = { jevInput: 0.042, haikuInput: 1, haikuOutput: 5 };

const usd = (tokens, perMillion) => (tokens * perMillion) / 1e6;
const cents8 = (amount) => Math.round(amount * 1e8) / 1e8;

/** `cost({ jevTokens, haiku: { input, output } })` is { jev, haiku, total }, each in dollars. */
export function cost({ jevTokens = 0, haiku = { input: 0, output: 0 } } = {}) {
  const jev = usd(jevTokens, PRICES.jevInput);
  const words = usd(haiku.input, PRICES.haikuInput) + usd(haiku.output, PRICES.haikuOutput);
  return { jev: cents8(jev), haiku: cents8(words), total: cents8(jev + words) };
}
