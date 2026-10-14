import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { createMarket } from "../lib/market.ts";
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
  // These pre-existing tests isolate poker concurrency with the local market engine.
  const row=storage.prepare("SELECT state FROM sessions WHERE id=?").get(game.id)!;
  const state=JSON.parse(String(row.state));
  state.market=createMarket(state.values,1);
  storage.prepare("UPDATE sessions SET state=? WHERE id=?").run(JSON.stringify(state),game.id);
  return { owner, game: (await server.getSession(owner,game.id))! };
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

async function startJev() {
  const owner={id:crypto.randomUUID(),authenticated:true};
  const game=await server.startSession(owner,{requestId:crypto.randomUUID(),mode:'live',ranked:false});
  assert.equal(game.market.driver,'jev');assert.ok(game.market.books.every(b=>b.bestAsk==null));
  return {owner,game};
}
function heldMarket(fail=false) {
  let release!:()=>void,started!:()=>void,calls=0;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{
    assert.equal(url,'https://ai-gateway.vercel.sh/v1/evaluate');
    calls++;const body=JSON.parse(String(init?.body));started();await gate;
    if(fail)return new Response('private gateway details',{status:503});
    return Response.json({answers:Object.fromEntries(Object.keys(body.questions).map(id=>[id,{type:'choice',choice:id==='trader-0'?'tight_quotes':'hold'}]))});
  };
  return {entered,release,calls:()=>calls,restore:()=>{globalThis.fetch=oldFetch;}};
}

test('Jev polling batches once, preserves a concurrent human order, and records its fill', async()=>{
  const {owner,game}=await startJev(),held=heldMarket();
  const ticking=server.executeCommand(owner,game.id,{type:'tick',requestId:crypto.randomUUID()});
  await held.entered;
  try {
    const traded=await server.executeCommand(owner,game.id,{type:'order',hand:1,pokerRevision:game.pokerRevision,
      outcome:0,side:'buy',quantity:1,limitPrice:.99,orderType:'limit',requestId:crypto.randomUUID()});
    assert.equal(traded.market.openOrders.length,1);
    await server.executeCommand(owner,game.id,{type:'tick',requestId:crypto.randomUUID()});
    assert.equal(held.calls(),1);
    held.release();const result=await ticking;
    assert.equal(result.market.positions[0].quantity,1);assert.equal(result.market.openOrders.length,0);
    assert.ok(Math.abs(result.market.cash-999.01)<1e-9);
    const frames=storage.prepare('SELECT frame FROM replay_frames WHERE session_id=? ORDER BY version').all(game.id);
    assert.equal(JSON.parse(String(frames.at(-1)!.frame)).session.market.positions[0].quantity,1);
    const saved=JSON.parse(String(storage.prepare('SELECT state FROM sessions WHERE id=?').get(game.id)!.state));
    assert.equal(saved.marketAgents.calls,1);assert.equal(saved.marketAgents.pending,undefined);
  } finally {held.release();await ticking.catch(()=>{});held.restore();}
});

test('poker may advance while unexpired Jev choices still reach the same-hand market',async()=>{
  const {owner,game}=await startJev(),market=heldMarket(),poker=heldDecision();
  const ticking=server.executeCommand(owner,game.id,{type:'tick',requestId:crypto.randomUUID()});
  await market.entered;
  try {
    const advancing=server.executeCommand(owner,game.id,{type:'advance',pokerRevision:game.pokerRevision,requestId:crypto.randomUUID()});
    await poker.entered;poker.release();const advanced=await advancing;
    assert.equal(advanced.pokerRevision,game.pokerRevision+1);
    market.release();const result=await ticking;
    assert.equal(result.pokerRevision,advanced.pokerRevision);
    assert.ok(result.market.books.some(b=>b.bestAsk!==null||b.bestBid!==null));
    for(const player of result.players) if(player.folded) {
      assert.equal(result.market.books[player.seat].bestAsk,null);
      assert.equal(result.market.books[player.seat].bestBid,null);
    }
    assert.equal(result.market.driver,'jev');
  } finally {poker.release();market.release();await ticking.catch(()=>{});market.restore();}
});

test('pause and resume invalidate an in-flight Jev round without disabling later orders',async()=>{
  const {owner,game}=await startJev(),held=heldMarket();
  const ticking=server.executeCommand(owner,game.id,{type:'tick',requestId:crypto.randomUUID()});
  await held.entered;
  try {
    await server.executeCommand(owner,game.id,{type:'playback',paused:true,requestId:crypto.randomUUID()});
    await server.executeCommand(owner,game.id,{type:'playback',paused:false,requestId:crypto.randomUUID()});
    held.release();const result=await ticking;
    assert.equal(result.paused,false);assert.ok(result.market.books.every(b=>b.bestAsk==null));
    const ordered=await server.executeCommand(owner,game.id,{type:'order',hand:1,pokerRevision:result.pokerRevision,
      outcome:0,side:'buy',quantity:1,limitPrice:.01,orderType:'limit',requestId:crypto.randomUUID()});
    assert.equal(ordered.market.openOrders.length,1);
  } finally {held.release();await ticking.catch(()=>{});held.restore();}
});

test('a failed Jev call counts against the durable allowance and never falls back to local bots',async()=>{
  const {owner,game}=await startJev(),held=heldMarket(true);
  const ticking=server.executeCommand(owner,game.id,{type:'tick',requestId:crypto.randomUUID()});
  await held.entered;
  try {
    held.release();const result=await ticking;
    assert.match(result.market.agentNotice!,/unavailable/);
    assert.ok(!result.market.agentNotice!.includes('private'));
    assert.ok(result.market.books.every(b=>b.bestAsk==null));
    const state=JSON.parse(String(storage.prepare('SELECT state FROM sessions WHERE id=?').get(game.id)!.state));
    assert.equal(state.marketAgents.calls,1);assert.equal(state.marketAgents.pending,undefined);
    await server.executeCommand(owner,game.id,{type:'tick',requestId:crypto.randomUUID()});
    assert.equal(held.calls(),1,'failure still observes cooldown');
  } finally {held.release();await ticking.catch(()=>{});held.restore();}
});

test('Jev-only quote changes are saved as historical book frames without a human trade',async()=>{
  const {owner,game}=await startJev(),held=heldMarket();
  const ticking=server.executeCommand(owner,game.id,{type:'tick',requestId:crypto.randomUUID()});
  await held.entered;
  try {
    held.release();const result=await ticking;
    assert.equal(result.market.cash,1000);assert.ok(result.market.books.some(book=>book.bestAsk!=null));
    const frames=storage.prepare('SELECT frame FROM replay_frames WHERE session_id=? ORDER BY version').all(game.id).map(row=>JSON.parse(String(row.frame)));
    assert.equal(frames.length,2);assert.match(frames[1].label,/Market snapshot/);
    assert.deepEqual(frames[1].session.market.books,result.market.books);
    assert.ok(frames[0].session.market.books.every((book:{bestAsk:number|null})=>book.bestAsk==null));
    assert.equal(frames[1].session.tradingOpen,false);
  } finally {held.release();await ticking.catch(()=>{});held.restore();}
});
