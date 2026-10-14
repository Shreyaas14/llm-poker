import { createHand, applyAction, getObservation, decidePractice, estimateValues, evaluateHand, assignedStyle, shuffledClasses } from "./poker.ts";
import { marketProbabilities } from "./market-pricing.ts";
import type { MarketAgentRun } from "./market-agents.ts";
import type { MarketDriver } from "./market.ts";
import type { PokerState, Action } from "./poker.ts";
import { JEV_MARKET_CALL_LIMIT, createMarket, advanceMarket, reactMarket, placeHumanOrder, cancelHumanOrder, settleMarket, getMarketView } from "./market.ts";
import type { HumanOrderInput, MarketState, OrderResult } from "./market.ts";
import type { Activity, GameMode, HandResult, SessionCommand, SessionView, ShowdownOdds } from "../app/types.ts";
import { DEFAULT_MODELS } from "./providers.ts";
import { equityKey, showdownEquity } from "./equity.ts";

export const RULES_VERSION = "river-1";
export const TRADING_WINDOW_MS = 45000;
export type Game = {
  marketAgents?: MarketAgentRun;
  rulesVersion: string; id: string; mode: GameMode; ranked: boolean; rankEligible: boolean;
  hand: number; poker: PokerState; market: MarketState; models: string[];
  results: HandResult[]; activity: Activity[]; sequence: number; version: number;
  cashBefore: number; eventUntil: number; lastTickAt: number; values: number[];
  // Absent in running games, including sessions saved before playback controls.
  pausedAt?: number;
  // Process an information-driven arrival batch after the changed table has
  // been published, independently of the elapsed-time clock.
  marketReactionPending?: boolean;
  requestIds: string[]; createdAt: number; notice: string | null; providerCalls: number;
  // Optional for saved sessions created before card equity was introduced.
  odds?: ShowdownOdds; oddsKey?: string;
  replayVersion?: 1;
};
// Old persisted sessions hydrate lazily; this bounded cache also covers repeated
// reads before their first command persists the new fields. Normal sessions
// carry the estimate in their saved snapshot, so market ticks do no sampling.
const equityCache = new Map<string, ShowdownOdds>();
function ensureOdds(game: Game): ShowdownOdds {
  const key = equityKey(game.poker);
  if (game.odds && game.oddsKey === key) return game.odds;
  let odds = equityCache.get(key);
  if (!odds) {
    odds = showdownEquity(game.poker);
    if (equityCache.size >= 128) equityCache.delete(equityCache.keys().next().value!);
    equityCache.set(key, odds);
  }
  game.odds = { ...odds, equities: [...odds.equities] };
  game.oddsKey = key;
  return game.odds;
}
export class GameError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "invalid_command") { super(message); this.status = status; this.code = code; }
}
export function randomSeed(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), v => v.toString(16).padStart(2, "0")).join("");
}
function randomNumber(): number { return crypto.getRandomValues(new Uint32Array(1))[0]; }
function log(game: Game, text: string, kind: Activity["kind"], now: number) {
  game.activity.push({ id: `${game.id}:${++game.sequence}`, hand: game.hand, text, kind, at: new Date(now).toISOString() });
  game.activity = game.activity.slice(-100);
}
function tradeReceipt(input: HumanOrderInput, result: OrderResult, name: string): string {
  const buying = input.side === "buy";
  const execution = result.filledQuantity
    ? `${buying ? "Bought" : "Sold"} ${result.filledQuantity} of ${input.quantity} ${name} shares at ${((result.averagePrice ?? 0) * 100).toFixed(1)}¢ average.`
    : `No fill: 0 of ${input.quantity} ${name} shares ${buying ? "bought" : "sold"}.`;
  const payment = `${buying ? "Paid" : "Received"} $${result.total.toFixed(2)}.`;
  const remainder = result.remainingQuantity === 0 ? "" : input.orderType === "limit"
    ? ` ${result.remainingQuantity} shares remain open at ${Math.round(input.limitPrice * 100)}¢.`
    : ` ${result.remainingQuantity} unfilled shares canceled.`;
  return `${execution} ${payment}${remainder}`;
}
export function createGame(id: string, mode: GameMode, ranked: boolean, now = Date.now(), models: string[] = [...DEFAULT_MODELS], personalitiesEnabled = false, marketDriver: MarketDriver = "local"): Game {
  const poker = createHand(randomSeed(), randomNumber() % 4, 1000, personalitiesEnabled ? shuffledClasses(randomSeed()) : undefined, personalitiesEnabled);
  const values = estimateValues(poker, randomNumber(), 512);
  const game: Game = {
    rulesVersion: RULES_VERSION, id, mode, ranked, rankEligible: true, hand: 1,
    poker, market: createMarket(marketDriver === "jev" ? [1, 1, 1, 1] : values, randomNumber(), 1000, marketDriver), models,
    results: [], activity: [], sequence: 0, version: 0, cashBefore: 1000,
    eventUntil: now + TRADING_WINDOW_MS, lastTickAt: now, values,
    requestIds: [], createdAt: now, notice: null, providerCalls: 0, replayVersion: 1,
  };
  ensureOdds(game);
  log(game, mode === "live" ? "Four independent model seats are ready. You trade the outcome." : "Practice decision models are ready. You trade the outcome.", "system", now);
  return game;
}
function isPlaying(game: Game) { return game.poker.street !== "complete"; }
export function catchUp(game: Game, now: number) {
  if (!isPlaying(game) || game.pausedAt !== undefined) return;
  const until = Math.min(now, game.eventUntil);
  const ticks = Math.max(0, Math.min(45, Math.floor((until - game.lastTickAt) / 1000)));
  if (ticks) {
    game.market = advanceMarket(game.market, undefined, ticks);
    game.lastTickAt += ticks * 1000;
  }
  if (game.marketReactionPending) {
    game.market = reactMarket(game.market);
    delete game.marketReactionPending;
  }
}
export type LiveDecision = (observation: ReturnType<typeof getObservation>, model: string, feedback?: string) => Promise<Action>;
export type PreparedPokerDecision = { action: Action; calls: number; hand: number; pokerRevision: number };

/** Resolve a decision from a fixed poker observation; no market state is committed here. */
export async function preparePokerDecision(game: Game, chooseLive?: LiveDecision): Promise<PreparedPokerDecision> {
  if (!isPlaying(game) || game.poker.actor === null) throw new GameError("This hand is already settled.");
  const observation = getObservation(game.poker, game.poker.actor);
  let action: Action, calls = 0;
  if (game.mode === "live") {
    if (!chooseLive) throw new GameError("Live model access is not configured.", 503, "provider_unavailable");
    if (game.providerCalls >= 320) throw new GameError("This run reached its model-call limit.", 429, "call_limit");
    action = await chooseLive(observation, game.models[game.poker.actor]); calls++;
    try { applyAction(game.poker, action); }
    catch (error) {
      action = await chooseLive(observation, game.models[game.poker.actor], error instanceof Error ? error.message : "Illegal action"); calls++;
    }
  } else action = decidePractice(observation, randomNumber());
  applyAction(game.poker, action); // Validate before entering the commit/retry phase.
  return { action, calls, hand: game.hand, pokerRevision: game.poker.revision };
}

export async function commandGame(source: Game, command: SessionCommand, now: number, chooseLive?: LiveDecision, prepared?: PreparedPokerDecision): Promise<Game> {
  const game = structuredClone(source);
  ensureOdds(game);
  if (command.type === "playback") {
    if (game.marketAgents) delete game.marketAgents.pending;
    if (command.paused && game.pausedAt === undefined) {
      catchUp(game, now);
      game.pausedAt = now;
    } else if (!command.paused && game.pausedAt !== undefined) {
      const elapsed = Math.max(0, now - game.pausedAt);
      game.eventUntil += elapsed;
      game.lastTickAt += elapsed;
      delete game.pausedAt;
    }
    return game;
  }
  if (game.pausedAt !== undefined && !(command.type === "advance" && prepared)) {
    if (command.type === "tick") return game;
    throw new GameError("The game is paused. Press Play to continue trading and gameplay.", 409, "GAME_PAUSED");
  }
  catchUp(game, now);
  if (command.type === "tick") return game;
  if (command.type === "order") {
    const hand = command.hand ?? Math.max(1, Math.floor(command.pokerRevision / 10000));
    if (hand !== game.hand) throw new GameError("This hand has ended. Review the new market before trading.", 409, "stale_hand");
    if (!isPlaying(game)) throw new GameError("This hand has settled. Trading is closed.", 409, "hand_settled");
    let order;
    try { order = placeHumanOrder(game.market, command); }
    catch (error) { throw new GameError(error instanceof Error ? error.message : "This order could not be placed."); }
    const {state, result} = order;
    game.market = state;
    log(game, tradeReceipt(command, result, game.poker.players[command.outcome].name), "trade", now);
    return game;
  }
  if (command.type === "cancel") {
    const hand = command.hand ?? Math.max(1, Math.floor(command.pokerRevision / 10000));
    if (hand !== game.hand) throw new GameError("This hand has ended. Review your current orders.",409,"stale_hand");
    try { game.market = cancelHumanOrder(game.market, command.orderId); }
    catch { throw new GameError("You can only cancel your own orders."); }
    log(game, "Unfilled order canceled. Reserved funds released.", "trade", now);
    return game;
  }
  if (command.pokerRevision !== game.poker.revision) throw new GameError("The table has advanced. Refresh the current action.", 409, "stale_state");
  if (command.type === "next_hand") {
    if (isPlaying(game) || game.hand >= 5) throw new GameError("This hand is not ready to advance.");
    game.cashBefore = getMarketView(game.market).cash;
    game.hand += 1;
    if (game.marketAgents) { delete game.marketAgents.pending; game.marketAgents.nextAt = now; }
    game.poker = createHand(randomSeed(), (game.poker.button + 1) % 4, 1000, game.poker.personalitiesEnabled === false ? undefined : game.poker.players.map(player => assignedStyle(game.poker, player.seat)!.id), game.poker.personalitiesEnabled !== false);
    // Make the client guard unique across hands, including otherwise-identical preflop revisions.
    game.poker.revision += game.hand * 10000;
    ensureOdds(game);
    game.values = estimateValues(game.poker, randomNumber(), 512);
    game.market = createMarket(game.market.driver === "jev" ? [1, 1, 1, 1] : game.values, randomNumber(), game.cashBefore, game.market.driver ?? "local");
    game.eventUntil = now + TRADING_WINDOW_MS;
    game.lastTickAt = now;
    log(game, `Hand ${game.hand} dealt. Poker stacks reset; your trading balance carries forward.`, "system", now);
    return game;
  }
  if (!isPlaying(game) || game.poker.actor === null) throw new GameError("This hand is already settled.");
  const actor = game.poker.actor;
  const decision = prepared ?? await preparePokerDecision(game, chooseLive);
  if (decision.hand !== game.hand || decision.pokerRevision !== game.poker.revision)
    throw new GameError("The table has advanced. Refresh the current action.", 409, "stale_state");
  const action = decision.action;
  game.providerCalls += decision.calls;
  const oldStreet = game.poker.street;
  game.poker = applyAction(game.poker, action);
  ensureOdds(game);
  const name = game.poker.players[actor].name;
  log(game, `${name} ${action.type === "raise" ? `raises to ${action.amount}` : action.type === "call" ? "calls" : action.type === "fold" ? "folds" : "checks"}.`, "poker", now);
  if (game.poker.street !== oldStreet && game.poker.street !== "complete") log(game, `${game.poker.street[0].toUpperCase()}${game.poker.street.slice(1)} revealed.`, "poker", now);
  if (!isPlaying(game)) {
    game.market = settleMarket(game.market, game.poker.mainPotShares);
    const cashAfter = getMarketView(game.market).cash;
    const names = game.poker.mainPotWinners.map(i => game.poker.players[i].name).join(" and ");
    const description = `${names} ${game.poker.mainPotWinners.length > 1 ? "split" : "wins"} the main pot.`;
    game.results.push({hand: game.hand, winners: game.poker.mainPotWinners, payout: game.poker.mainPotShares, cashBefore: game.cashBefore, cashAfter, pnl: cashAfter - game.cashBefore, description});
    log(game, description, "poker", now);
    game.eventUntil = now;
  } else {
    game.values = estimateValues(game.poker, randomNumber(), 512);
    // Publish the changed poker state before any informed synthetic arrivals.
    game.market = advanceMarket(game.market, game.market.driver === "jev" ? game.poker.players.map(player => player.folded ? 0 : 1) : game.values, 0);
    // Jev markets receive only their provider-selected orders; a news event
    // must never silently substitute the local decision models.
    game.marketReactionPending = game.market.driver !== "jev";
    const activeAt = game.pausedAt ?? now;
    // Keep the fractional second accumulated before this action. Only exclude
    // time beyond the previous market deadline, when arrivals were suspended.
    game.lastTickAt += Math.max(0, activeAt - game.eventUntil);
    game.eventUntil = activeAt + TRADING_WINDOW_MS;
  }
  return game;
}
export function viewGame(game: Game, busy = false, now = Date.now()): SessionView {
  const odds = ensureOdds(game);
  const market = getMarketView(game.market);
  const ended = !isPlaying(game);
  if (!ended) {
    const marks = market.books.map(book => book.midpoint ?? book.lastPrice);
    market.probabilities = marketProbabilities(marks, game.poker.players.map(player => !player.folded));
    market.probabilityIndicative = game.poker.players.some(player => !player.folded && marks[player.seat] == null);
  }
  const paused = game.pausedAt !== undefined;
  if (!ended && game.market.driver === "jev" && (game.marketAgents?.calls ?? 0) >= JEV_MARKET_CALL_LIMIT && !(game.marketAgents?.pending && game.marketAgents.pending.expiresAt > now)) market.agentNotice = "Jev call limit reached. Existing orders may still fill.";
  const marketNow = game.pausedAt ?? now;
  return {
    id: game.id, version: game.version, pokerRevision: game.poker.revision, mode: game.mode,
    status: ended ? game.hand === 5 ? "complete" : "hand_complete" : "playing",
    replayAvailable: game.replayVersion === 1 && ended && game.hand === 5,
    busy, paused, hand: game.hand, totalHands: 5, startingBalance: 1000,
    personalitiesEnabled: game.poker.personalitiesEnabled !== false, ranked: game.ranked, rankEligible: game.rankEligible, notice: game.notice,
    street: game.poker.street, board: [...game.poker.board], actor: game.poker.actor,
    button: game.poker.button, pot: game.poker.pot,
    players: game.poker.players.map(p => {
      const style = assignedStyle(game.poker, p.seat);
      return { seat: p.seat, name: p.name, modelId: game.mode === "live" ? game.models[p.seat] : "Practice decision model", classId: style?.id ?? null, className: style?.name ?? null, description: style?.description ?? "No assigned personality.", stack: p.stack, cards: [...p.hole], bet: p.bet, contributed: p.contributed, folded: p.folded, allIn: p.allIn, lastAction: p.lastAction };
    }),
    winners: [...game.poker.mainPotWinners], winningCards: ended && game.poker.board.length === 5 ? [...new Set(game.poker.mainPotWinners.flatMap(seat => evaluateHand([...game.poker.players[seat].hole, ...game.poker.board]).cards))] : [],
    market, odds: { ...odds, equities: [...odds.equities] }, results: game.results, activity: game.activity,
    pnl: ended ? market.cash - 1000 : market.totalLiquidationValue - 1000,
    tradingOpen: !ended && !paused,
    marketSecondsRemaining: Math.max(0, Math.ceil((game.eventUntil - marketNow) / 1000)),
  };
}
