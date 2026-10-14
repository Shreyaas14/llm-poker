import test from "node:test";
import assert from "node:assert/strict";
import { createGame, commandGame, viewGame } from "../lib/game.ts";
import { createMarket, advanceMarket, replaceTraderOrders, placeHumanOrder, settleMarket, UNITS_PER_CREDIT } from "../lib/market.ts";
import { prepareMarketRound, reserveMarketRound, finishMarketRound, requestMarketDecisions, MARKET_CALL_LIMIT, JEV_MODEL } from "../lib/market-agents.ts";
const NOW = 1750000000000;
function fixture() { return createGame("jev-test", "live", false, NOW, undefined, false, "jev"); }
function assertFunded(m: ReturnType<typeof createMarket>) {
  for (const a of Object.values(m.accounts)) {
    const reserved = m.orders.filter(o => o.owner === a.id && o.side === "buy").reduce((n,o) => n+o.remaining*o.priceTicks*UNITS_PER_CREDIT/100,0);
    assert.ok(a.cashUnits >= reserved);
    for (let i=0;i<4;i++) assert.ok(a.shares[i] >= m.orders.filter(o => o.owner===a.id&&o.side==="sell"&&o.outcome===i).reduce((n,o)=>n+o.remaining,0));
  }
  assert.equal(Object.values(m.accounts).reduce((n,a)=>n+a.cashUnits,0)+m.collateralUnits,m.initialTotalCashUnits);
}

test("Jev markets wait for model decisions; local practice markets still quote and trade", () => {
  const market=createMarket([.25,.25,.25,.25],1,1000,"jev");
  assert.equal(market.orders.length,0);assert.equal(market.fills.length,0);
  assert.equal(advanceMarket(market,undefined,30).orders.length,0);
  assert.ok(createMarket([.25,.25,.25,.25],1).orders.length>0);
});

test("bounded trader choices execute funded matches and cannot submit human or invalid orders", () => {
  let m=createMarket([.25,.25,.25,.25],1,1000,"jev");
  m=replaceTraderOrders(m,"trader-0",[{outcome:0,side:"sell",quantity:25,priceTicks:25}]);
  m=replaceTraderOrders(m,"trader-1",[{outcome:0,side:"buy",quantity:25,priceTicks:25}]);
  assert.equal(m.fills.length,1);assert.equal(m.fills[0].quantity,25);assertFunded(m);
  assert.throws(()=>replaceTraderOrders(m,"human",[]),/Unknown trader/);
  assert.throws(()=>replaceTraderOrders(m,"trader-0",[{outcome:0,side:"buy",quantity:26,priceTicks:25}]),/Invalid/);
  m.accounts['trader-0'].cashUnits=0;
  const exhausted=replaceTraderOrders(m,"trader-0",[{outcome:0,side:"buy",quantity:25,priceTicks:99}]);
  assert.equal(exhausted.orders.filter(o=>o.owner==='trader-0').length,0);
});

test("round context includes dealt cards and prices but never the deck, future board, or RNG", () => {
  const game=fixture(),round=prepareMarketRound(game),state=JSON.parse(round.state);
  assert.equal(round.traders.length,16);assert.deepEqual(state.board,game.poker.board);
  assert.deepEqual(state.players[0].cards,game.poker.players[0].hole);
  assert.equal(state.deck,undefined);assert.equal(state.rngState,undefined);
  assert.ok(!round.state.includes('rngState'));assert.ok(!round.state.includes('seed'));
  assert.equal(Object.keys(round.traders[0].choices).length,3);
});

test("reservations throttle duplicate calls, survive retries, and enforce the game budget", () => {
  const game=reserveMarketRound(fixture(),'token',NOW)!;
  assert.equal(game.marketAgents?.calls,1);
  assert.equal(reserveMarketRound(game,'duplicate',NOW+4000),null);
  game.marketAgents!.calls=MARKET_CALL_LIMIT;
  assert.equal(reserveMarketRound(game,'over-budget',NOW+20000),null);
  assert.equal(reserveMarketRound({...fixture(),pausedAt:NOW},'paused',NOW),null);
  const local=createGame('local','practice',false,NOW);
  assert.equal(reserveMarketRound(local,'practice',NOW),null);
});

test("late Jev decisions preserve concurrent human orders and recheck latest available balances", () => {
  let game=reserveMarketRound(fixture(),'token',NOW)!;const round=prepareMarketRound(game);
  game.market=placeHumanOrder(game.market,{outcome:0,side:'buy',quantity:1,limitPrice:.01,orderType:'limit'}).state;
  const humanId=game.market.orders[0].id;
  const answers=Object.fromEntries(round.traders.map(t=>[t.id,t.id==='trader-0'?'tight_quotes':'hold']));
  const result=finishMarketRound(game,'token',round,answers,NOW+1000)!;
  assert.ok(result.market.orders.some(o=>o.id===humanId));assert.ok(result.market.orders.some(o=>o.owner==='trader-0'));
  assert.equal(result.marketAgents?.pending,undefined);assertFunded(result.market);
  assert.equal(finishMarketRound(result,'token',round,answers,NOW+2000),null);
});

test("stale, paused, expired, and settled results never place orders; failures never fall back", async () => {
  const game=reserveMarketRound(fixture(),'token',NOW)!;const round=prepareMarketRound(game);
  const answers=Object.fromEntries(round.traders.map(t=>[t.id,t.id==='trader-0'?'tight_quotes':'hold']));
  for(const changed of [(()=>{const c=structuredClone(game);c.poker.revision++;return c;})(),{...game,hand:2},{...game,pausedAt:NOW}]) {
    assert.equal(finishMarketRound(changed,'token',round,answers,NOW+1000)!.market.orders.length,0);
  }
  assert.equal(finishMarketRound(game,'token',round,answers,NOW+11000)!.market.orders.length,0);
  const failed=finishMarketRound(game,'token',round,null,NOW+1000)!;
  assert.match(failed.market.agentNotice!,/unavailable/);assert.equal(failed.market.orders.length,0);
  const paused=await commandGame(game,{type:'playback',paused:true},NOW+500);
  const resumed=await commandGame(paused,{type:'playback',paused:false},NOW+600);
  assert.equal(finishMarketRound(resumed,'token',round,answers,NOW+1000),null);
});

test("Gateway adapter batches typed choices and rejects malformed, missing, or unknown answers", async () => {
  const round=prepareMarketRound(fixture()),oldFetch=globalThis.fetch;
  let response:unknown={answers:Object.fromEntries(round.traders.map(t=>[t.id,{type:'choice',choice:'hold'}]))};
  globalThis.fetch=async (url,init)=>{
    assert.equal(url,'https://ai-gateway.vercel.sh/v1/evaluate');
    const body=JSON.parse(String(init?.body));assert.equal(body.model,JEV_MODEL);assert.equal(Object.keys(body.questions).length,16);
    assert.equal(body.questions['trader-0'].type,'choice');assert.ok(init?.signal);
    return Response.json(response);
  };
  try {
    assert.equal(Object.keys(await requestMarketDecisions(round,'test-only')).length,16);
    response={answers:{}};await assert.rejects(requestMarketDecisions(round,'test-only'),/invalid/);
    response={answers:Object.fromEntries(round.traders.map(t=>[t.id,{type:'choice',choice:'steal'}]))};
    await assert.rejects(requestMarketDecisions(round,'test-only'),/invalid/);
    globalThis.fetch=async()=>new Response('private provider detail',{status:402});
    await assert.rejects(requestMarketDecisions(round,'test-only'),error=>error instanceof Error&&!error.message.includes('private')&&/unavailable/.test(error.message));
    globalThis.fetch=async()=>{throw new Error('private timeout detail');};
    await assert.rejects(requestMarketDecisions(round,'test-only'),/could not respond/);
  } finally {globalThis.fetch=oldFetch;}
});


test("settlement and a newer reservation reject old model results without changing the ledger", () => {
  const game=reserveMarketRound(fixture(),'old',NOW)!;const round=prepareMarketRound(game);
  const answers=Object.fromEntries(round.traders.map(t=>[t.id,t.id==='trader-0'?'tight_quotes':'hold']));
  const newer=reserveMarketRound(game,'new',NOW+11000)!;
  assert.equal(finishMarketRound(newer,'old',round,answers,NOW+11001),null);
  const settled=structuredClone(game);settled.poker.street='complete';settled.market=settleMarket(settled.market,[1,0,0,0]);
  const after=finishMarketRound(settled,'old',round,answers,NOW+1000)!;
  assert.deepEqual(after.market.accounts,settled.market.accounts);assert.equal(after.market.orders.length,0);
});

test("exhausted Jev budgets remain visible after a new hand and old saved games stay local", async () => {
  const game=fixture();game.marketAgents={calls:MARKET_CALL_LIMIT,nextAt:NOW};
  assert.match(viewGame(game,false,NOW).market.agentNotice!,/call limit/);
  const old=createGame('old-live','live',false,NOW);delete old.market.driver;
  assert.equal(viewGame(old,false,NOW).market.driver,'local');
  old.poker.street='complete';
  const next=await commandGame(old,{type:'next_hand',pokerRevision:old.poker.revision},NOW);
  assert.equal(next.market.driver,'local');
  game.poker.street='complete';
  const newHand=await commandGame(game,{type:'next_hand',pokerRevision:game.poker.revision},NOW);
  assert.equal(newHand.market.driver,'jev');assert.match(viewGame(newHand,false,NOW).market.agentNotice!,/call limit/);
});

test("invalid choices abort the whole batch before any order changes", () => {
  const game=reserveMarketRound(fixture(),'token',NOW)!;const round=prepareMarketRound(game);
  const answers=Object.fromEntries(round.traders.map(t=>[t.id,t.id==='trader-0'?'tight_quotes':'hold']));
  answers['trader-15']='unknown';
  assert.throws(()=>finishMarketRound(game,'token',round,answers,NOW+1000),/Invalid/);
  assert.equal(game.market.orders.length,0);assert.equal(game.marketAgents?.pending?.token,'token');
});
