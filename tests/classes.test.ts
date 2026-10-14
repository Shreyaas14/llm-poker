import test from "node:test";
import assert from "node:assert/strict";
import type { Observation, Style } from "../lib/poker.ts";
import { createHand, decidePractice, estimateValues, getObservation, getSpectator, shuffledClasses, STYLES } from "../lib/poker.ts";

test("game class assignments are seeded permutations with one of each class", () => {
  const expected = STYLES.map(style => style.id).sort();
  const assignments = new Set<string>();
  for (let seed = 0; seed < 48; seed++) {
    const assignment = shuffledClasses(seed);
    assert.deepEqual([...assignment].sort(), expected);
    assert.deepEqual(assignment, shuffledClasses(seed));
    assignments.add(assignment.join(","));
    const state = createHand(42, 0, 1000, assignment);
    for (let seat = 0; seat < 4; seat++) assert.equal(getObservation(state, seat).style?.id, assignment[seat]);
    assignment.reverse();
    assert.notDeepEqual(state.classIds, assignment, "hand state owns its assignment snapshot");
  }
  assert.ok(assignments.size > 12, "assignments vary independently of the fixed providers");
  assert.throws(() => createHand(42, 0, 1000, ["patient", "patient", "pressure", "disciplined"]), /each playing class once/);
});

test("practice decisions follow the assigned class rather than provider seat", () => {
  const hand = createHand(42, 0);
  const observation = getObservation(hand, hand.actor!);
  observation.players.forEach(player => { player.stack = 1000; player.bet = 0; });
  let differentDecisions = 0;
  for (let seed = 0; seed < 80; seed++) {
    const actions = STYLES.map(style => {
      const first = decidePractice({ ...observation, seat: 0, button: 0, style }, seed);
      const last = decidePractice({ ...observation, seat: 3, button: 3, style }, seed);
      assert.deepEqual(first, last, "equivalent seats with the same class choose the same action");
      return JSON.stringify(first);
    });
    if (new Set(actions).size > 1) differentDecisions++;
  }
  assert.ok(differentDecisions > 0, "different classes produce different playing behavior");
});

test("forecast rollouts honor assigned classes without consulting the real future deck", () => {
  const hand = createHand(42, 0), changed = structuredClone(hand);
  changed.classIds = STYLES.map(style => style.id).reverse();
  const originalForecast = estimateValues(hand, 82, 128);
  const reassignedForecast = estimateValues(changed, 82, 128);
  assert.notDeepEqual(reassignedForecast, originalForecast, "changing classes changes the future-action forecast");
  changed.deck.reverse(); changed.seed = "private-deck-changed";
  assert.deepEqual(estimateValues(changed, 82, 128), reassignedForecast);
  const legacy = structuredClone(hand); delete legacy.classIds; delete legacy.personalitiesEnabled;
  assert.deepEqual(estimateValues(legacy, 82, 128), originalForecast, "saved games retain their original class policies");
});

// Compare the same cards, table, and random seeds so only personality varies.
function actionCounts(style: Style, changes: Partial<Observation> = {}) {
  const hand = createHand(42, 0);
  const observation: Observation = {
    ...getObservation(hand, hand.actor!),
    seat: 0, button: 0, hole: ["7c", "2d"], board: [], street: "preflop",
    pot: 30, currentBet: 10, history: [],
    players: getObservation(hand, hand.actor!).players.map(player => ({ ...player, stack: 1000, bet: 0, folded: false })),
    legal: { canFold: true, canCheck: false, canCall: true, canRaise: true, callAmount: 10, minRaiseTo: 20, maxRaiseTo: 1000 },
    ...changes, style,
  };
  const counts = { fold: 0, check: 0, call: 0, raise: 0, raisedChips: 0 };
  for (let seed = 0; seed < 512; seed++) {
    const action = decidePractice(observation, seed);
    counts[action.type]++;
    if (action.type === "raise") {
      assert.ok(action.amount! >= observation.legal.minRaiseTo! && action.amount! <= observation.legal.maxRaiseTo);
      counts.raisedChips += action.amount!;
    }
  }
  return counts;
}

function personality(name: string): Style {
  const style = STYLES.find(candidate => candidate.name === name);
  assert.ok(style, `${name} is available to players and live models`);
  return style;
}

test("Shark plays selectively but bets strong hands aggressively", () => {
  const shark = personality("Shark"), bully = personality("Bully");
  assert.ok(actionCounts(shark).fold > actionCounts(bully).fold, "Shark folds more weak hands than Bully");
  assert.ok(actionCounts(shark, { hole: ["Ac", "Ad"] }).raise > 300, "Shark bets premium hands rather than routinely checking or calling");
});

test("Maniac raises more often and larger than Bully with weak hands", () => {
  const maniac = actionCounts(personality("Maniac")), bully = actionCounts(personality("Bully"));
  assert.ok(maniac.raise > bully.raise * 1.5, "Maniac bluffs substantially more than Bully");
  assert.ok(maniac.raisedChips / maniac.raise > bully.raisedChips / bully.raise, "Maniac uses larger bets");
});

test("Opportunist steals in position but retreats against resistance", () => {
  const opportunist = personality("Opportunist");
  const inPosition = actionCounts(opportunist);
  const outOfPosition = actionCounts(opportunist, { button: 1 });
  assert.ok(inPosition.raise > outOfPosition.raise * 2, "Opportunist targets unraised pots in position");
  const contested = actionCounts(opportunist, {
    pot: 400, currentBet: 200,
    legal: { canFold: true, canCheck: false, canCall: true, canRaise: true, callAmount: 200, minRaiseTo: 400, maxRaiseTo: 1000 },
  });
  assert.ok(contested.fold > 480, "Opportunist rarely fights an expensive pot with a weak hand");
});

test("old saved assignments resolve to the four poker personalities", () => {
  const hand = createHand(42, 0, 1000, ["disciplined", "pressure", "patient", "unpredictable"]);
  const expected = ["Shark", "Bully", "Opportunist", "Maniac"];
  assert.deepEqual(hand.players.map(player => getObservation(hand, player.seat).style?.name), expected);
  delete hand.classIds;
  delete hand.personalitiesEnabled;
  assert.deepEqual(hand.players.map(player => getObservation(hand, player.seat).style?.name), expected, "pre-assignment sessions keep their seat defaults");
});


test("disabled personalities expose no assigned style and use one practice policy", () => {
  const hand = createHand(42, 0, 1000, undefined, false);
  for (let seat = 0; seat < 4; seat++) assert.equal(getObservation(hand, seat).style, null);
  assert.equal(hand.classIds, undefined);
  assert.equal(getSpectator(hand).classIds, undefined);
  assert.equal(getSpectator(hand).personalitiesEnabled, false);
  const observation = getObservation(hand, hand.actor!);
  observation.players.forEach(player => { player.stack = 1000; player.bet = 0; });
  for (let seed = 0; seed < 128; seed++) {
    assert.deepEqual(decidePractice({ ...observation, seat: 0 }, seed), decidePractice({ ...observation, seat: 3 }, seed), "neutral policy is independent of provider and position");
  }
  const changed = structuredClone(hand);
  changed.classIds = STYLES.map(style => style.id).reverse();
  assert.deepEqual(estimateValues(changed, 82, 64), estimateValues(hand, 82, 64), "disabled forecasts ignore leftover assignments");
});
