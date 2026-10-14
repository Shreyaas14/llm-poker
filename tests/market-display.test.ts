import test from "node:test";
import assert from "node:assert/strict";
import { marketPriceDisplay, sharesAtQuote } from "../lib/market-display.ts";
import type { MarketView, MarketBookView, PublicOrder } from "../lib/market.ts";

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


const legacyMarket = (): Pick<MarketView, 'tick'|'status'|'books'|'history'|'payouts'> => ({
  tick: 63, status: 'open', books: [0,1,2,3].map(outcome=>({...book,outcome,midpoint:.25})),
  history: [{tick:58,prices:[.25,.29,null,.28]},{tick:63,prices:[.25,.29,null,.28]}], payouts:null,
});
test("current market marks exclude folds without rewriting valid earlier prices",()=>{
  const market=legacyMarket(),before=structuredClone(market);
  const display=marketPriceDisplay(market,[true,true,false,false]);
  assert.deepEqual(display.current,[.25,.25,0,0]);
  assert.deepEqual(display.history.at(-1)!.prices,[.25,.25,0,0]);
  assert.equal(display.history[0].prices[3],.28,'past marks remain intact before the fold');
  assert.deepEqual(market,before,'display correction never changes saved trade prices');
});
test("current marks extend stale history at the actual tick without inventing elapsed time",()=>{
  const market=legacyMarket();market.history.pop();
  const display=marketPriceDisplay(market,[true,true,false,false]);
  assert.equal(display.history.at(-1)!.tick,63);
  assert.deepEqual(display.history.at(-1)!.prices,[.25,.25,0,0]);
  market.books[0].midpoint=.7;
  assert.equal(marketPriceDisplay(market,[true,true,false,false]).current[0],.7,'current endpoint follows fresh quotes');
});
test("settled market display shows tied payouts rather than stale last trades",()=>{
  const market=legacyMarket();market.status='settled';market.payouts=[.5,.5,0,0];
  const display=marketPriceDisplay(market,[true,true,false,false]);
  assert.deepEqual(display.current,[.5,.5,0,0]);
  assert.deepEqual(display.history.at(-1)!.prices,[.5,.5,0,0]);
});
