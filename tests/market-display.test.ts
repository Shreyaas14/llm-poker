import test from "node:test";
import assert from "node:assert/strict";
import { sharesAtQuote } from "../lib/market-display.ts";
import type { MarketBookView, PublicOrder } from "../lib/market.ts";

const book: MarketBookView = {
  outcome: 0, bids: [{ price: .3, quantity: 40 }], asks: [{ price: .4, quantity: 25 }, { price: .5, quantity: 100 }],
  bestBid: .3, bestAsk: .4, midpoint: .35, lastPrice: null, volume: 0,
};
const order = (patch: Partial<PublicOrder>): PublicOrder => ({
  id: "test", outcome: 0, side: "sell", quantity: 10, remainingQuantity: 6, limitPrice: .4, createdAt: 0, ...patch,
});

test("quote availability uses ask shares for buying and bid shares for selling", () => {
  assert.equal(sharesAtQuote(book, [], "buy"), 25);
  assert.equal(sharesAtQuote(book, [], "sell"), 40);
});
test("quote availability excludes only own remaining orders on the matching side, price and outcome", () => {
  const orders = [order({}), order({ outcome: 1 }), order({ limitPrice: .5 }), order({ side: "buy", limitPrice: .3, remainingQuantity: 9 })];
  assert.equal(sharesAtQuote(book, orders, "buy"), 19);
  assert.equal(sharesAtQuote(book, orders, "sell"), 31);
});
test("unavailable and self-only quotes have no tradable shares", () => {
  assert.equal(sharesAtQuote(undefined, [], "buy"), 0);
  assert.equal(sharesAtQuote({ ...book, bestAsk: null }, [], "buy"), 0);
  assert.equal(sharesAtQuote(book, [order({ remainingQuantity: 25 })], "buy"), 0);
});
