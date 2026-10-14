import test from "node:test";
import assert from "node:assert/strict";
import { createMarket, advanceMarket, placeHumanOrder, cancelHumanOrder, settleMarket, getMarketView, UNITS_PER_CREDIT } from "../lib/market.ts";
import type { MarketState, RestingOrder } from "../lib/market.ts";

const U = UNITS_PER_CREDIT;

function fixture(): MarketState {
  const state = createMarket([0.25, 0.25, 0.25, 0.25], 1);
  state.traders = []; state.orders = []; state.fills = []; state.history = [];
  state.sequence = 100; state.lastPriceTicks = [null, null, null, null]; state.volumes = [0, 0, 0, 0];
  state.collateralUnits = 100 * U; state.completeSetsIssued = 100; state.initialTotalCashUnits = 4000 * U;
  state.accounts = Object.fromEntries(["human", "a", "b", "c"].map(id => {
    const shares = id === "a" || id === "b" ? 50 : 0;
    return [id, { id, cashUnits: (1000 - shares) * U, shares: [shares, shares, shares, shares], costBasisUnits: [shares, shares, shares, shares].map(q => q * U / 4), realizedPnlUnits: 0 }];
  }));
  return state;
}

function addOrder(state: MarketState, owner: string, side: "buy" | "sell", priceTicks: number, quantity: number, outcome = 0): string {
  const sequence = ++state.sequence;
  const order: RestingOrder = { id: `fixture-${sequence}`, owner, outcome, side, priceTicks, quantity, remaining: quantity, sequence, createdAt: state.tick, expiresAt: null };
  state.orders.push(order);
  return order.id;
}

function assertLedger(state: MarketState): void {
  const accounts = Object.values(state.accounts);
  assert.equal(accounts.reduce((n, a) => n + a.cashUnits, 0) + state.collateralUnits, state.initialTotalCashUnits, "cash plus collateral is conserved");
  for (const account of accounts) {
    assert.ok(Number.isSafeInteger(account.cashUnits) && account.cashUnits >= 0, `${account.id} cash is funded`);
    assert.ok(account.shares.every(q => Number.isSafeInteger(q) && q >= 0));
    const reserved = state.orders.filter(o => o.owner === account.id && o.side === "buy").reduce((n, o) => n + o.remaining * o.priceTicks * U / 100, 0);
    assert.ok(reserved <= account.cashUnits, `${account.id} reserved cash is funded`);
    for (let i = 0; i < 4; i++) {
      const selling = state.orders.filter(o => o.owner === account.id && o.side === "sell" && o.outcome === i).reduce((n, o) => n + o.remaining, 0);
      assert.ok(selling <= account.shares[i], `${account.id} sells owned shares only`);
    }
  }
  for (let i = 0; i < 4; i++) assert.equal(accounts.reduce((n, a) => n + a.shares[i], 0), state.status === "settled" ? 0 : state.completeSetsIssued);
  assert.ok(state.fills.every(f => f.buyer !== f.seller), "no self-trade volume");
}

test("price-time priority, price improvement, and partial IOC fills", () => {
  const original = fixture();
  addOrder(original, "a", "sell", 30, 4);
  addOrder(original, "b", "sell", 25, 3);
  addOrder(original, "a", "sell", 25, 2);
  const before = JSON.stringify(original);
  const { state, result } = placeHumanOrder(original, { outcome: 0, side: "buy", quantity: 12, limitPrice: 0.31, orderType: "ioc" });
  assert.deepEqual(state.fills.map(f => [f.seller, f.priceTicks, f.quantity]), [["b", 25, 3], ["a", 25, 2], ["a", 30, 4]]);
  assert.equal(result.filledQuantity, 9); assert.equal(result.remainingQuantity, 3);
  assert.equal(result.status, "partial"); assert.equal(result.total, 2.45);
  assert.equal(getMarketView(state).cash, 997.55);
  assert.equal(state.orders.length, 0, "IOC remainder is cancelled");
  assert.equal(JSON.stringify(original), before, "input state was not mutated");
  assertLedger(state);
});

test("limit orders reserve funds, survive partial execution, and release on cancellation", () => {
  const original = fixture(); addOrder(original, "a", "sell", 20, 2);
  const { state, result } = placeHumanOrder(original, { outcome: 0, side: "buy", quantity: 7, limitPrice: 0.25, orderType: "limit" });
  assert.equal(result.status, "partial");
  assert.equal(getMarketView(state).reservedCash, 1.25);
  assert.equal(getMarketView(state).availableCash, 998.35);
  assert.equal(getMarketView(state).openOrders[0].remainingQuantity, 5);
  const cancelled = cancelHumanOrder(state, result.orderId);
  assert.equal(getMarketView(cancelled).reservedCash, 0);
  assert.equal(getMarketView(cancelled).cash, 999.6);
  assert.deepEqual(cancelHumanOrder(cancelled, result.orderId), cancelled, "cancellation is safely repeatable");
  assertLedger(cancelled);
});

test("no naked sells, double reservation, fractional shares, or off-tick prices", () => {
  const state = fixture();
  assert.throws(() => placeHumanOrder(state, { outcome: 0, side: "sell", quantity: 1, limitPrice: 0.25, orderType: "limit" }), /shares/);
  const reserved = placeHumanOrder(state, { outcome: 0, side: "buy", quantity: 2000, limitPrice: 0.5, orderType: "limit" }).state;
  assert.throws(() => placeHumanOrder(reserved, { outcome: 1, side: "buy", quantity: 1, limitPrice: 0.01, orderType: "limit" }), /available cash/);
  assert.throws(() => placeHumanOrder(state, { outcome: 0, side: "buy", quantity: 1.5, limitPrice: 0.25, orderType: "limit" }), /whole/);
  assert.throws(() => placeHumanOrder(state, { outcome: 0, side: "buy", quantity: 1, limitPrice: 0.255, orderType: "limit" }), /increments/);
  assertLedger(reserved);
});

test("a crossed own order cancels instead of printing a fake trade", () => {
  let state = fixture(); addOrder(state, "a", "sell", 20, 10);
  state = placeHumanOrder(state, { outcome: 0, side: "buy", quantity: 10, limitPrice: 0.2, orderType: "ioc" }).state;
  state = placeHumanOrder(state, { outcome: 0, side: "sell", quantity: 10, limitPrice: 0.3, orderType: "limit" }).state;
  const volume = state.volumes[0];
  const crossed = placeHumanOrder(state, { outcome: 0, side: "buy", quantity: 10, limitPrice: 0.3, orderType: "ioc" });
  assert.equal(crossed.result.filledQuantity, 0); assert.equal(crossed.state.volumes[0], volume);
  assert.equal(getMarketView(crossed.state).openOrders.length, 0);
  assertLedger(crossed.state);
});

test("liquidation walks finite external bids and cannot be inflated by one's own order", () => {
  let state = fixture(); addOrder(state, "a", "sell", 25, 10);
  state = placeHumanOrder(state, { outcome: 0, side: "buy", quantity: 10, limitPrice: 0.25, orderType: "ioc" }).state;
  addOrder(state, "b", "buy", 20, 3); addOrder(state, "c", "buy", 10, 2);
  state = placeHumanOrder(state, { outcome: 0, side: "buy", quantity: 1, limitPrice: 0.99, orderType: "limit" }).state;
  const view = getMarketView(state);
  assert.equal(view.positions[0].liquidationValue, 0.8);
  assert.equal(view.positions[0].unliquidatedQuantity, 5);
  assert.equal(view.totalLiquidationValue, 998.3);
  assertLedger(state);
});

test("roundtrip pays the spread; original cost basis and realized PnL reconcile", () => {
  let state = fixture(); addOrder(state, "a", "sell", 30, 10); addOrder(state, "b", "buy", 28, 10);
  state = placeHumanOrder(state, { outcome: 0, side: "buy", quantity: 10, limitPrice: 0.3, orderType: "ioc" }).state;
  state = placeHumanOrder(state, { outcome: 0, side: "sell", quantity: 10, limitPrice: 0.28, orderType: "ioc" }).state;
  const view = getMarketView(state);
  assert.equal(view.cash, 999.8); assert.equal(view.realizedPnl, -0.2);
  assert.equal(view.positions[0].costBasis, 0); assert.equal(view.positions[0].quantity, 0);
  assertLedger(state);
});

test("one-, two-, three-, and four-way main-pot settlement is exact and idempotent", () => {
  for (let winners = 1; winners <= 4; winners++) {
    let state = fixture(); addOrder(state, "a", "sell", 20, 1);
    state = placeHumanOrder(state, { outcome: 0, side: "buy", quantity: 1, limitPrice: 0.2, orderType: "ioc" }).state;
    const payouts = [0, 1, 2, 3].map(i => i < winners ? 1 / winners : 0);
    const settled = settleMarket(state, payouts);
    assert.equal(settled.accounts.human.cashUnits, 1000 * U - 0.2 * U + U / winners);
    assert.equal(settled.collateralUnits, 0); assert.equal(settled.orders.length, 0);
    assert.deepEqual(settleMarket(settled, payouts), settled);
    assert.throws(() => placeHumanOrder(settled, { outcome: 0, side: "buy", quantity: 1, limitPrice: 0.1, orderType: "ioc" }), /settled/);
    assertLedger(settled);
  }
  assert.throws(() => settleMarket(fixture(), [0.7, 0.3, 0, 0]), /equally/);
});

test("deterministic JSON replay, private state projection, and real seeded opening orders", () => {
  const first = createMarket([0.55, 0.15, 0.2, 0.1], 784);
  assert.deepEqual(createMarket([0.55, 0.15, 0.2, 0.1], 784), first);
  assert.notDeepEqual(createMarket([0.55, 0.15, 0.2, 0.1], 785).orders, first.orders);
  assert.deepEqual(advanceMarket(JSON.parse(JSON.stringify(first)), undefined, 20), advanceMarket(first, undefined, 20));
  assert.ok(first.orders.length > 10);
  const view = getMarketView(first);
  for (const privateKey of ["rngState", "values", "accounts", "traders", "bias", "beliefs"]) assert.ok(!JSON.stringify(view).includes(`"${privateKey}"`));
  assert.deepEqual(getMarketView(first), view, "reads never advance simulation");
  assertLedger(first);
});

test("finite agents preserve every credit and share across events, human trades, and settlement", () => {
  for (let seed = 1; seed <= 8; seed++) {
    let state = createMarket([0.35, 0.3, 0.2, 0.15], seed);
    for (let t = 0; t < 100; t++) {
      state = advanceMarket(state, t === 25 ? [0.05, 0.65, 0.2, 0.1] : t === 60 ? [0, 0.7, 0.2, 0.1] : undefined, 1);
      if (t % 9 === 0) {
        const outcome = t % 4, view = getMarketView(state), ask = view.books[outcome].bestAsk;
        if (state.values[outcome] > 0 && ask !== null && view.availableCash >= ask * 3) state = placeHumanOrder(state, { outcome, side: "buy", quantity: 3, limitPrice: ask, orderType: "ioc" }).state;
      }
      assertLedger(state);
    }
    assert.ok(state.volumes.reduce((a, b) => a + b, 0) > 0);
    const sets = state.completeSetsIssued;
    assert.equal(sets, 4760, "liquidity was not replenished with free money or shares");
    state = settleMarket(state, [0, 1, 0, 0]); assertLedger(state);
  }
});

test("event repricing keeps human inventory and does not reset outstanding funded orders", () => {
  let state = fixture(); addOrder(state, "a", "sell", 30, 10);
  state = placeHumanOrder(state, { outcome: 0, side: "buy", quantity: 10, limitPrice: 0.3, orderType: "ioc" }).state;
  const placed = placeHumanOrder(state, { outcome: 1, side: "buy", quantity: 4, limitPrice: 0.2, orderType: "limit" });
  state = advanceMarket(placed.state, [0.1, 0.6, 0.2, 0.1], 0);
  assert.equal(state.accounts.human.shares[0], 10);
  assert.equal(state.orders.find(o => o.id === placed.result.orderId)?.remaining, 4);
  assertLedger(state);
});

test("trader positions expose actual inventory and named executed fills, not quote changes", () => {
  let state = createMarket([0.4, 0.3, 0.2, 0.1], 42);
  state.orders = [];
  const before = getMarketView(state);
  assert.equal(before.traderPositions.length, 16);
  for (const trader of before.traderPositions) {
    assert.deepEqual(trader.holdings, state.accounts[trader.id].shares);
    assert.deepEqual(trader.netFilledShares, trader.holdings.map(quantity => quantity - trader.initialSharesPerOutcome));
  }
  state = placeHumanOrder(state, { outcome: 0, side: "buy", quantity: 10, limitPrice: 0.01, orderType: "limit" }).state;
  assert.equal(getMarketView(state).books[0].bestBid, 0.01, "a real new quote changes the book");
  assert.deepEqual(getMarketView(state).traderPositions, before.traderPositions, "quoting does not change holdings or fill flow");
  addOrder(state, "trader-0", "sell", 30, 7);
  const order = placeHumanOrder(state, { outcome: 0, side: "buy", quantity: 5, limitPrice: 0.3, orderType: "ioc" });
  const after = getMarketView(order.state);
  assert.equal(after.traderPositions[0].holdings[0], before.traderPositions[0].holdings[0] - 5);
  assert.equal(after.traderPositions[0].netFilledShares![0], before.traderPositions[0].netFilledShares![0] - 5);
  assert.equal(after.traderPositions[0].openOrders, 1, "the two unfilled shares remain an order, not a new position");
  assert.equal(after.positions[0].quantity, 5);
  assert.deepEqual(after.recentTrades[0].buyer, { id: "human", name: "You" });
  assert.deepEqual(after.recentTrades[0].seller, { id: "trader-0", name: "Maker 1" });
  assert.equal(after.recentTrades[0].quantity, 5);
  assert.equal(after.recentTrades[0].price, 0.3);
  assert.deepEqual(after.fills[0], order.result.fills[0], "existing public fill contracts remain compatible");
  assert.equal(after.fills[0].buyer, "you");
  assert.equal(after.fills[0].seller, "market");
  assertLedger(order.state);
});

test("net trader flow reconciles all actual fills even after the recent tape is truncated", () => {
  let state = createMarket([0.4, 0.3, 0.2, 0.1], 123);
  const net = Object.fromEntries(state.traders.map(trader => [trader.id, [0, 0, 0, 0]]));
  const seen = new Set<string>();
  for (let tick = 0; tick < 250; tick++) {
    if (tick) state = advanceMarket(state, tick === 100 ? [0.1, 0.6, 0.2, 0.1] : undefined);
    for (const fill of state.fills) {
      if (seen.has(fill.id)) continue;
      seen.add(fill.id);
      net[fill.buyer][fill.outcome] += fill.quantity;
      net[fill.seller][fill.outcome] -= fill.quantity;
    }
  }
  assert.ok(seen.size > 250, "the test exceeds the retained tape");
  const view = getMarketView(state);
  for (const trader of view.traderPositions) assert.deepEqual(trader.netFilledShares, net[trader.id]);
  assert.ok(view.traderPositions.some(trader => trader.netFilledShares!.some(quantity => quantity !== 0)), "synthetic traders have taken positions against each other");
  assert.equal(view.recentTrades.length, 20);
  assertLedger(state);
});

test("settled trader holdings are redeemed without misreporting redemption as filled sales", () => {
  const state = advanceMarket(createMarket([0.4, 0.3, 0.2, 0.1], 9), undefined, 20);
  const before = getMarketView(state);
  const settled = settleMarket(state, [0, 1, 0, 0]);
  const after = getMarketView(settled);
  assert.deepEqual(after.traderPositions.map(trader => trader.netFilledShares), before.traderPositions.map(trader => trader.netFilledShares));
  assert.ok(after.traderPositions.every(trader => trader.holdings.every(quantity => quantity === 0) && trader.openOrders === 0));
  assert.deepEqual(after.recentTrades, before.recentTrades);
  const legacy = structuredClone(settled);
  for (const account of Object.values(legacy.accounts)) delete account.settlementHoldings;
  assert.ok(getMarketView(legacy).traderPositions.every(trader => trader.netFilledShares === null), "old settled sessions cannot invent unavailable net trades");
  assertLedger(settled);
});

test("trader visibility is a detached public projection with no private trading inputs", () => {
  const state = createMarket([0.4, 0.3, 0.2, 0.1], 19);
  const original = JSON.stringify(state);
  const view = getMarketView(state);
  const serialized = JSON.stringify(view);
  for (const key of ["rngState", "values", "accounts", "traders", "bias", "beliefs", "reaction", "nextWake", "cashUnits", "settlementHoldings"]) assert.ok(!serialized.includes(`"${key}"`), `${key} stays private`);
  assert.deepEqual(Object.keys(view.traderPositions[0]).sort(), ["holdings", "id", "initialSharesPerOutcome", "kind", "name", "netFilledShares", "openOrders"].sort());
  view.traderPositions[0].holdings[0] = -1;
  view.traderPositions[0].netFilledShares![0] = -1;
  if (view.recentTrades[0]) view.recentTrades[0].buyer.name = "Changed";
  assert.equal(JSON.stringify(state), original);
});


test("a public fold records zero chart value immediately while preserving its last execution price",()=>{
  let state=createMarket([1,1,1,1],19,1000,'jev');
  state.lastPriceTicks[3]=28;
  state=advanceMarket(state,[1,1,1,0],0);
  assert.equal(state.tick,0);
  assert.equal(state.history.at(-1)!.prices[3],0);
  assert.equal(getMarketView(state).books[3].lastPrice,.28,'the actual last fill is not rewritten as a zero-price trade');
  assert.equal(state.fills.length,0);
});
