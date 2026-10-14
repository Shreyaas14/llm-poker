import test from "node:test";
import assert from "node:assert/strict";
import { commandGame, createGame, catchUp, GameError, TRADING_WINDOW_MS, viewGame } from "../lib/game.ts";
import type { Game, LiveDecision } from "../lib/game.ts";
import { createHand, estimateValues, fullDeck } from "../lib/poker.ts";
import type { Observation } from "../lib/poker.ts";
import { createMarket, getMarketView, UNITS_PER_CREDIT } from "../lib/market.ts";

const NOW = Date.UTC(2026, 9, 14, 12);

function gameFixture(mode: "practice" | "live" = "live"): Game {
  const poker = createHand(42, 0, 1000);
  const values = estimateValues(poker, 43, 24);
  return {
    rulesVersion: "river-1", id: "fixture-game", mode, ranked: false, rankEligible: true,
    hand: 1, poker, market: createMarket(values, 44), models: ["gpt-test", "claude-test", "gemini-test", "grok-test"],
    results: [], activity: [], sequence: 0, version: 0, cashBefore: 1000,
    eventUntil: NOW + TRADING_WINDOW_MS, lastTickAt: NOW, values,
    requestIds: [], createdAt: NOW, notice: null, providerCalls: 0,
  };
}
const foldIfPossible: LiveDecision = async observation => observation.legal.canFold ? { type: "fold" } : observation.legal.canCheck ? { type: "check" } : { type: "call" };

function assertPrivateObservation(observation: Observation, game: Game): void {
  assert.deepEqual(observation.hole, game.poker.players[observation.seat].hole);
  assert.ok(observation.players.every(player => !("hole" in player)));
  const serialized = JSON.stringify(observation);
  for (const privateField of ["deck", "seed", "market", "values", "rngState", "beliefs", "pending", "actedAt"]) assert.ok(!serialized.includes(`"${privateField}"`), privateField);
  for (const player of game.poker.players) if (player.seat !== observation.seat) {
    for (const card of player.hole) assert.ok(!serialized.includes(`"${card}"`), "opponent's private card was absent");
  }
}

test("new game starts with four real seats, five-hand target, and a private future deck", () => {
  const game = createGame("created-game", "practice", false, NOW);
  const view = viewGame(game, false, NOW);
  assert.equal(view.totalHands, 5); assert.equal(view.hand, 1);
  assert.equal(view.market.cash, 1000); assert.equal(view.startingBalance, 1000);
  assert.equal(view.players.length, 4); assert.deepEqual(view.board, []);
  assert.equal(new Set(view.players.flatMap(p => p.cards)).size, 8);
  assert.ok(view.players.every(p => p.modelId === "Practice decision model"));
  assert.equal(view.tradingOpen, true);
  for (const field of ["deck", "seed", "rngState", "beliefs", "accounts"]) assert.ok(!JSON.stringify(view).includes(`"${field}"`));
});

test("five complete hands settle trades, carry cash, rotate dealer, and end the run", async t => {
  let clock = NOW;
  t.mock.method(Date, "now", () => clock);
  let game = gameFixture();
  let expectedUnits = 1000 * UNITS_PER_CREDIT;
  const seenModels = new Set<string>();
  const chooser: LiveDecision = async (observation, model) => {
    assertPrivateObservation(observation, game);
    assert.equal(model, game.models[observation.seat]); seenModels.add(model);
    return foldIfPossible(observation, model);
  };
  for (let hand = 1; hand <= 5; hand++) {
    assert.equal(game.hand, hand);
    assert.equal(game.market.accounts.human.cashUnits, expectedUnits);
    assert.equal(game.cashBefore, expectedUnits / UNITS_PER_CREDIT);
    const guaranteedWinner = (game.poker.button + 2) % 4;
    // The mocked live seats all fold when facing the blind, so another seat's
    // purchased shares lose. This verifies actual fills and cash carry, not a
    // zero-trade run that would pass with broken settlement accounting.
    const sellBook = getMarketView(game.market).books.find(book => book.outcome !== guaranteedWinner && book.bestAsk !== null);
    assert.ok(sellBook);
    const quantity = 2;
    game = await commandGame(game, { type: "order", pokerRevision: game.poker.revision,
      outcome: sellBook.outcome, side: "buy", quantity, limitPrice: sellBook.bestAsk!, orderType: "ioc" }, clock);
    assert.equal(game.market.accounts.human.shares[sellBook.outcome], quantity);
    expectedUnits = game.market.accounts.human.cashUnits;
    let actionCount = 0;
    while (game.poker.street !== "complete") {
      assert.ok(++actionCount <= 4);
      const foldingSeat = game.poker.actor!;
      clock += 10;
      game = await commandGame(game, { type: "advance", pokerRevision: game.poker.revision }, clock, chooser);
      if (game.poker.street !== "complete") {
        assert.equal(game.values[foldingSeat], 0, "a folded outcome has no remaining payout value");
        assert.ok(game.market.orders.every(order => order.outcome !== foldingSeat), "folded quotes are withdrawn");
      }
    }
    assert.deepEqual(game.poker.mainPotWinners, [guaranteedWinner]);
    assert.equal(game.market.status, "settled");
    assert.equal(game.market.accounts.human.cashUnits, expectedUnits);
    assert.equal(game.market.collateralUnits, 0);
    assert.equal(game.market.orders.length, 0);
    assert.equal(game.results.length, hand);
    assert.equal(game.results[hand - 1].cashAfter, expectedUnits / UNITS_PER_CREDIT);
    assert.equal(viewGame(game, false, clock).tradingOpen, false);
    if (hand < 5) {
      const button = game.poker.button;
      const previousRevision = game.poker.revision;
      game = await commandGame(game, { type: "next_hand", pokerRevision: previousRevision }, clock);
      assert.equal(game.poker.button, (button + 1) % 4);
      assert.notEqual(game.poker.revision, previousRevision);
      assert.equal(game.poker.players.reduce((sum, p) => sum + p.stack + p.contributed, 0), 4000);
    }
  }
  const view = viewGame(game, false, clock);
  assert.equal(view.status, "complete");
  assert.equal(view.pnl, expectedUnits / UNITS_PER_CREDIT - 1000);
  assert.equal(seenModels.size, 4);
  await assert.rejects(commandGame(game, { type: "next_hand", pokerRevision: game.poker.revision }, clock), /not ready/);
});

test("stale orders and stale poker actions reject without touching the supplied state", async () => {
  const game = gameFixture(), before = JSON.stringify(game);
  await assert.rejects(commandGame(game, { type: "order", pokerRevision: game.poker.revision + 1,
    outcome: 0, side: "buy", quantity: 1, limitPrice: 0.5, orderType: "ioc" }, NOW),
  error => error instanceof GameError && error.status === 409 && error.code === "stale_state");
  await assert.rejects(commandGame(game, { type: "advance", pokerRevision: 99999 }, NOW, foldIfPossible), /table has advanced/);
  assert.equal(JSON.stringify(game), before);
  game.hand = 2; game.poker.revision = 20000;
  await assert.rejects(commandGame(game, { type: "order", pokerRevision: 0,
    outcome: 0, side: "buy", quantity: 1, limitPrice: 0.5, orderType: "ioc" }, NOW), /poker state changed/);
});

test("closed trading windows reject orders and market catch-up stops at the deadline", async () => {
  const game = gameFixture();
  assert.equal(viewGame(game, false, game.eventUntil).tradingOpen, false);
  await assert.rejects(commandGame(game, { type: "order", pokerRevision: game.poker.revision,
    outcome: 0, side: "buy", quantity: 1, limitPrice: 0.5, orderType: "ioc" }, game.eventUntil), /window is closed/);
  catchUp(game, game.eventUntil + 3600000);
  assert.equal(game.market.tick, 45);
  const serialized = JSON.stringify(game.market);
  catchUp(game, game.eventUntil + 7200000);
  assert.equal(JSON.stringify(game.market), serialized);
  assert.equal(viewGame(game, true, NOW).tradingOpen, false, "busy sessions cannot accept frontend orders");
});

test("a poker advance publishes its event without giving informed traders an extra tick", async t => {
  t.mock.method(Date, "now", () => NOW);
  const game = gameFixture();
  const tick = game.market.tick, fills = structuredClone(game.market.fills), volume = [...game.market.volumes];
  const advanced = await commandGame(game, { type: "advance", pokerRevision: game.poker.revision }, NOW,
    async observation => ({ type: observation.legal.canCall ? "call" : "check" }));
  assert.equal(advanced.poker.revision, game.poker.revision + 1);
  assert.equal(advanced.market.tick, tick);
  assert.deepEqual(advanced.market.fills, fills);
  assert.deepEqual(advanced.market.volumes, volume);
  assert.equal(advanced.lastTickAt, NOW);
  const later = await commandGame(advanced, { type: "tick" }, NOW + 2000);
  assert.equal(later.market.tick, tick + 2);
  assert.deepEqual(later.poker, advanced.poker);
});

test("live observations never include opponent holes, market positions, or future cards", async t => {
  t.mock.method(Date, "now", () => NOW);
  const game = gameFixture();
  await commandGame(game, { type: "advance", pokerRevision: game.poker.revision }, NOW, async (observation, model) => {
    assertPrivateObservation(observation, game);
    assert.equal(model, game.models[game.poker.actor!]);
    return { type: "call" };
  });
  const changed = structuredClone(game);
  changed.poker.deck.reverse(); changed.poker.seed = "a".repeat(64);
  changed.market.rngState = 1234;
  assert.deepEqual(viewGame(changed, false, NOW), viewGame(game, false, NOW));
});

test("illegal live actions receive one correction; a second illegal action leaves the hand unchanged", async t => {
  t.mock.method(Date, "now", () => NOW);
  const game = gameFixture(); let calls = 0;
  const fixed = await commandGame(game, { type: "advance", pokerRevision: game.poker.revision }, NOW, async (observation, _model, feedback) => {
    calls++;
    if (calls === 1) { assert.equal(feedback, undefined); return { type: "raise", amount: 100000 }; }
    assert.match(feedback!, /Illegal raise/); assertPrivateObservation(observation, game);
    return { type: "call" };
  });
  assert.equal(calls, 2); assert.equal(fixed.providerCalls, 2);
  assert.equal(fixed.poker.revision, game.poker.revision + 1);
  const original = JSON.stringify(game);
  await assert.rejects(commandGame(game, { type: "advance", pokerRevision: game.poker.revision }, NOW, async () => ({ type: "raise", amount: 100000 })), /Illegal raise/);
  assert.equal(JSON.stringify(game), original);
  await assert.rejects(commandGame(game, { type: "advance", pokerRevision: game.poker.revision }, NOW), /not configured/);
});

test("a tied river settles fractional main-pot shares and cannot reopen the market", async t => {
  t.mock.method(Date, "now", () => NOW);
  const game = gameFixture();
  game.poker.street = "river"; game.poker.board = ["Ac", "Kc", "Qc", "Jc", "Tc"];
  const holes = [["As", "Ah"], ["Ks", "Kh"], ["Qs", "Qh"], ["Ts", "Th"]];
  game.poker.players.forEach((player, i) => {
    player.hole = holes[i]; player.stack = 900; player.bet = 100; player.contributed = 100;
    player.folded = false; player.allIn = false;
  });
  game.poker.currentBet = 100; game.poker.minRaise = 10; game.poker.pot = 400;
  game.poker.pending = [3]; game.poker.actor = 3; game.poker.actedAt = [100, 100, 100, -1];
  game.poker.deck = fullDeck().filter(card => ![...game.poker.board, ...holes.flat()].includes(card));
  game.market = createMarket([0.25, 0.25, 0.25, 0.25], 96);
  const ask = getMarketView(game.market).books[0].bestAsk!;
  const bought = await commandGame(game, { type: "order", pokerRevision: game.poker.revision,
    outcome: 0, side: "buy", quantity: 3, limitPrice: ask, orderType: "ioc" }, NOW);
  const cashBeforeSettlement = bought.market.accounts.human.cashUnits;
  const settled = await commandGame(bought, { type: "advance", pokerRevision: bought.poker.revision }, NOW, async () => ({ type: "check" }));
  assert.deepEqual(settled.results[0].payout, [0.25, 0.25, 0.25, 0.25]);
  assert.equal(settled.market.accounts.human.cashUnits, cashBeforeSettlement + 3 * UNITS_PER_CREDIT / 4);
  assert.equal(settled.market.collateralUnits, 0);
  assert.equal(viewGame(settled, false, NOW).winningCards.length, 5);
  await assert.rejects(commandGame(settled, { type: "order", pokerRevision: settled.poker.revision,
    outcome: 0, side: "buy", quantity: 1, limitPrice: 0.5, orderType: "ioc" }, NOW), /window is closed/);
  const afterTick = await commandGame(settled, { type: "tick" }, NOW + 60000);
  assert.deepEqual(afterTick.market, settled.market);
});
