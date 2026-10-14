import type { MarketView, MarketBookView, PublicOrder, Side } from "./market.ts";

/** Shares a user can trade at the displayed quote, excluding their own orders. */
export function sharesAtQuote(book: MarketBookView | undefined, orders: PublicOrder[], side: Side): number {
  if (!book) return 0;
  const quote = side === "buy" ? book.bestAsk : book.bestBid;
  if (quote == null) return 0;
  const depth = side === "buy" ? book.asks : book.bids;
  const ownShares = orders.reduce((sum, order) => sum + (
    order.outcome === book.outcome && order.side !== side && order.limitPrice === quote
      ? order.remainingQuantity : 0
  ), 0);
  return Math.max(0, (depth.find(level => level.price === quote)?.quantity ?? 0) - ownShares);
}


/** A folded contract is worth zero now, even if its last execution was nonzero.
 * Keep earlier chart points and actual last-trade prices intact. */
export function marketPriceDisplay(
  market: Pick<MarketView, 'tick' | 'status' | 'books' | 'history' | 'payouts'>,
  eligible: readonly boolean[],
): { current: (number | null)[]; history: { tick: number; prices: (number | null)[] }[] } {
  const current = market.books.map((book, i) => market.status === 'settled' ? market.payouts?.[i] ?? null
    : eligible[i] ? book.midpoint ?? book.lastPrice : 0);
  const history = market.history.map(point => ({ tick: point.tick, prices: [...point.prices] }));
  const endpoint = { tick: market.tick, prices: [...current] };
  if (history.at(-1)?.tick === market.tick) history[history.length - 1] = endpoint;
  else history.push(endpoint);
  return { current, history };
}
