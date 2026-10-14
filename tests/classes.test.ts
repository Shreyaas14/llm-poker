import test from "node:test";
import assert from "node:assert/strict";
import { createHand, decidePractice, estimateValues, getObservation, shuffledClasses, STYLES } from "../lib/poker.ts";

test("game class assignments are seeded permutations with one of each class", () => {
  const expected = STYLES.map(style => style.id).sort();
  const assignments = new Set<string>();
  for (let seed = 0; seed < 48; seed++) {
    const assignment = shuffledClasses(seed);
    assert.deepEqual([...assignment].sort(), expected);
    assert.deepEqual(assignment, shuffledClasses(seed));
    assignments.add(assignment.join(","));
    const state = createHand(42, 0, 1000, assignment);
    for (let seat = 0; seat < 4; seat++) assert.equal(getObservation(state, seat).style.id, assignment[seat]);
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
      const first = decidePractice({ ...observation, seat: 0, style }, seed);
      const last = decidePractice({ ...observation, seat: 3, style }, seed);
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
  const legacy = structuredClone(hand); delete legacy.classIds;
  assert.deepEqual(estimateValues(legacy, 82, 128), originalForecast, "saved games retain their original class policies");
});
