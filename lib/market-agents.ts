import { catchUp } from "./game.ts";
import type { Game } from "./game.ts";
import { replaceTraderOrders, UNITS_PER_CREDIT, JEV_MARKET_CALL_LIMIT } from "./market.ts";
import type { TraderOrder } from "./market.ts";
import { ProviderError } from "./providers.ts";

export const JEV_MODEL = "typesafe-ai/jev";
export const MARKET_ROUND_INTERVAL_MS = 3000;
export const MARKET_ROUND_TIMEOUT_MS = 8000;
export const MARKET_CALL_LIMIT = JEV_MARKET_CALL_LIMIT;
export type MarketAgentRun = { calls: number; nextAt: number; pending?: { token: string; expiresAt: number; hand: number; pokerRevision: number } };
export type TraderMenu = { id: string; instructions: string; choices: Record<string, TraderOrder[]> };
export type MarketRound = { state: string; traders: TraderMenu[] };
export type MarketAnswers = Record<string, string>;

const STRATEGIES = {
  maker: "Supply two-sided liquidity, earn spreads, and keep balanced inventory.",
  fundamental: "Seek positive expected value relative to estimated main-pot payouts.",
  equity: "Prioritize showdown equity and diversify inventory across viable outcomes.",
  momentum: "Favor recent price trends, while avoiding excessive inventory risk.",
  contrarian: "Look for overreactions to recent price changes and trade against them.",
  noise: "Explore small speculative positions; keep sizes small and vary outcomes.",
};

/** Only dealt cards, visible actions, funded inventories, and recorded prices enter the model context. */
export function prepareMarketRound(game: Game): MarketRound {
  const market = game.market;
  const traders = market.traders.map(trader => {
    const choices: Record<string, TraderOrder[]> = { hold: [] };
    const order = (outcome: number, side: "buy" | "sell", quantity: number, priceTicks: number): TraderOrder => ({ outcome, side, quantity, priceTicks: Math.max(1, Math.min(99, priceTicks)) });
    const fair = market.values.map((value, i) => Math.max(.01, Math.min(.99, value * Math.exp(trader.bias[i]))));
    if (trader.kind === "maker") {
      for (const [name, spread] of [["tight_quotes", 2], ["wide_quotes", 5]] as const) {
        choices[name] = market.values.flatMap((value, outcome) => value === 0 ? [] : [0, 1, 2].flatMap(level => [
          order(outcome, "buy", 8 + level * 8, Math.floor(fair[outcome] * 100) - spread - level * 3),
          order(outcome, "sell", 8 + level * 8, Math.ceil(fair[outcome] * 100) + spread + level * 3),
        ]));
      }
    } else {
      market.values.forEach((value, outcome) => {
        if (value === 0) return;
        for (const side of ["buy", "sell"] as const) {
          for (const quantity of trader.kind === "noise" ? [3, 6] : [5, 15]) {
            choices[`${side}_${outcome}_${quantity}`] = [order(outcome, side, quantity, Math.round(fair[outcome] * 100))];
          }
        }
      });
    }
    return { id: trader.id, instructions: STRATEGIES[trader.kind], choices };
  });
  return {
    state: JSON.stringify({
      rules: "Play-money prediction market. A share pays $1 divided among main-pot winners; losing shares pay zero. Choose independently for each trader. No future cards are known. Quotes replace that trader's previous orders. Hold keeps existing orders. Orders are limited to available cash and owned shares at execution.",
      hand: game.hand, street: game.poker.street, board: game.poker.board, pot: game.poker.pot,
      players: game.poker.players.map(p => ({ seat: p.seat, name: p.name, cards: p.hole, folded: p.folded, stack: p.stack, action: p.lastAction })),
      estimatedPayouts: market.values, tick: market.tick, history: market.history.slice(-6),
      books: [0, 1, 2, 3].map(outcome => ({ outcome,
        bids: market.orders.filter(o => o.outcome === outcome && o.side === "buy").sort((a,b) => b.priceTicks-a.priceTicks).slice(0,6).map(o => ({ cents: o.priceTicks, quantity: o.remaining })),
        asks: market.orders.filter(o => o.outcome === outcome && o.side === "sell").sort((a,b) => a.priceTicks-b.priceTicks).slice(0,6).map(o => ({ cents: o.priceTicks, quantity: o.remaining })),
      })),
      traders: market.traders.map(t => ({ id: t.id, strategy: t.kind, bias: t.bias,
        cash: market.accounts[t.id].cashUnits / UNITS_PER_CREDIT, holdings: market.accounts[t.id].shares })),
    }), traders,
  };
}

export async function requestMarketDecisions(round: MarketRound, apiKey: string): Promise<MarketAnswers> {
  const response = await fetch("https://ai-gateway.vercel.sh/v1/evaluate", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(MARKET_ROUND_TIMEOUT_MS),
    body: JSON.stringify({ model: JEV_MODEL, state: round.state,
      questions: Object.fromEntries(round.traders.map(t => [t.id, { type: "choice", instructions: `Choose the next order action for ${t.id}. ${t.instructions} Maximize this trader's final play-money balance, accounting for its holdings and other traders' quotes.`,
        criteria: Object.fromEntries(Object.entries(t.choices).map(([id, orders]) => [id, orders.length ? `Replace quotes with these limit orders: ${JSON.stringify(orders)}` : "Keep current orders and do not submit new ones."])),
      }])) }),
  }).catch(() => { throw new ProviderError("Jev traders could not respond in time."); });
  if (!response.ok) throw new ProviderError("Jev traders are temporarily unavailable.");
  let result: unknown;
  try { result = await response.json(); } catch { throw new ProviderError("Jev returned an invalid trader decision."); }
  const answers = (result as { answers?: Record<string, { type?: string; choice?: unknown }> } | null)?.answers;
  const selected: MarketAnswers = {};
  for (const trader of round.traders) {
    const answer = answers?.[trader.id];
    if (answer?.type !== "choice" || typeof answer.choice !== "string" || !Object.hasOwn(trader.choices, answer.choice))
      throw new ProviderError("Jev returned an invalid trader decision.");
    selected[trader.id] = answer.choice;
  }
  return selected;
}

/** Durable reservation prevents duplicate polling requests from issuing duplicate paid calls. */
export function reserveMarketRound(source: Game, token: string, now: number): Game | null {
  if (source.market.driver !== "jev" || source.poker.street === "complete" || source.pausedAt !== undefined || now >= source.eventUntil) return null;
  const agent = source.marketAgents ?? { calls: 0, nextAt: 0 };
  if (agent.nextAt > now || (agent.pending && agent.pending.expiresAt > now) || agent.calls >= MARKET_CALL_LIMIT) return null;
  const game = structuredClone(source);
  game.marketAgents = { calls: agent.calls + 1, nextAt: now + MARKET_ROUND_INTERVAL_MS,
    pending: { token, expiresAt: now + MARKET_ROUND_TIMEOUT_MS + 2000, hand: source.hand, pokerRevision: source.poker.revision } };
  return game;
}

/** Apply chosen, server-owned candidates to the latest balances; never replace a whole market snapshot. */
export function finishMarketRound(source: Game, token: string, round: MarketRound, answers: MarketAnswers | null, now: number): Game | null {
  const pending = source.marketAgents?.pending;
  if (!pending || pending.token !== token) return null;
  const game = structuredClone(source);
  delete game.marketAgents!.pending;
  catchUp(game, now);
  if (game.marketAgents!.calls >= MARKET_CALL_LIMIT) game.market.agentNotice = "Jev call limit reached. Existing orders may still fill.";
  if (pending.expiresAt <= now || game.hand !== pending.hand || game.pausedAt !== undefined || game.poker.street === "complete" || now >= game.eventUntil) return game;
  if (!answers) {
    game.market.agentNotice = "Jev traders unavailable. Retrying; existing orders may still fill.";
    return game;
  }
  // Validate the entire response before changing any trader's orders.
  for (const trader of round.traders) {
    if (!Object.hasOwn(trader.choices, answers[trader.id])) throw new Error("Invalid market action.");
  }
  // Rotate the first arrival so no trader always receives batch priority.
  // A poker action can arrive while Jev is thinking. These bounded, unexpired
  // limit orders may still execute in the same hand, just like delayed human
  // orders. The matcher rechecks current cash, inventory and folded outcomes;
  // discarding every older revision would starve a realtime market entirely.
  const first = game.market.tick % round.traders.length;
  const arrivals = [...round.traders.slice(first), ...round.traders.slice(0, first)];
  for (const trader of arrivals) {
    if (answers[trader.id] !== "hold") game.market = replaceTraderOrders(game.market, trader.id, trader.choices[answers[trader.id]]);
  }
  game.market.agentNotice = game.marketAgents!.calls >= MARKET_CALL_LIMIT ? "Jev call limit reached. Existing orders may still fill." : null;
  return game;
}
