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
  assert.throws(() => placeHumanOrder(reserved, { outcome: 1, side: "buy", quantity: 1, limitPrice: 0.01, orderType: "limit" }), /credits/);
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
