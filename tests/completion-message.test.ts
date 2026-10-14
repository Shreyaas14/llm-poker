import test from "node:test";
import assert from "node:assert/strict";
import { completionMessage } from "../lib/completion-message.ts";

const unranked = { ranked: false, rankEligible: true };
const profile = { username: "trader", rankedStarts: 2, remainingAttempts: 1 };

test("a signed-in trader is invited to rank without being told to sign in", () => {
  assert.equal(completionMessage(unranked, { authenticated: true, profile }),
    "Unranked challenge complete. Enter a ranked challenge to join the weekly standings.");
});

test("a signed-in account without a profile is told to set its username", () => {
  const message = completionMessage(unranked, { authenticated: true, profile: null });
  assert.match(message, /Set a username/);
  assert.doesNotMatch(message, /Sign in/);
});

test("exhausted ranked attempts explain when ranking becomes available again", () => {
  const message = completionMessage(unranked, { authenticated: true, profile: { ...profile, rankedStarts: 3, remainingAttempts: 0 } });
  assert.match(message, /attempts are used for this week/);
  assert.match(message, /weekly reset/);
  assert.doesNotMatch(message, /Sign in|Enter a ranked challenge/);
});

test("guests get sign-in guidance and unresolved identity does not assume guest", () => {
  assert.match(completionMessage(unranked, { authenticated: false, profile: null }), /Sign in/);
  assert.equal(completionMessage(unranked, null), "Unranked challenge complete.");
});

test("eligible ranked scores keep their leaderboard confirmation", () => {
  assert.equal(completionMessage({ ranked: true, rankEligible: true }, null),
    "Your completed score is on this week’s leaderboard.");
});

test("a reset-expired ranked run is not mislabeled unranked or listed", () => {
  const message = completionMessage({ ranked: true, rankEligible: false }, { authenticated: true, profile });
  assert.match(message, /ranked run crossed the weekly reset/);
  assert.match(message, /not eligible/);
  assert.doesNotMatch(message, /Unranked|Sign in|score is on/);
});
