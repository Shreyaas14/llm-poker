import test from "node:test";
import assert from "node:assert/strict";
import { createHand, fullDeck } from "../lib/poker.ts";
import { EQUITY_SAMPLES, equityKey, showdownEquity } from "../lib/equity.ts";
import type { PokerState } from "../lib/poker.ts";

function fixture(board: string[], holes: string[][]): PokerState {
  const state = createHand(42, 0);
  state.board = board;
  state.street = board.length === 5 ? "river" : board.length === 4 ? "turn" : board.length === 3 ? "flop" : "preflop";
  state.players.forEach((player, seat) => { player.hole = holes[seat]; player.folded = false; });
  return state;
}

test("river card equity identifies the winning hand and splits board ties", () => {
  const state = fixture(["2c", "4d", "6h", "8s", "Tc"], [["Ac", "Ad"], ["Kc", "Kd"], ["Qc", "Qd"], ["Jc", "Jd"]]);
  assert.deepEqual(showdownEquity(state), { equities: [1, 0, 0, 0], method: "exact", samples: 1, standardError: 0 });
  state.board = ["Ts", "Js", "Qs", "Ks", "As"];
  assert.deepEqual(showdownEquity(state).equities, [0.25, 0.25, 0.25, 0.25]);
  state.players[1].folded = true;
  assert.deepEqual(showdownEquity(state).equities, [1 / 3, 0, 1 / 3, 1 / 3]);
});

test("folded hole cards remain dead and change exact turn outs", () => {
  const state = fixture(["Qh", "9h", "7c", "6d"], [["Ah", "Kh"], ["As", "Ad"], ["2h", "3h"], ["4h", "5h"]]);
  state.players[2].folded = state.players[3].folded = true;
  const blocked = showdownEquity(state);
  assert.equal(blocked.samples, 40);
  assert.deepEqual(blocked.equities, [5 / 40, 35 / 40, 0, 0]);
  state.players[2].hole = ["2c", "3c"]; state.players[3].hole = ["4c", "5c"];
  assert.deepEqual(showdownEquity(state).equities, [9 / 40, 31 / 40, 0, 0]);
});

test("flop equity exhaustively enumerates all 820 remaining board combinations", () => {
  const state = fixture(["Ac", "Ad", "Ah"], [["As", "2d"], ["Kc", "Kd"], ["Qc", "Qd"], ["Jc", "Jd"]]);
  const odds = showdownEquity(state);
  assert.equal(odds.method, "exact"); assert.equal(odds.samples, 820);
  assert.equal(odds.standardError, 0);
  assert.deepEqual(odds.equities, [1, 0, 0, 0]);
});

test("preflop Monte Carlo is repeatable, normalized, and independent of hidden state", () => {
  const state = createHand(917, 2);
  state.players[2].folded = true;
  const before = JSON.stringify(state);
  const first = showdownEquity(state);
  assert.equal(first.method, "monte_carlo"); assert.equal(first.samples, EQUITY_SAMPLES);
  assert.equal(first.standardError, 0.5 / Math.sqrt(EQUITY_SAMPLES));
  assert.equal(first.equities[2], 0);
  assert.ok(first.equities.every(value => value >= 0 && value <= 1));
  assert.ok(Math.abs(first.equities.reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  assert.equal(JSON.stringify(state), before, "calculation leaves authoritative poker untouched");
  const changed = structuredClone(state);
  changed.seed = "f".repeat(64); changed.deck = fullDeck().reverse();
  changed.revision += 17; changed.pot += 99; changed.players[0].bet += 99;
  assert.equal(equityKey(state), equityKey(changed));
  assert.deepEqual(showdownEquity(changed), first);
  assert.deepEqual(showdownEquity(state), first);
});

test("known terminal payouts override card strength and sole survivor is exact", () => {
  const state = fixture([], [["Ac", "Ad"], ["Kc", "Kd"], ["Qc", "Qd"], ["Jc", "Jd"]]);
  state.players.forEach(player => { player.folded = player.seat !== 3; });
  assert.deepEqual(showdownEquity(state), { equities: [0, 0, 0, 1], method: "exact", samples: 1, standardError: 0 });
  state.street = "complete"; state.mainPotShares = [0, 0.5, 0, 0.5];
  assert.deepEqual(showdownEquity(state), { equities: [0, 0.5, 0, 0.5], method: "exact", samples: 1, standardError: 0 });
});

test("preflop sampling agrees with a suit-symmetric fifty-fifty matchup", () => {
  const state = fixture([], [["Ac", "Ad"], ["Ah", "As"], ["Kc", "Kd"], ["Kh", "Ks"]]);
  state.players[2].folded = state.players[3].folded = true;
  // Exchanging clubs/diamonds with hearts/spades exchanges the contenders
  // while preserving the complete known-card set, so true equity is 1/2 each.
  const odds = showdownEquity(state);
  assert.ok(Math.abs(odds.equities[0] - 0.5) < 3 * odds.standardError);
  assert.ok(Math.abs(odds.equities[1] - 0.5) < 3 * odds.standardError);
  assert.deepEqual(odds.equities.slice(2), [0, 0]);
});
