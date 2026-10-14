/** A funded, deterministic four-outcome exchange. Never send MarketState to a client. */
export const JEV_MARKET_CALL_LIMIT = 600;
export const UNITS_PER_CREDIT = 120_000;
const UNITS_PER_CENT = UNITS_PER_CREDIT / 100;
const OUTCOMES = 4;
const HUMAN = "human";

export type MarketDriver = "local" | "jev";
export type TraderOrder = { outcome: number; side: "buy" | "sell"; quantity: number; priceTicks: number };
export type Side = "buy" | "sell";
export type OrderType = "ioc" | "limit";
export type TraderKind = "maker" | "fundamental" | "equity" | "momentum" | "contrarian" | "noise";
export interface HumanOrderInput {
  outcome: number;
  side: Side;
  quantity: number;
  limitPrice: number;
  orderType: OrderType;
}
export interface DepthLevel { price: number; quantity: number }
export interface PublicFill {
  id: string; tick: number; outcome: number; price: number; quantity: number;
  side: Side; buyer: "you" | "market"; seller: "you" | "market";
}
export interface PublicOrder {
  id: string; outcome: number; side: Side; quantity: number;
  remainingQuantity: number; limitPrice: number; createdAt: number;
}
export interface MarketBookView {
  outcome: number; bids: DepthLevel[]; asks: DepthLevel[];
  bestBid: number | null; bestAsk: number | null; midpoint: number | null;
  lastPrice: number | null; volume: number;
}
export interface PositionView {
  outcome: number; quantity: number; availableQuantity: number;
  costBasis: number; averageCost: number;
  liquidationValue: number; unrealizedPnl: number; unliquidatedQuantity: number;
}
export interface TraderPositionView {
  id: string; name: string; kind: TraderKind; holdings: number[];
  initialSharesPerOutcome: number; netFilledShares: number[] | null; openOrders: number;
}
export interface MarketTradeView {
  id: string; tick: number; outcome: number; price: number; quantity: number;
  buyer: { id: string; name: string }; seller: { id: string; name: string };
}
export interface MarketView {
  driver?: MarketDriver; agentNotice?: string | null;
  status: "open" | "settled"; tick: number; startingBankroll: number;
  cash: number; availableCash: number; reservedCash: number;
  totalLiquidationValue: number; pnl: number; realizedPnl: number;
  positions: PositionView[]; books: MarketBookView[]; openOrders: PublicOrder[];
  fills: PublicFill[]; history: { tick: number; prices: (number | null)[] }[];
  traderPositions: TraderPositionView[]; recentTrades: MarketTradeView[];
  payouts: number[] | null;
}
export interface OrderResult {
  orderId: string; status: "filled" | "partial" | "open" | "cancelled";
  filledQuantity: number; remainingQuantity: number;
  averagePrice: number | null; total: number; fills: PublicFill[];
}
export interface Account {
  id: string; cashUnits: number; shares: number[];
  costBasisUnits: number[]; realizedPnlUnits: number;
  /** Preserve executed inventory at settlement; current shares are then redeemed to zero. */
  settlementHoldings?: number[];
}
export interface RestingOrder {
  id: string; owner: string; outcome: number; side: Side;
  priceTicks: number; quantity: number; remaining: number;
  sequence: number; createdAt: number; expiresAt: number | null;
}
export interface Trader {
  id: string; kind: TraderKind; bias: number[]; beliefs: number[];
  reaction: number; nextWake: number; seenRevision: number;
}
export interface InternalFill {
  id: string; tick: number; outcome: number; priceTicks: number;
  quantity: number; buyer: string; seller: string; aggressorSide: Side;
}
export interface MarketState {
  driver?: MarketDriver; agentNotice?: string | null;
  version: 1; status: "open" | "settled"; tick: number; rngState: number;
  sequence: number; revision: number; values: number[];
  startingBankrollUnits: number; initialTotalCashUnits: number;
  collateralUnits: number; completeSetsIssued: number;
  accounts: Record<string, Account>; traders: Trader[]; orders: RestingOrder[];
  fills: InternalFill[]; lastPriceTicks: (number | null)[]; volumes: number[];
  history: { tick: number; prices: (number | null)[] }[];
  payouts: number[] | null;
}

function copy(state: MarketState): MarketState { return structuredClone(state); }
function seededShares(kind: TraderKind): number { return kind === "maker" ? 700 : 240; }
function random(state: MarketState): number {
  let x = state.rngState;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  state.rngState = x >>> 0;
  return state.rngState / 4294967296;
}
function integer(state: MarketState, min: number, max: number): number {
  return min + Math.floor(random(state) * (max - min + 1));
}
function validateValues(values: number[]): number[] {
  if (values.length !== OUTCOMES || values.some(v => !Number.isFinite(v) || v < 0 || v > 1)) {
    throw new Error("Expected four finite outcome values between zero and one.");
  }
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) throw new Error("Outcome values must have a positive sum.");
  return values.map(v => v / total);
}
function reservedCash(state: MarketState, owner: string): number {
  return state.orders.reduce((sum, o) => sum + (o.owner === owner && o.side === "buy" ? o.remaining * o.priceTicks * UNITS_PER_CENT : 0), 0);
}
function availableCash(state: MarketState, owner: string): number {
  return state.accounts[owner].cashUnits - reservedCash(state, owner);
}
function availableShares(state: MarketState, owner: string, outcome: number): number {
  return state.accounts[owner].shares[outcome] - state.orders.reduce((sum, o) => sum + (o.owner === owner && o.side === "sell" && o.outcome === outcome ? o.remaining : 0), 0);
}
function publicFill(fill: InternalFill): PublicFill {
  return { id: fill.id, tick: fill.tick, outcome: fill.outcome, price: fill.priceTicks / 100,
    quantity: fill.quantity, side: fill.buyer === HUMAN ? "buy" : fill.seller === HUMAN ? "sell" : fill.aggressorSide,
    buyer: fill.buyer === HUMAN ? "you" : "market", seller: fill.seller === HUMAN ? "you" : "market" };
}
function transfer(state: MarketState, buyerId: string, sellerId: string, outcome: number, quantity: number, priceTicks: number, side: Side): InternalFill {
  const buyer = state.accounts[buyerId], seller = state.accounts[sellerId];
  const paid = priceTicks * UNITS_PER_CENT * quantity;
  const basis = seller.shares[outcome] === 0 ? 0 : seller.costBasisUnits[outcome] * quantity / seller.shares[outcome];
  buyer.cashUnits -= paid; seller.cashUnits += paid;
  buyer.shares[outcome] += quantity; seller.shares[outcome] -= quantity;
  buyer.costBasisUnits[outcome] += paid; seller.costBasisUnits[outcome] -= basis;
  seller.realizedPnlUnits += paid - basis;
  if (seller.shares[outcome] === 0) seller.costBasisUnits[outcome] = 0;
  const fill = { id: `fill-${++state.sequence}`, tick: state.tick, outcome, priceTicks, quantity,
    buyer: buyerId, seller: sellerId, aggressorSide: side };
  state.fills.push(fill);
  if (state.fills.length > 250) state.fills.splice(0, state.fills.length - 250);
  state.lastPriceTicks[outcome] = priceTicks; state.volumes[outcome] += quantity;
  return fill;
}

/** Internal matching primitive; callers have already validated/reserved available funding. */
function submit(state: MarketState, owner: string, outcome: number, side: Side, quantity: number, priceTicks: number, orderType: OrderType, expiresAt: number | null = null): OrderResult {
  const order: RestingOrder = { id: `order-${++state.sequence}`, owner, outcome, side, priceTicks,
    quantity, remaining: quantity, sequence: state.sequence, createdAt: state.tick, expiresAt };
  const opposing = state.orders.filter(o => o.outcome === outcome && o.side !== side && o.remaining > 0 &&
    (side === "buy" ? o.priceTicks <= priceTicks : o.priceTicks >= priceTicks))
    .sort((a, b) => (side === "buy" ? a.priceTicks - b.priceTicks : b.priceTicks - a.priceTicks) || a.sequence - b.sequence);
  const fills: InternalFill[] = [];
  for (const resting of opposing) {
    if (order.remaining === 0) break;
    // Cancel the maker side of a self-cross. It must never print a trade or inflate volume.
    if (resting.owner === owner) {
      state.orders = state.orders.filter(o => o.id !== resting.id);
      continue;
    }
    const amount = Math.min(order.remaining, resting.remaining);
    fills.push(transfer(state, side === "buy" ? owner : resting.owner, side === "sell" ? owner : resting.owner,
      outcome, amount, resting.priceTicks, side));
    order.remaining -= amount; resting.remaining -= amount;
  }
  state.orders = state.orders.filter(o => o.remaining > 0);
  if (order.remaining > 0 && orderType === "limit") state.orders.push(order);
  const filledQuantity = quantity - order.remaining;
  const totalUnits = fills.reduce((sum, f) => sum + f.quantity * f.priceTicks * UNITS_PER_CENT, 0);
  return { orderId: order.id, status: order.remaining === 0 ? "filled" : filledQuantity > 0 ? "partial" : orderType === "limit" ? "open" : "cancelled",
    filledQuantity, remainingQuantity: order.remaining, averagePrice: filledQuantity ? totalUnits / UNITS_PER_CREDIT / filledQuantity : null,
    total: totalUnits / UNITS_PER_CREDIT, fills: fills.map(publicFill) };
}

function safeSubmit(state: MarketState, owner: string, outcome: number, side: Side, quantity: number, priceTicks: number, expiresAt: number): void {
  if (priceTicks < 1 || priceTicks > 99) return;
  const capacity = side === "buy" ? Math.floor(availableCash(state, owner) / (priceTicks * UNITS_PER_CENT)) : availableShares(state, owner, outcome);
  const size = Math.min(quantity, capacity);
  if (size > 0) submit(state, owner, outcome, side, size, priceTicks, "limit", expiresAt);
}
function top(state: MarketState, outcome: number, side: Side): number | null {
  const prices = state.orders.filter(o => o.outcome === outcome && o.side === side).map(o => o.priceTicks);
  return prices.length ? (side === "buy" ? Math.max(...prices) : Math.min(...prices)) : null;
}
function mid(state: MarketState, outcome: number): number | null {
  const bid = top(state, outcome, "buy"), ask = top(state, outcome, "sell");
  return bid !== null && ask !== null ? (bid + ask) / 200 : state.lastPriceTicks[outcome] === null ? null : state.lastPriceTicks[outcome]! / 100;
}
function recordHistory(state: MarketState): void {
  const entry = { tick: state.tick, prices: Array.from({ length: OUTCOMES }, (_, i) => mid(state, i)) };
  if (state.history.at(-1)?.tick === state.tick) state.history[state.history.length - 1] = entry;
  else state.history.push(entry);
  if (state.history.length > 180) state.history.shift();
}
function beliefsFor(state: MarketState, trader: Trader): number[] {
  const weights = state.values.map((value, i) => {
    if (value === 0) return 0;
    const bias = trader.bias[i];
    const previous = state.history[Math.max(0, state.history.length - 5)]?.prices[i];
    const current = mid(state, i);
    const momentum = current !== null && previous !== null && previous !== undefined ? current - previous : 0;
    const transformed = trader.kind === "equity" ? Math.pow(value, 0.75) : value;
    const noise = trader.kind === "noise" ? (random(state) - 0.5) * 0.9 : (random(state) - 0.5) * 0.08;
    return transformed * Math.exp(bias + noise + (trader.kind === "momentum" ? momentum * 4 : trader.kind === "contrarian" ? -momentum * 3 : 0));
  });
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map(v => v / total);
}
function wakeTrader(state: MarketState, trader: Trader): void {
  state.orders = state.orders.filter(o => o.owner !== trader.id);
  trader.beliefs = beliefsFor(state, trader);
  trader.seenRevision = state.revision;
  const outcomes = trader.kind === "maker" ? [0, 1, 2, 3] : [integer(state, 0, OUTCOMES - 1)];
  for (const outcome of outcomes) {
    if (state.values[outcome] === 0) continue;
    const inventory = state.accounts[trader.id].shares[outcome];
    const meanInventory = state.accounts[trader.id].shares.reduce((a, b) => a + b, 0) / OUTCOMES;
    const inventorySkew = Math.max(-0.08, Math.min(0.08, (inventory - meanInventory) * 0.00035));
    const fair = Math.max(0.005, Math.min(0.995, trader.beliefs[outcome] - inventorySkew));
    if (trader.kind === "maker") {
      const spread = 0.015 + random(state) * 0.015;
      for (let level = 0; level < 3; level++) {
        const quantity = integer(state, 8, 20) + level * 8;
        const bid = Math.floor((fair - spread - level * 0.025) * 100);
        const ask = Math.ceil((fair + spread + level * 0.025) * 100);
        safeSubmit(state, trader.id, outcome, "buy", quantity, bid, state.tick + 18);
        safeSubmit(state, trader.id, outcome, "sell", quantity, ask, state.tick + 18);
      }
    } else {
      const quantity = integer(state, 3, trader.kind === "noise" ? 12 : 20);
      const offset = (random(state) - 0.5) * (trader.kind === "noise" ? 0.08 : 0.03);
      const fairTicks = Math.max(1, Math.min(99, Math.round((fair + offset) * 100)));
      const bestBid = top(state, outcome, "buy"), bestAsk = top(state, outcome, "sell");
      const side: Side = bestAsk !== null && fairTicks >= bestAsk ? "buy"
        : bestBid !== null && fairTicks <= bestBid ? "sell" : random(state) < 0.5 ? "buy" : "sell";
      safeSubmit(state, trader.id, outcome, side, quantity, fairTicks, state.tick + integer(state, 8, 20));
    }
  }
  trader.nextWake = state.tick + trader.reaction + integer(state, 0, 3);
}

export function createMarket(values: number[], seed: number, bankroll = 1000, driver: MarketDriver = "local"): MarketState {
  if (!Number.isFinite(bankroll) || bankroll < 0 || bankroll > 10_000_000) throw new Error("Invalid bankroll.");
  const normalized = validateValues(values), startingBankrollUnits = Math.round(bankroll * UNITS_PER_CREDIT);
  const state: MarketState = { driver, agentNotice: driver === "jev" ? "Jev traders are preparing orders." : null, version: 1, status: "open", tick: 0, rngState: (seed >>> 0) || 0x9e3779b9,
    sequence: 0, revision: 0, values: normalized, startingBankrollUnits, initialTotalCashUnits: startingBankrollUnits,
    collateralUnits: 0, completeSetsIssued: 0, accounts: {}, traders: [], orders: [], fills: [],
    lastPriceTicks: [null, null, null, null], volumes: [0, 0, 0, 0], history: [], payouts: null };
  state.accounts[HUMAN] = { id: HUMAN, cashUnits: startingBankrollUnits, shares: [0, 0, 0, 0], costBasisUnits: [0, 0, 0, 0], realizedPnlUnits: 0 };
  const kinds: TraderKind[] = ["maker", "maker", "fundamental", "fundamental", "fundamental", "fundamental", "equity", "equity", "equity", "momentum", "momentum", "contrarian", "contrarian", "noise", "noise", "noise"];
  kinds.forEach((kind, index) => {
    const id = `trader-${index}`, funding = (kind === "maker" ? 1800 : 800) * UNITS_PER_CREDIT;
    const sets = seededShares(kind);
    state.initialTotalCashUnits += funding;
    state.collateralUnits += sets * UNITS_PER_CREDIT; state.completeSetsIssued += sets;
    state.accounts[id] = { id, cashUnits: funding - sets * UNITS_PER_CREDIT, shares: [sets, sets, sets, sets],
      costBasisUnits: normalized.map(v => v * sets * UNITS_PER_CREDIT), realizedPnlUnits: 0 };
    state.traders.push({ id, kind, bias: normalized.map(() => (random(state) - 0.5) * (kind === "noise" ? 0.9 : kind === "maker" ? 0.15 : 0.45)),
      beliefs: [...normalized], reaction: kind === "maker" ? integer(state, 2, 4) : kind === "fundamental" ? integer(state, 2, 5) : integer(state, 4, 10), nextWake: 0, seenRevision: -1 });
  });
  // Seed real funded orders. Any opening prints are actual matches, not generated chart points.
  if (driver === "local") for (const trader of state.traders) wakeTrader(state, trader);
  recordHistory(state);
  return state;
}

export function advanceMarket(previous: MarketState, values?: number[], ticks = 1): MarketState {
  if (!Number.isInteger(ticks) || ticks < 0 || ticks > 1000) throw new Error("Invalid tick count.");
  const state = copy(previous);
  if (state.status === "settled") return state;
  if (values) {
    const nextValues = validateValues(values);
    if (nextValues.some((v, i) => Math.abs(v - state.values[i]) > 1e-12)) {
      state.values = nextValues; state.revision++;
      // Known-impossible contracts cannot remain an accidental stale-price prize.
      state.orders = state.orders.filter(o => nextValues[o.outcome] > 0);
      for (const trader of state.traders) trader.nextWake = Math.min(trader.nextWake, state.tick + integer(state, 1, trader.reaction));
    }
  }
  for (let step = 0; step < ticks; step++) {
    state.tick++;
    state.orders = state.orders.filter(o => o.expiresAt === null || o.expiresAt > state.tick);
    // Shuffle due agents by seeded arrival jitter to avoid permanent array-order advantage.
    const due = state.traders.filter(t => t.nextWake <= state.tick).map(trader => ({ trader, priority: random(state) })).sort((a, b) => a.priority - b.priority);
    if (state.driver !== "jev") for (const { trader } of due) wakeTrader(state, trader);
    recordHistory(state);
  }
  return state;
}

export function placeHumanOrder(previous: MarketState, input: HumanOrderInput): { state: MarketState; result: OrderResult } {
  if (previous.status !== "open") throw new Error("This market has settled.");
  if (!Number.isInteger(input.outcome) || input.outcome < 0 || input.outcome >= OUTCOMES) throw new Error("Invalid outcome.");
  if (input.side !== "buy" && input.side !== "sell") throw new Error("Invalid order side.");
  if (input.orderType !== "ioc" && input.orderType !== "limit") throw new Error("Invalid order type.");
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 100_000) throw new Error("Quantity must be a positive whole number of shares.");
  const ticks = Math.round(input.limitPrice * 100);
  if (!Number.isFinite(input.limitPrice) || ticks < 1 || ticks > 99 || Math.abs(input.limitPrice * 100 - ticks) > 1e-7) throw new Error("Limit price must be from 0.01 to 0.99 in one-cent increments.");
  if (previous.values[input.outcome] === 0) throw new Error("This outcome can no longer pay out.");
  const cost = input.quantity * ticks * UNITS_PER_CENT;
  if (input.side === "buy" && cost > availableCash(previous, HUMAN)) throw new Error("Insufficient available cash for that limit order.");
  if (input.side === "sell" && input.quantity > availableShares(previous, HUMAN, input.outcome)) throw new Error("Insufficient available shares.");
  const state = copy(previous);
  const result = submit(state, HUMAN, input.outcome, input.side, input.quantity, ticks, input.orderType);
  recordHistory(state);
  return { state, result };
}

export function cancelHumanOrder(previous: MarketState, id: string): MarketState {
  const state = copy(previous);
  const order = state.orders.find(o => o.id === id);
  if (order && order.owner !== HUMAN) throw new Error("You can only cancel your own orders.");
  state.orders = state.orders.filter(o => o.id !== id);
  recordHistory(state);
  return state;
}

export function settleMarket(previous: MarketState, payouts: number[]): MarketState {
  if (payouts.length !== OUTCOMES || payouts.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error("Invalid settlement payouts.");
  const winners = payouts.filter(v => v > 0).length;
  if (winners === 0 || payouts.some(v => v > 0 && Math.abs(v - 1 / winners) > 1e-10)) throw new Error("Main-pot winners must split one dollar equally.");
  if (previous.status === "settled") {
    if (previous.payouts!.some((v, i) => Math.abs(v - payouts[i]) > 1e-10)) throw new Error("A settled market cannot be changed.");
    return copy(previous);
  }
  const state = copy(previous);
  const units = payouts.map(v => v === 0 ? 0 : UNITS_PER_CREDIT / winners);
  state.orders = [];
  for (const account of Object.values(state.accounts)) {
    account.settlementHoldings = [...account.shares];
    for (let outcome = 0; outcome < OUTCOMES; outcome++) {
      const payout = account.shares[outcome] * units[outcome];
      account.cashUnits += payout; state.collateralUnits -= payout;
      account.realizedPnlUnits += payout - account.costBasisUnits[outcome];
      account.shares[outcome] = 0; account.costBasisUnits[outcome] = 0;
    }
  }
  if (state.collateralUnits !== 0) throw new Error("Settlement collateral invariant failed.");
  state.status = "settled"; state.payouts = [...payouts];
  return state;
}

function depth(state: MarketState, outcome: number, side: Side): DepthLevel[] {
  const levels = new Map<number, number>();
  for (const order of state.orders) if (order.outcome === outcome && order.side === side) levels.set(order.priceTicks, (levels.get(order.priceTicks) ?? 0) + order.remaining);
  return [...levels].sort(([a], [b]) => side === "buy" ? b - a : a - b).map(([priceTicks, quantity]) => ({ price: priceTicks / 100, quantity }));
}

/** Public projection: executed holdings and named fills, never seeds, future data, synthetic cash balances, or beliefs. */
export function getMarketView(state: MarketState): MarketView {
  const human = state.accounts[HUMAN];
  const kindNames: Record<TraderKind, string> = { maker: "Maker", fundamental: "Value", equity: "Equity", momentum: "Momentum", contrarian: "Contrarian", noise: "Noise" };
  const kindCounts = new Map<TraderKind, number>();
  const names = new Map<string, string>([[HUMAN, "You"]]);
  for (const trader of state.traders) {
    const index = (kindCounts.get(trader.kind) ?? 0) + 1;
    kindCounts.set(trader.kind, index);
    names.set(trader.id, `${kindNames[trader.kind]} ${index}`);
  }
  const traderPositions: TraderPositionView[] = state.traders.map(trader => {
    const account = state.accounts[trader.id];
    const initialSharesPerOutcome = seededShares(trader.kind);
    const executedHoldings = state.status === "settled" ? account.settlementHoldings : account.shares;
    return { id: trader.id, name: names.get(trader.id)!, kind: trader.kind, holdings: [...account.shares], initialSharesPerOutcome,
      // Legacy settled sessions have no pre-redemption snapshot. Never present redemption as a sale.
      netFilledShares: executedHoldings?.map(quantity => quantity - initialSharesPerOutcome) ?? null,
      openOrders: state.orders.filter(order => order.owner === trader.id).length };
  });
  const participant = (id: string) => ({ id, name: names.get(id) ?? "Trader" });
  const positions: PositionView[] = human.shares.map((quantity, outcome) => {
    let remaining = quantity, valueUnits = 0;
    const bids = state.orders.filter(o => o.owner !== HUMAN && o.outcome === outcome && o.side === "buy").sort((a, b) => b.priceTicks - a.priceTicks || a.sequence - b.sequence);
    for (const bid of bids) {
      const sold = Math.min(remaining, bid.remaining);
      valueUnits += sold * bid.priceTicks * UNITS_PER_CENT; remaining -= sold;
      if (remaining === 0) break;
    }
    return { outcome, quantity, availableQuantity: availableShares(state, HUMAN, outcome), costBasis: human.costBasisUnits[outcome] / UNITS_PER_CREDIT,
      averageCost: quantity ? human.costBasisUnits[outcome] / UNITS_PER_CREDIT / quantity : 0,
      liquidationValue: valueUnits / UNITS_PER_CREDIT, unrealizedPnl: (valueUnits - human.costBasisUnits[outcome]) / UNITS_PER_CREDIT, unliquidatedQuantity: remaining };
  });
  const totalLiquidationValue = human.cashUnits / UNITS_PER_CREDIT + positions.reduce((sum, p) => sum + p.liquidationValue, 0);
  return { status: state.status, tick: state.tick, startingBankroll: state.startingBankrollUnits / UNITS_PER_CREDIT,
    driver: state.driver ?? "local", agentNotice: state.agentNotice ?? null,
    cash: human.cashUnits / UNITS_PER_CREDIT, availableCash: availableCash(state, HUMAN) / UNITS_PER_CREDIT,
    reservedCash: reservedCash(state, HUMAN) / UNITS_PER_CREDIT, totalLiquidationValue,
    pnl: totalLiquidationValue - state.startingBankrollUnits / UNITS_PER_CREDIT, realizedPnl: human.realizedPnlUnits / UNITS_PER_CREDIT,
    positions, books: Array.from({ length: OUTCOMES }, (_, outcome) => {
      const bids = depth(state, outcome, "buy"), asks = depth(state, outcome, "sell");
      return { outcome, bids, asks, bestBid: bids[0]?.price ?? null, bestAsk: asks[0]?.price ?? null,
        midpoint: bids.length && asks.length ? (bids[0].price + asks[0].price) / 2 : null,
        lastPrice: state.lastPriceTicks[outcome] === null ? null : state.lastPriceTicks[outcome]! / 100, volume: state.volumes[outcome] };
    }), openOrders: state.orders.filter(o => o.owner === HUMAN).map(o => ({ id: o.id, outcome: o.outcome, side: o.side, quantity: o.quantity,
      remainingQuantity: o.remaining, limitPrice: o.priceTicks / 100, createdAt: o.createdAt })),
    fills: state.fills.slice(-20).reverse().map(publicFill),
    traderPositions, recentTrades: state.fills.slice(-20).reverse().map(fill => ({ id: fill.id, tick: fill.tick, outcome: fill.outcome,
      price: fill.priceTicks / 100, quantity: fill.quantity, buyer: participant(fill.buyer), seller: participant(fill.seller) })),
    history: state.history.map(h => ({ tick: h.tick, prices: [...h.prices] })), payouts: state.payouts ? [...state.payouts] : null };
}

/** Jev selects bounded candidates; this engine still enforces inventory and funding. */
export function replaceTraderOrders(previous: MarketState, owner: string, orders: TraderOrder[]): MarketState {
  if (previous.driver !== "jev" || previous.status !== "open") throw new Error("Jev market is not open.");
  if (!previous.traders.some(t => t.id === owner)) throw new Error("Unknown trader.");
  if (orders.length > 24 || orders.some(o => !Number.isInteger(o.outcome) || o.outcome < 0 || o.outcome >= OUTCOMES || !["buy", "sell"].includes(o.side) || !Number.isSafeInteger(o.quantity) || o.quantity < 1 || o.quantity > 25 || !Number.isInteger(o.priceTicks) || o.priceTicks < 1 || o.priceTicks > 99)) throw new Error("Invalid trader order.");
  const state = copy(previous);
  state.orders = state.orders.filter(o => o.owner !== owner);
  for (const order of orders) {
    if (state.values[order.outcome] > 0) safeSubmit(state, owner, order.outcome, order.side, order.quantity, order.priceTicks, state.tick + 12);
  }
  recordHistory(state);
  return state;
}
