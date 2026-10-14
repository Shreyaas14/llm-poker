import test from "node:test";
import assert from "node:assert/strict";
import { commandGame, TRADING_WINDOW_MS } from "../lib/game.ts";
import type { Game, PreparedPokerDecision } from "../lib/game.ts";
import { createHand, estimateValues } from "../lib/poker.ts";
import { advanceMarket, createMarket, reactMarket } from "../lib/market.ts";

const NOW = Date.UTC(2026, 9, 14, 12);
function fixture(): Game {
  const poker = createHand(42, 0, 1000), values = estimateValues(poker, 43, 24);
  return { rulesVersion: "river-1", id: "market-timing", mode: "live", ranked: false,
    rankEligible: true, hand: 1, poker, values, market: createMarket(values, 44),
    models: ["test", "test", "test", "test"], results: [], activity: [], sequence: 0,
    version: 0, cashBefore: 1000, eventUntil: NOW + TRADING_WINDOW_MS, lastTickAt: NOW,
    requestIds: [], createdAt: NOW, notice: null, providerCalls: 0 };
}
async function advance(game: Game, now: number) {
  return commandGame(game, { type: "advance", pokerRevision: game.poker.revision }, now,
    async observation => ({ type: observation.legal.canCheck ? "check" : "call" }));
}

test("subsecond poker actions preserve elapsed market time instead of resetting its clock", async () => {
  let game = fixture();
  for (let action = 1; action <= 8; action++) {
    game = await advance(game, NOW + action * 250);
    assert.equal(game.market.tick, Math.floor(action / 4));
    assert.equal(game.lastTickAt, NOW + Math.floor(action / 4) * 1000);
  }
  const unchanged = await commandGame(game, { type: "tick" }, NOW + 2000);
  assert.equal(unchanged.market.tick, 2, "the same elapsed time is not counted twice");
});

test("an all-subsecond hand reacts to published information without inventing elapsed seconds", async () => {
  let game = fixture();
  const openingVolume = game.market.volumes.reduce((sum, value) => sum + value, 0);
  const openingFills = structuredClone(game.market.fills);
  game = await advance(game, NOW);
  assert.deepEqual(game.market.fills, openingFills, "the action response publishes information before informed arrivals");
  let actions = 1;
  while (game.poker.street !== "complete") {
    game = await advance(game, NOW);
    assert.ok(++actions < 30);
  }
  assert.equal(game.market.tick, 0, "event arrivals do not manufacture elapsed time");
  assert.ok(game.market.volumes.reduce((sum, value) => sum + value, 0) > openingVolume,
    "real funded trades continue even when every action arrives within the same second");
  assert.equal(game.market.status, "settled");
});

test("information reactions are bounded, seeded and preserve collateral and funded holdings", () => {
  const opening = createMarket([.25, .25, .25, .25], 44);
  const published = advanceMarket(opening, [.7, .1, .1, .1], 0);
  const reacted = reactMarket(published);
  assert.deepEqual(reactMarket(published), reacted);
  assert.equal(reacted.tick, published.tick);
  assert.equal(reacted.traders.filter(trader => trader.seenRevision === reacted.revision).length, 4);
  assert.equal(reacted.collateralUnits, reacted.completeSetsIssued * 120_000);
  const cash = (state: typeof reacted) => Object.values(state.accounts).reduce((sum, account) => sum + account.cashUnits, 0);
  assert.equal(cash(reacted) + reacted.collateralUnits, cash(opening) + opening.collateralUnits);
  for (let seat = 0; seat < 4; seat++) {
    assert.equal(Object.values(reacted.accounts).reduce((sum, account) => sum + account.shares[seat], 0), reacted.completeSetsIssued);
  }
});

test("pause freezes a queued reaction and a prepared action, then resume retains fractional time", async () => {
  let game = await advance(fixture(), NOW + 250);
  game = await commandGame(game, { type: "playback", paused: true }, NOW + 500);
  const decision: PreparedPokerDecision = { action: { type: "call" }, calls: 1,
    hand: game.hand, pokerRevision: game.poker.revision };
  const committed = await commandGame(game, { type: "advance", pokerRevision: game.poker.revision }, NOW + 5000, undefined, decision);
  assert.equal(committed.pausedAt, NOW + 500);
  assert.equal(committed.market.tick, game.market.tick);
  assert.deepEqual(committed.market.fills, game.market.fills);
  assert.equal(committed.lastTickAt, NOW);
  const frozen = await commandGame(committed, { type: "tick" }, NOW + 10000);
  assert.deepEqual(frozen, committed);
  const resumed = await commandGame(frozen, { type: "playback", paused: false }, NOW + 10000);
  assert.deepEqual(resumed.market, frozen.market, "resume itself introduces no informed fill");
  const ticked = await commandGame(resumed, { type: "tick" }, NOW + 10500);
  assert.equal(ticked.market.tick, game.market.tick + 1);
  assert.equal(ticked.marketReactionPending, undefined);
});

test("time past an inactive deadline is excluded without losing its fractional remainder", async () => {
  let game = await advance(fixture(), NOW + 250);
  game = await advance(game, NOW + 60000);
  assert.equal(game.market.tick, 45);
  assert.equal(game.lastTickAt, NOW + 59750);
  game = await commandGame(game, { type: "tick" }, NOW + 60750);
  assert.equal(game.market.tick, 46);
});

test("Jev clocks retain subsecond time without invoking local market decisions", async () => {
  let game = fixture();
  game.market = createMarket(game.values, 44, 1000, "jev");
  const published = advanceMarket(game.market, [.7, .1, .1, .1], 0);
  assert.deepEqual(reactMarket(published), published, "a news reaction cannot fall back to local traders");
  for (let action = 1; action <= 8; action++) {
    game = await advance(game, NOW + action * 250);
    assert.equal(game.market.tick, Math.floor(action / 4));
    assert.equal(game.market.orders.length, 0);
    assert.equal(game.market.fills.length, 0);
  }
  assert.equal(game.market.driver, "jev");
});
