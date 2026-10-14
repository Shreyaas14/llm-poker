import type { Bootstrap, SessionView } from "../app/types";

type Result = Pick<SessionView, "ranked" | "rankEligible">;
type Identity = Pick<Bootstrap, "authenticated" | "profile">;

export function completionMessage(result: Result, identity: Identity | null): string {
  if (result.ranked) {
    return result.rankEligible
      ? "Your completed score is on this week’s leaderboard."
      : "This ranked run crossed the weekly reset, so its score is not eligible for this week’s leaderboard.";
  }
  const complete = "Unranked challenge complete.";
  if (!identity) return complete;
  if (!identity.authenticated) return `${complete} Sign in and enter a ranked challenge to join the weekly standings.`;
  if (!identity.profile) return `${complete} Set a username in your profile to enter ranked challenges.`;
  if (identity.profile.remainingAttempts <= 0) return `${complete} Your ranked attempts are used for this week. They renew at the weekly reset.`;
  return `${complete} Enter a ranked challenge to join the weekly standings.`;
}
