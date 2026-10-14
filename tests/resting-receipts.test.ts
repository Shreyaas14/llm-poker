import test from "node:test";
import assert from "node:assert/strict";
import { commandGame, TRADING_WINDOW_MS } from "../lib/game.ts";
import type { Game } from "../lib/game.ts";
import { createHand } from "../lib/poker.ts";
import { advanceMarket, createMarket, getMarketView, replaceTraderOrders, UNITS_PER_CREDIT } from "../lib/market.ts";
import { finishMarketRound, prepareMarketRound, reserveMarketRound } from "../lib/market-agents.ts";

const NOW = Date.UTC(2026, 9, 14, 12);
function fixture(): Game {
  const poker = createHand(42, 0, 1000), values = [.25, .25, .25, .25];
  const market = createMarket(values, 44);
  market.orders = []; market.fills = []; market.traders = [];
  return { rulesVersion: "river-1", id: "resting-receipts", mode: "live", ranked: false,
    rankEligible: true, hand: 1, poker, values, market, models: ["test", "test", "test", "test"],
    results: [], activity: [], sequence: 0, version: 0, cashBefore: 1000,
    eventUntil: NOW + TRADING_WINDOW_MS, lastTickAt: NOW, requestIds: [], createdAt: NOW,
    notice: null, providerCalls: 0 };
}
const receipt = (game: Game) => game.activity.filter(event => event.kind === "trade").at(-1)?.text;

async function restingSell(quantity = 5): Promise<Game> {
  let game = fixture();
  const dealer = game.market.accounts["trader-1"];
  game.market.orders.push({ id: "fixture-ask", owner: dealer.id, outcome: 1, side: "sell",
    priceTicks: 25, quantity: 10, remaining: 10, sequence: ++game.market.sequence,
    createdAt: 0, expiresAt: null });
  game = await commandGame(game, { type: "order", pokerRevision: game.poker.revision,
    outcome: 1, side: "buy", quantity: 10, limitPrice: .25, orderType: "ioc" }, NOW);
  game = await commandGame(game, { type: "order", pokerRevision: game.poker.revision,
    outcome: 1, side: "sell", quantity, limitPrice: .29, orderType: "limit" }, NOW);
  return game;
}
function enableBuyer(game: Game, funding: number) {
  // A funded maker who believes Claude wins will cross the human's 29¢ ask.
  // Move funds between accounts to preserve conservation in this fixture.
  const buyer = game.market.accounts["trader-0"], reserve = game.market.accounts["trader-2"];
  reserve.cashUnits += buyer.cashUnits - funding * UNITS_PER_CREDIT;
  buyer.cashUnits = funding * UNITS_PER_CREDIT;
  game.market.values = [0, 1, 0, 0];
  game.market.traders = [{ id: buyer.id, kind: "maker", bias: [0, 0, 0, 0], beliefs: [0, 1, 0, 0],
    reaction: 2, nextWake: game.market.tick + 1, seenRevision: game.market.revision }];
}

test("a delayed full fill replaces No fill with executed shares, proceeds, and no open remainder", async () => {
  let game = await restingSell();
  assert.match(receipt(game)!, /^No fill: 0 of 5 Claude/);
  const previousCash = getMarketView(game.market).cash;
  enableBuyer(game, 10);
  game = await commandGame(game, { type: "tick" }, NOW + 1000);
  assert.equal(receipt(game), "Sold 5 Claude shares at 29.0¢ from a resting order. Received $1.45. All 5 shares filled. No shares remain open on this order.");
  assert.equal(getMarketView(game.market).positions[1].quantity, 5);
  assert.equal(getMarketView(game.market).cash, previousCash + 1.45);
  assert.equal(getMarketView(game.market).openOrders.length, 0);
  const repeated = await commandGame(game, { type: "tick" }, NOW + 1000);
  assert.deepEqual(repeated.activity, game.activity, "repeat reads do not duplicate executions");
});

test("delayed partial and final fills show exact new proceeds and cumulative remaining size", async () => {
  let game = await restingSell();
  enableBuyer(game, 1);
  game = await commandGame(game, { type: "tick" }, NOW + 1000);
  assert.equal(receipt(game), "Sold 1 Claude shares at 29.0¢ from a resting order. Received $0.29. 1 of 5 filled; 4 shares remain open at 29¢.");
  assert.equal(getMarketView(game.market).openOrders[0].remainingQuantity, 4);
  enableBuyer(game, 10);
  game = await commandGame(game, { type: "tick" }, NOW + 2000);
  assert.equal(receipt(game), "Sold 4 Claude shares at 29.0¢ from a resting order. Received $1.16. All 5 shares filled. No shares remain open on this order.");
  assert.equal(getMarketView(game.market).positions[1].quantity, 5);
});

test("a resting buy receipt records cash paid and newly acquired shares", async () => {
  let game = fixture();
  game = await commandGame(game, { type: "order", pokerRevision: game.poker.revision,
    outcome: 1, side: "buy", quantity: 5, limitPrice: .29, orderType: "limit" }, NOW);
  game.market.values = [.97, .01, .01, .01];
  game.market.traders = [{ id: "trader-0", kind: "maker", bias: [0, 0, 0, 0], beliefs: [...game.market.values],
    reaction: 2, nextWake: 1, seenRevision: game.market.revision }];
  game = await commandGame(game, { type: "tick" }, NOW + 1000);
  assert.equal(receipt(game), "Bought 5 Claude shares at 29.0¢ from a resting order. Paid $1.45. All 5 shares filled. No shares remain open on this order.");
  assert.equal(getMarketView(game.market).cash, 998.55);
  assert.equal(getMarketView(game.market).positions[1].quantity, 5);
  assert.equal(getMarketView(game.market).reservedCash, 0);
});

test("cancellation racing a fill retains the fill receipt rather than claiming a cancellation", async () => {
  let game = await restingSell();
  const orderId = getMarketView(game.market).openOrders[0].id;
  enableBuyer(game, 10);
  game = await commandGame(game, { type: "cancel", pokerRevision: game.poker.revision, orderId }, NOW + 1000);
  assert.match(receipt(game)!, /Sold 5 Claude.*All 5 shares filled/);
  assert.doesNotMatch(receipt(game)!, /canceled/i);
  const repeated = await commandGame(game, { type: "cancel", pokerRevision: game.poker.revision, orderId }, NOW + 1000);
  assert.deepEqual(repeated.activity, game.activity);
});

test("canceling a partial remainder reports only the unfilled size and releases reserved shares", async () => {
  let game = await restingSell();
  enableBuyer(game, 1);
  game = await commandGame(game, { type: "tick" }, NOW + 1000);
  const orderId = getMarketView(game.market).openOrders[0].id;
  game = await commandGame(game, { type: "cancel", pokerRevision: game.poker.revision, orderId }, NOW + 1000);
  assert.equal(receipt(game), "Canceled 4 unfilled Claude sell shares. Reserved shares released.");
  assert.equal(getMarketView(game.market).positions[1].availableQuantity, 9);
});

test("a folded outcome cancels its resting order without reporting an execution", async () => {
  let game = fixture();
  const seat = game.poker.actor!;
  game = await commandGame(game, { type: "order", pokerRevision: game.poker.revision,
    outcome: seat, side: "buy", quantity: 5, limitPrice: .01, orderType: "limit" }, NOW);
  game = await commandGame(game, { type: "advance", pokerRevision: game.poker.revision }, NOW, async () => ({ type: "fold" }));
  assert.match(receipt(game)!, /^Canceled 5 unfilled Grok buy shares because Grok folded/);
  assert.equal(getMarketView(game.market).cash, 1000);
  assert.equal(getMarketView(game.market).reservedCash, 0);
});

test("settlement clears a still-open order's stale remainder receipt", async () => {
  let game = fixture();
  game = await commandGame(game, { type: "order", pokerRevision: game.poker.revision,
    outcome: 2, side: "buy", quantity: 5, limitPrice: .01, orderType: "limit" }, NOW);
  while (game.poker.street !== "complete") {
    game = await commandGame(game, { type: "advance", pokerRevision: game.poker.revision }, NOW,
      async observation => ({ type: observation.legal.canFold ? "fold" : "check" }));
  }
  assert.equal(receipt(game), "Canceled 5 unfilled Gemini buy shares because the hand settled. No shares remain open on this order.");
  assert.equal(getMarketView(game.market).cash, 1000);
  assert.equal(getMarketView(game.market).openOrders.length, 0);
});

test("information-driven arrivals log delayed fills without waiting for an elapsed second", async () => {
  let game = await restingSell();
  enableBuyer(game, 10);
  game.market.traders[0].seenRevision = -1;
  game.market.traders[0].nextWake = 100;
  game.marketReactionPending = true;
  game = await commandGame(game, { type: "tick" }, NOW);
  assert.equal(game.market.tick, 0);
  assert.match(receipt(game)!, /Sold 5 Claude.*All 5 shares filled/);
  assert.equal(getMarketView(game.market).positions[1].quantity, 5);
  assert.equal(getMarketView(game.market).openOrders.length, 0);
});

test("Jev order replacements report delayed partial and full human fills", async () => {
  let game = fixture();
  game.market = createMarket([.25, .25, .25, .25], 44, 1000, "jev");
  game.market = replaceTraderOrders(game.market, "trader-1", [{ outcome: 1, side: "sell", priceTicks: 25, quantity: 10 }]);
  game = await commandGame(game, { type: "order", pokerRevision: game.poker.revision,
    outcome: 1, side: "buy", quantity: 10, limitPrice: .25, orderType: "ioc" }, NOW);
  game = await commandGame(game, { type: "order", pokerRevision: game.poker.revision,
    outcome: 1, side: "sell", quantity: 10, limitPrice: .29, orderType: "limit" }, NOW);
  game.market = advanceMarket(game.market, [.1, .7, .1, .1], 0);
  for (let batch = 0; batch < 2; batch++) {
    const at = NOW + batch * 3000, token = `fill-${batch}`;
    game = reserveMarketRound(game, token, at)!;
    const round = prepareMarketRound(game);
    const answers = Object.fromEntries(round.traders.map(trader => [trader.id, trader.id === "trader-2" ? "buy_1_5" : "hold"]));
    game = finishMarketRound(game, token, round, answers, at + 1000)!;
    assert.equal(getMarketView(game.market).positions[1].quantity, 5 - batch * 5);
    assert.equal(getMarketView(game.market).cash, batch === 0 ? 998.95 : 1000.4);
    assert.match(receipt(game)!, /Sold 5 Claude shares at 29.0¢ from a resting order. Received \$1.45/);
    assert.match(receipt(game)!, batch === 0 ? /5 of 10 filled; 5 shares remain open/ : /All 10 shares filled. No shares remain open/);
  }
  assert.equal(game.market.driver, "jev");
  assert.equal(getMarketView(game.market).openOrders.length, 0);
});
