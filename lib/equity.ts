import { evaluate, fullDeck } from "./poker.ts";
import type { PokerState } from "./poker.ts";
import type { ShowdownOdds } from "../app/types.ts";

export const EQUITY_SAMPLES = 4096;

/** Only visible cards and eligibility affect showdown equity. Betting, style,
 * the secret shuffle, and the actual unrevealed runout cannot enter this key. */
export function equityKey(state: PokerState): string {
  return JSON.stringify([
    state.board,
    state.players.map(player => [player.hole, player.folded]),
    state.street === "complete" ? state.mainPotShares : null,
  ]);
}

/** Fractional main-pot payout if every remaining player reaches showdown.
 * Folded players' visible hole cards are dead cards. Unknown burn cards stay
 * in the sampling pool: their identities are not available to the spectator.
 * This is card equity, not a forecast of future model betting or folding. */
export function showdownEquity(state: PokerState): ShowdownOdds {
  if (state.street === "complete") return { equities: [...state.mainPotShares], method: "exact", samples: 1, standardError: 0 };
  const active = state.players.filter(player => !player.folded);
  if (!active.length) throw new Error("Showdown equity requires an eligible player");
  if (active.length === 1) return { equities: state.players.map(player => player.seat === active[0].seat ? 1 : 0), method: "exact", samples: 1, standardError: 0 };
  if (![0, 3, 4, 5].includes(state.board.length)) throw new Error("Invalid Hold'em board length");
  const known = new Set([...state.board, ...state.players.flatMap(player => player.hole)]);
  const remaining = fullDeck().filter(card => !known.has(card));
  const missing = 5 - state.board.length;
  const totals = state.players.map(() => 0);
  let samples = 0;
  const record = (runout: string[]) => {
    const board = [...state.board, ...runout];
    const ranks = active.map(player => evaluate([...player.hole, ...board]));
    const best = Math.max(...ranks);
    const winnerCount = ranks.filter(rank => rank === best).length;
    for (let i = 0; i < active.length; i++) if (ranks[i] === best) totals[active[i].seat] += 1 / winnerCount;
    samples++;
  };

  if (missing <= 2) {
    // Order does not affect a final Hold'em hand, so each possible board
    // combination has equal weight. Normally 820 flop or 40 turn runouts.
    if (missing === 0) record([]);
    else if (missing === 1) for (const card of remaining) record([card]);
    else for (let i = 0; i < remaining.length - 1; i++) for (let j = i + 1; j < remaining.length; j++) record([remaining[i], remaining[j]]);
    return { equities: totals.map(value => value / samples), method: "exact", samples, standardError: 0 };
  }

  // Reproducible Monte Carlo seeded exclusively by spectator-visible facts.
  // Rejection sampling avoids modulo bias; partial Fisher-Yates draws five
  // distinct cards uniformly, independent of the game's secret deck.
  let randomState = 2166136261;
  for (const char of equityKey(state)) randomState = Math.imul(randomState ^ char.charCodeAt(0), 16777619) >>> 0;
  if (!randomState) randomState = 0x9e3779b9;
  const randomInt = (size: number) => {
    const limit = Math.floor(4294967296 / size) * size;
    let value: number;
    do {
      randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
      value = randomState >>> 0;
    } while (value >= limit);
    return value % size;
  };
  for (let sample = 0; sample < EQUITY_SAMPLES; sample++) {
    const pool = [...remaining];
    for (let i = 0; i < missing; i++) {
      const index = i + randomInt(pool.length - i);
      [pool[i], pool[index]] = [pool[index], pool[i]];
    }
    record(pool.slice(0, missing));
  }
  // A payout lies in [0,1], so its standard error is at most 0.5/sqrt(n).
  // This conservative bound avoids reporting false certainty for rare draws.
  return { equities: totals.map(value => value / samples), method: "monte_carlo", samples, standardError: 0.5 / Math.sqrt(samples) };
}
