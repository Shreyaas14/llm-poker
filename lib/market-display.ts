import type { MarketBookView, PublicOrder, Side } from "./market.ts";

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
