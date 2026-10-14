import type { ReplayFrame, SessionCommand } from "../app/types.ts";
import { getMarketView } from "./market.ts";
import { viewGame } from "./game.ts";
import type { Game } from "./game.ts";

export function createReplayFrame(game: Game, kind: SessionCommand["type"] | "deal", now: number): ReplayFrame {
  const session = structuredClone(viewGame(game, false, now));
  session.busy = false;
  session.tradingOpen = false;
  session.marketSecondsRemaining = 0;
  return {
    version: game.version, at: new Date(now).toISOString(),
    label: kind === "deal" ? "Hand 1 dealt. The challenge begins."
      : kind === "tick" ? `Market snapshot · Hand ${game.hand} · ${game.market.tick}s`
      : game.activity.at(-1)?.text ?? "The table advanced.",
    session,
  };
}

export function shouldRecordReplay(before: Game, after: Game, kind: SessionCommand["type"]): boolean {
  if (kind !== "tick") return true;
  // A replay must retain observable depth/volume changes even when the human did not trade.
  return JSON.stringify(getMarketView(before.market).books) !== JSON.stringify(getMarketView(after.market).books)
    || JSON.stringify(before.market.accounts.human) !== JSON.stringify(after.market.accounts.human)
    || JSON.stringify(before.market.orders.filter(order => order.owner === "human"))
      !== JSON.stringify(after.market.orders.filter(order => order.owner === "human"));
}
