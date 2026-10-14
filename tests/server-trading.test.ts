import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { GameError } from "../lib/game.ts";
import type { Observation, Action } from "../lib/poker.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const storage = new DatabaseSync(":memory:");
storage.exec(readFileSync(`${root}/drizzle/0000_tired_dexter_bennett.sql`, "utf8"));
storage.exec(readFileSync(`${root}/drizzle/0001_colorful_wolf_cub.sql`, "utf8"));
class Query {
  readonly sql: string;
  readonly values: SQLInputValue[];
  constructor(sql: string, values: SQLInputValue[] = []) { this.sql = sql; this.values = values; }
  bind(...values: SQLInputValue[]) { return new Query(this.sql, values); }
  first() { return storage.prepare(this.sql).get(...this.values) ?? null; }
  all() { return { results: storage.prepare(this.sql).all(...this.values) }; }
  run() { return { meta: { changes: Number(storage.prepare(this.sql).run(...this.values).changes) } }; }
}
const database = {
  prepare(sql: string) { return new Query(sql); },
  batch(queries: Query[]) {
    storage.exec("BEGIN");
    try { const result = queries.map(query => query.run()); storage.exec("COMMIT"); return result; }
    catch (error) { storage.exec("ROLLBACK"); throw error; }
  },
};
Object.assign(globalThis, { __tradingTestEnv: { DB: database, AI_GATEWAY_API_KEY: "local-test-only", LIVE_MODELS_READY: "true" } });
registerHooks({ resolve(specifier, context, next) {
  const modules: Record<string, string> = {
    "cloudflare:workers": "export const env=globalThis.__tradingTestEnv;",
    "next/headers": "export const cookies=async()=>({get:()=>undefined,set:()=>{}}); export const headers=async()=>new Headers();",
    "next/navigation": "export function redirect(){throw new Error('Unexpected redirect');}",
  };
  if (specifier === "./providers" && context.parentURL?.endsWith("/lib/server.ts")) {
    return { url: "data:text/javascript," + encodeURIComponent("export const DEFAULT_MODELS=['a','b','c','d']; export class ProviderError extends Error{}; export const requestDecision=(...args)=>globalThis.__tradingTestDecision(...args);"), shortCircuit: true };
  }
  if (specifier in modules) return { url: "data:text/javascript," + encodeURIComponent(modules[specifier]), shortCircuit: true };
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:") && !/\.[a-z]+$/.test(specifier)) {
    const candidate = new URL(`${specifier}.ts`, context.parentURL);
    if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
  }
  return next(specifier, context);
} });
const server = await import("../lib/server.ts");
function heldDecision(action?: Action) {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  let calls = 0;
  Object.assign(globalThis, { __tradingTestDecision: async (observation: Observation) => {
    calls++; started(); await gate;
    return action ?? (observation.legal.canCall ? { type: "call" } : { type: "check" });
  } });
  return { entered, release, calls: () => calls };
}
async function start() {
  const owner = { id: crypto.randomUUID(), authenticated: true };
  const game = await server.startSession(owner, { requestId: crypto.randomUUID(), mode: "live", ranked: false });
  return { owner, game };
}

test("a trade completes while a model thinks and survives the later poker commit", async () => {
  const { owner, game } = await start();
  const held = heldDecision();
  const advancing = server.executeCommand(owner, game.id, { type: "advance", pokerRevision: game.pokerRevision, requestId: crypto.randomUUID() });
  await held.entered;
  try {
    const book = game.market.books.find(b => b.bestAsk != null)!;
    const order = { type: "order", hand: game.hand, pokerRevision: game.pokerRevision, requestId: crypto.randomUUID(),
      outcome: book.outcome, side: "buy", quantity: 1, limitPrice: .99, orderType: "ioc" };
    const traded = await server.executeCommand(owner, game.id, order);
    assert.equal(traded.busy, true, "model lease remains held after market save");
    assert.equal(traded.tradingOpen, true);
    assert.equal(traded.market.positions[book.outcome].quantity, 1);
    const repeated = await server.executeCommand(owner, game.id, order);
    assert.equal(repeated.version, traded.version);
    held.release();
    const advanced = await advancing;
    assert.equal(advanced.pokerRevision, game.pokerRevision + 1);
    assert.equal(advanced.market.positions[book.outcome].quantity, 1, "the poker result cannot overwrite the fill");
    assert.equal(held.calls(), 1);
    const frames = storage.prepare("SELECT frame FROM replay_frames WHERE session_id=? ORDER BY version").all(game.id);
    assert.ok(frames.some(row => JSON.parse(String(row.frame)).session.activity.at(-1)?.kind === "trade"));
    assert.equal(JSON.parse(String(frames.at(-1)!.frame)).session.market.positions[book.outcome].quantity, 1);
  } finally { held.release(); await advancing.catch(() => {}); }
});

test("concurrent orders, cancellation, and ticks preserve funds and the pending model lease", async () => {
  const { owner, game } = await start(); const held = heldDecision();
  const advancing = server.executeCommand(owner, game.id, { type: "advance", pokerRevision: game.pokerRevision, requestId: crypto.randomUUID() });
  await held.entered;
  try {
    const restingOutcome = game.market.books.find(b => b.bestAsk != null && b.bestAsk > .01)!.outcome;
    const base = { type: "order", hand: 1, pokerRevision: game.pokerRevision, outcome: restingOutcome, side: "buy", quantity: 2, limitPrice: .01, orderType: "limit" };
    await Promise.all([1,2].map(() => server.executeCommand(owner, game.id, { ...base, requestId: crypto.randomUUID() })));
    let saved = (await server.getSession(owner, game.id))!;
    assert.equal(saved.market.openOrders.length, 2);
    assert.equal(saved.busy, true);
    await server.executeCommand(owner, game.id, { type: "cancel", hand: 1, pokerRevision: game.pokerRevision + 1,
      orderId: saved.market.openOrders[0].id, requestId: crypto.randomUUID() });
    await server.executeCommand(owner, game.id, { type: "tick", requestId: crypto.randomUUID() });
    saved = (await server.getSession(owner, game.id))!;
    assert.equal(saved.market.openOrders.length, 1);
    await assert.rejects(server.executeCommand(owner, game.id, { type: "advance", pokerRevision: game.pokerRevision, requestId: crypto.randomUUID() }), error => error instanceof GameError && error.code === "busy");
    held.release(); await advancing;
    saved = (await server.getSession(owner, game.id))!;
    assert.equal(saved.market.openOrders.length, 1);
    assert.equal(saved.market.cash, 1000);
    assert.equal(held.calls(), 1);
  } finally { held.release(); await advancing.catch(() => {}); }
});

test("pause during a model response disables trades and is retained when the response finishes", async () => {
  const { owner, game } = await start(); const held = heldDecision();
  const advancing = server.executeCommand(owner, game.id, { type: "advance", pokerRevision: game.pokerRevision, requestId: crypto.randomUUID() });
  await held.entered;
  try {
    const paused = await server.executeCommand(owner, game.id, { type: "playback", paused: true, requestId: crypto.randomUUID() });
    assert.equal(paused.paused, true); assert.equal(paused.tradingOpen, false);
    await assert.rejects(server.executeCommand(owner, game.id, { type: "order", hand: 1, pokerRevision: game.pokerRevision,
      outcome: 0, side: "buy", quantity: 1, limitPrice: .99, orderType: "ioc", requestId: crypto.randomUUID() }), error => error instanceof GameError && error.code === "GAME_PAUSED");
    held.release(); const advanced = await advancing;
    assert.equal(advanced.paused, true);
    assert.equal(advanced.pokerRevision, game.pokerRevision + 1, "the already-requested action completes once");
    assert.equal(advanced.tradingOpen, false);
  } finally { held.release(); await advancing.catch(() => {}); }
});

test("racing retries of the same order create one fill and one replay frame", async () => {
  const { owner, game } = await start();
  const book = game.market.books.find(b => b.bestAsk != null)!;
  const order = { type: "order", hand: 1, pokerRevision: game.pokerRevision, outcome: book.outcome,
    side: "buy", quantity: 1, limitPrice: .99, orderType: "ioc", requestId: crypto.randomUUID() };
  const views = await Promise.all([server.executeCommand(owner,game.id,order),server.executeCommand(owner,game.id,order)]);
  assert.equal(views[0].version,views[1].version);
  assert.equal(views[0].market.positions[book.outcome].quantity,1);
  assert.equal(storage.prepare("SELECT COUNT(*) n FROM replay_frames WHERE session_id=?").get(game.id)!.n,2);
});

test("settlement pays a trade made during the final decision and rejects further orders", async () => {
  const { owner, game } = await start();
  const row = storage.prepare("SELECT state FROM sessions WHERE id=?").get(game.id)!;
  const state = JSON.parse(String(row.state));
  const actor = state.poker.actor;
  const winner = (actor + 1) % 4;
  for (const player of state.poker.players) {
    player.folded = player.seat !== actor && player.seat !== winner;
    player.contributed = 10; player.bet = 10; player.stack = 990;
  }
  state.poker.pot = 40; state.poker.currentBet = 10;
  state.poker.players[actor].bet = 0;
  state.poker.pending = [actor];
  storage.prepare("UPDATE sessions SET state=? WHERE id=?").run(JSON.stringify(state),game.id);
  const held = heldDecision({type:"fold"});
  const advancing = server.executeCommand(owner,game.id,{type:"advance",pokerRevision:game.pokerRevision,requestId:crypto.randomUUID()});
  await held.entered;
  try {
    const traded = await server.executeCommand(owner,game.id,{type:"order",hand:1,pokerRevision:game.pokerRevision,
      outcome:winner,side:"buy",quantity:1,limitPrice:.99,orderType:"ioc",requestId:crypto.randomUUID()});
    assert.equal(traded.market.positions[winner].quantity,1);
    held.release(); const settled = await advancing;
    assert.equal(settled.status,"hand_complete");
    assert.ok(Math.abs(settled.market.cash-traded.market.cash-1)<1e-9);
    assert.equal(settled.results[0].cashAfter,settled.market.cash);
    const late = {type:"order",hand:1,pokerRevision:game.pokerRevision,outcome:winner,side:"buy",quantity:1,limitPrice:.99,orderType:"ioc",requestId:crypto.randomUUID()};
    await assert.rejects(server.executeCommand(owner,game.id,late),error=>error instanceof GameError && error.code==="hand_settled");
    await server.executeCommand(owner,game.id,{type:"next_hand",pokerRevision:settled.pokerRevision,requestId:crypto.randomUUID()});
    await assert.rejects(server.executeCommand(owner,game.id,late),error=>error instanceof GameError && error.code==="stale_hand");
  } finally { held.release(); await advancing.catch(()=>{}); }
});

test("a failed model response retains concurrent fills and releases the poker lease", async () => {
  const { owner, game } = await start(); const held = heldDecision({type:"raise",amount:1000000});
  const advancing = server.executeCommand(owner,game.id,{type:"advance",pokerRevision:game.pokerRevision,requestId:crypto.randomUUID()});
  await held.entered;
  try {
    const book = game.market.books.find(b=>b.bestAsk!=null)!;
    const traded = await server.executeCommand(owner,game.id,{type:"order",hand:1,pokerRevision:game.pokerRevision,
      outcome:book.outcome,side:"buy",quantity:1,limitPrice:.99,orderType:"ioc",requestId:crypto.randomUUID()});
    held.release(); await assert.rejects(advancing,/Illegal raise/);
    const saved = (await server.getSession(owner,game.id))!;
    assert.equal(saved.busy,false); assert.equal(saved.pokerRevision,game.pokerRevision);
    assert.equal(saved.market.positions[book.outcome].quantity,1);
    assert.equal(saved.market.cash,traded.market.cash);
    assert.equal(held.calls(),2);
    assert.equal(storage.prepare("SELECT provider_calls FROM sessions WHERE id=?").get(game.id)!.provider_calls,2);
  } finally { held.release(); await advancing.catch(()=>{}); }
});
