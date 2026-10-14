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

test("round context matches spectator cards, equity, depth, and trader holdings without private account data", () => {
  const game=fixture(),round=prepareMarketRound(game),state=JSON.parse(round.state);
  assert.equal(round.traders.length,16);assert.deepEqual(state.board,game.poker.board);
  assert.deepEqual(state.players[0].cards,game.poker.players[0].hole);
  const visible=viewGame(game,false,NOW);
  assert.deepEqual(state.showdownEquity,visible.odds);
  assert.deepEqual(state.traders,visible.market.traderPositions);
  assert.deepEqual(state.books[0].bids,visible.market.books[0].bids.slice(0,6));
  assert.equal(state.estimatedPayouts,undefined);
  assert.ok(state.traders.every((t:Record<string,unknown>)=>!("cash" in t)&&!("cashUnits" in t)&&!("bias" in t)&&!("beliefs" in t)));
  assert.equal(state.deck,undefined);assert.equal(state.rngState,undefined);
  assert.ok(!round.state.includes('rngState'));assert.ok(!round.state.includes('seed'));
  assert.equal(Object.keys(round.traders[0].choices).length,12);
  assert.equal(state.players[0].bet,visible.players[0].bet);
  assert.equal(state.players[0].contributed,visible.players[0].contributed);
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
  const game=reserveMarketRound(fixture(),'token',NOW)!;const round=prepareMarketRound(game);
  game.market=placeHumanOrder(game.market,{outcome:0,side:'buy',quantity:1,limitPrice:.01,orderType:'limit'}).state;
  const humanId=game.market.orders[0].id;
  const answers=Object.fromEntries(round.traders.map(t=>[t.id,t.id==='trader-0'?'tight_quotes':'hold']));
  const result=finishMarketRound(game,'token',round,answers,NOW+1000)!;
  assert.ok(result.market.orders.some(o=>o.id===humanId));assert.ok(result.market.orders.some(o=>o.owner==='trader-0'));
  assert.equal(result.marketAgents?.pending,undefined);assertFunded(result.market);
  assert.equal(finishMarketRound(result,'token',round,answers,NOW+2000),null);
});

test("other-hand, paused, expired, and settled results never place orders; failures never fall back", async () => {
  const game=reserveMarketRound(fixture(),'token',NOW)!;const round=prepareMarketRound(game);
  const answers=Object.fromEntries(round.traders.map(t=>[t.id,t.id==='trader-0'?'tight_quotes':'hold']));
  for(const changed of [{...game,hand:2},{...game,pausedAt:NOW}]) {
    assert.equal(finishMarketRound(changed,'token',round,answers,NOW+1000)!.market.orders.length,0);
  }
  assert.equal(finishMarketRound(game,'token',round,answers,NOW+11000)!.market.orders.length,0);
  const failed=finishMarketRound(game,'token',round,null,NOW+1000)!;
  assert.match(failed.market.agentNotice!,/unavailable/);assert.equal(failed.market.orders.length,0);
  const paused=await commandGame(game,{type:'playback',paused:true},NOW+500);
  const resumed=await commandGame(paused,{type:'playback',paused:false},NOW+600);
  assert.equal(finishMarketRound(resumed,'token',round,answers,NOW+1000),null);
});

test("unexpired Jev choices survive same-hand poker actions without changing their limit", async () => {
  let game=fixture();game.market.values=[.1,.7,.1,.1];
  game=reserveMarketRound(game,'during-action',NOW)!;
  const round=prepareMarketRound(game), selected=round.traders.find(t=>t.id==='trader-2')!.choices.buy_1_5[0];
  const answers=Object.fromEntries(round.traders.map(t=>[t.id,t.id==='trader-2'?'buy_1_5':'hold']));
  game=await commandGame(game,{type:'advance',pokerRevision:game.poker.revision},NOW+250,
    async observation=>({type:observation.legal.canCheck?'check':'call'}));
  assert.notEqual(game.poker.revision,game.marketAgents!.pending!.pokerRevision);
  const result=finishMarketRound(game,'during-action',round,answers,NOW+1000)!;
  const quote=result.market.orders.find(o=>o.owner==='trader-2');
  assert.ok(quote,'a new poker revision cannot discard every in-flight batch');
  assert.equal(quote.priceTicks,selected.priceTicks);
  assert.equal(result.market.driver,'jev');assertFunded(result.market);
});

test("same-hand delayed choices skip newly folded outcomes and respect current funding", async () => {
  let game=reserveMarketRound(fixture(),'fold-race',NOW)!;
  const foldingSeat=game.poker.actor!, round=prepareMarketRound(game);
  const answers=Object.fromEntries(round.traders.map(t=>[t.id,t.id==='trader-2'?`buy_${foldingSeat}_5`:'hold']));
  game=await commandGame(game,{type:'advance',pokerRevision:game.poker.revision},NOW+250,async()=>({type:'fold'}));
  const folded=finishMarketRound(game,'fold-race',round,answers,NOW+1000)!;
  assert.equal(folded.market.values[foldingSeat],0);
  assert.equal(folded.market.orders.length,0);assert.equal(folded.market.fills.length,0);
  assertFunded(folded.market);

  let funded=reserveMarketRound(fixture(),'funding-race',NOW)!;
  const fundedRound=prepareMarketRound(funded);
  const fundedAnswers=Object.fromEntries(fundedRound.traders.map(t=>[t.id,t.id==='trader-2'?'buy_1_5':'hold']));
  funded=await commandGame(funded,{type:'advance',pokerRevision:funded.poker.revision},NOW+250,
    async observation=>({type:observation.legal.canCheck?'check':'call'}));
  const buyer=funded.market.accounts['trader-2'];
  funded.market.accounts['trader-3'].cashUnits+=buyer.cashUnits;buyer.cashUnits=0;
  const before=structuredClone(buyer.shares);
  const empty=finishMarketRound(funded,'funding-race',fundedRound,fundedAnswers,NOW+1000)!;
  assert.equal(empty.market.accounts['trader-2'].cashUnits,0);
  assert.deepEqual(empty.market.accounts['trader-2'].shares,before);
  assert.equal(empty.market.orders.length,0);assert.equal(empty.market.fills.length,0);
  assertFunded(empty.market);
});

test("Gateway adapter batches typed choices and rejects malformed, missing, or unknown answers", async () => {
  const round=prepareMarketRound(fixture()),oldFetch=globalThis.fetch;
  let response:unknown={answers:Object.fromEntries(round.traders.map(t=>[t.id,{type:'choice',choice:'hold'}]))};
  globalThis.fetch=async (url,init)=>{
    assert.equal(url,'https://ai-gateway.vercel.sh/v1/evaluate');
    const body=JSON.parse(String(init?.body));assert.equal(body.model,JEV_MODEL);assert.equal(Object.keys(body.questions).length,16);
    assert.equal(body.questions['trader-0'].type,'choice');assert.ok(init?.signal);
    assert.match(body.questions['trader-0'].criteria.hold,/Keep current/);
    assert.match(body.questions['trader-0'].criteria.cancel_quotes,/Cancel all/);
    assert.match(body.questions['trader-0'].criteria.tight_quotes,/limits in cents/);
    assert.match(body.questions['trader-0'].criteria.tight_quotes,/75% current card equity/);
    assert.match(body.questions['trader-0'].criteria.bullish_0,/Increase seat 0.*up to 8 percentage points/);
    assert.match(body.questions['trader-0'].criteria.bearish_0,/Decrease seat 0.*up to 8 percentage points/);
    assert.equal(Object.hasOwn(body.questions['trader-0'].criteria,'market_quotes'),false);
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


test("unseen forecasts, private trader data, deck order, and RNG cannot change Jev context or price candidates", () => {
  const game=fixture();
  const before=prepareMarketRound(game);
  const altered=structuredClone(game);
  altered.values=[.97,.01,.01,.01];altered.market.values=[0,0,0,1];
  altered.poker.deck.reverse();altered.poker.seed='different-secret';altered.market.rngState=99;
  for(const trader of altered.market.traders) {
    trader.bias=[100,-100,100,-100];trader.beliefs=[0,0,0,1];
    altered.market.accounts[trader.id].cashUnits+=12345;
    altered.market.accounts[trader.id].costBasisUnits=[999,999,999,999];
  }
  assert.deepEqual(prepareMarketRound(altered),before);
  const reserved=reserveMarketRound(altered,'public-eligibility',NOW)!;
  assert.deepEqual(reserved.market.values,[.25,.25,.25,.25]);
});

test("book-taking choices retain displayed quotes while makers offer only responsive portfolios", () => {
  const game=fixture(),opening=prepareMarketRound(game);
  assert.deepEqual(opening.traders[2].choices.buy_0_5,[{outcome:0,side:'buy',quantity:5,priceTicks:25}]);
  game.market=replaceTraderOrders(game.market,'trader-0',[{outcome:0,side:'buy',quantity:5,priceTicks:41},{outcome:0,side:'sell',quantity:5,priceTicks:47}]);
  const quoted=prepareMarketRound(game);
  assert.equal(quoted.traders[2].choices.buy_0_5[0].priceTicks,47);
  assert.equal(quoted.traders[2].choices.sell_0_5[0].priceTicks,41);
  const maker=quoted.traders[0].choices.tight_quotes.filter(o=>o.outcome===0);
  const reference=.75*viewGame(game,false,NOW).odds.equities[0]+.25*(.44/(.44+.25*3));
  assert.equal(maker[0].priceTicks,Math.max(1,Math.floor(reference*100+1e-8)-2));
  assert.equal(maker[1].priceTicks,Math.min(99,Math.ceil(reference*100-1e-8)+2));
  assert.ok(quoted.traders.filter(t=>t.id==='trader-0'||t.id==='trader-1').every(t=>!Object.hasOwn(t.choices,'market_quotes')));
  game.poker.players[0].folded=true;
  const folded=prepareMarketRound(game);
  assert.ok(folded.traders.every(t=>Object.values(t.choices).flat().every(o=>o.outcome!==0)));
});

test("the actual Gateway payload contains spectator information and no internal forecast or trader bias", async () => {
  const game=fixture(),round=prepareMarketRound(game),oldFetch=globalThis.fetch;
  let payload:Record<string,unknown>|undefined;
  globalThis.fetch=async(_url,init)=>{
    payload=JSON.parse(String(init?.body));
    return Response.json({answers:Object.fromEntries(round.traders.map(t=>[t.id,{type:'choice',choice:'hold'}]))});
  };
  try {
    await requestMarketDecisions(round,'test-only');
    const state=JSON.parse(String(payload!.state));
    assert.deepEqual(state.players[0].cards,viewGame(game,false,NOW).players[0].cards);
    assert.deepEqual(state.showdownEquity,viewGame(game,false,NOW).odds);
    for(const key of ['estimatedPayouts','rngState','beliefs','cashUnits','costBasisUnits','seed','deck']) assert.ok(!JSON.stringify(payload).includes(`"${key}"`),key);
  } finally {globalThis.fetch=oldFetch;}
});

test("Live maker quotes react to revealed cards rather than recycling neutral book prices", async t => {
  const {createHand}=await import('../lib/poker.ts');
  let game=fixture();game.poker=createHand(42,0,1000);game.market=createMarket([1,1,1,1],44,1000,'jev');
  function quote(source:typeof game,token:string,time:number) {
    const held=reserveMarketRound(source,token,time)!;
    const round=prepareMarketRound(held);
    return finishMarketRound(held,token,round,Object.fromEntries(round.traders.map(t=>[t.id,t.instructions===round.traders[0].instructions?'tight_quotes':'hold'])),time+1)!;
  }
  game=quote(game,'opening',NOW);
  const opening=viewGame(game,false,NOW+1);
  while(game.poker.street==='preflop') game=await commandGame(game,{type:'advance',pokerRevision:game.poker.revision},NOW+100,
    async o=>({type:o.legal.canCheck?'check':'call'}));
  game=quote(game,'flop',NOW+4000);
  const flop=viewGame(game,false,NOW+4001);
  assert.notDeepEqual(flop.odds.equities,opening.odds.equities);
  assert.notDeepEqual(flop.market.books.map(b=>[b.bestBid,b.bestAsk]),opening.market.books.map(b=>[b.bestBid,b.bestAsk]),'successful maker decisions must be able to reprice after new visible cards');
  t.diagnostic(JSON.stringify({openingQuotes:opening.market.books.map(b=>[b.bestBid,b.bestAsk]),flopQuotes:flop.market.books.map(b=>[b.bestBid,b.bestAsk])}));
  assertFunded(game.market);
});

test("a visible raise offers funded maker repricing in either direction without forcing a belief", async () => {
  const {createHand}=await import('../lib/poker.ts');
  let game=fixture();game.poker=createHand(42,0,1000);
  const raisingSeat=game.poker.actor!,before=viewGame(game,false,NOW);
  game=await commandGame(game,{type:'advance',pokerRevision:game.poker.revision},NOW+100,
    async()=>({type:'raise',amount:180}));
  assert.deepEqual(viewGame(game,false,NOW+100).odds,before.odds,'betting does not change the card calculation');
  const held=reserveMarketRound(game,'react-to-raise',NOW+200)!;
  const round=prepareMarketRound(held),context=JSON.parse(round.state);
  assert.equal(context.players[raisingSeat].action,'Raise to 180');
  assert.equal(context.players[raisingSeat].bet,180);
  assert.equal(context.players[raisingSeat].contributed,game.poker.players[raisingSeat].contributed);
  const quote=(choice:string)=>{
    const result=finishMarketRound(held,'react-to-raise',round,
      Object.fromEntries(round.traders.map(t=>[t.id,t.id==='trader-0'?choice:'hold'])),NOW+201)!;
    assertFunded(result.market);
    return viewGame(result,false,NOW+201).market.books;
  };
  const baseline=quote('tight_quotes'),bullish=quote(`bullish_${raisingSeat}`),bearish=quote(`bearish_${raisingSeat}`);
  assert.ok(bullish[raisingSeat].midpoint!>baseline[raisingSeat].midpoint!+.07);
  assert.ok(bearish[raisingSeat].midpoint!<baseline[raisingSeat].midpoint!-.07);
  assert.ok(baseline.some((book,seat)=>seat!==raisingSeat&&bullish[seat].midpoint!<book.midpoint!), 'a bullish tilt redistributes probability from other eligible players');
  assert.deepEqual(held.market.orders,[],'offering choices does not itself place quotes');
});

test("value and conviction limits can cross stale quotes using only displayed card equity", () => {
  const game=fixture();
  game.poker.street='river';game.poker.board=['Qs','Js','Ts','2c','3d'];
  [['As','Ks'],['Qd','Qh'],['Jd','Jh'],['Td','Th']].forEach((hole,seat)=>game.poker.players[seat].hole=hole);
  game.market=replaceTraderOrders(game.market,'trader-0',[0,1,2,3].flatMap(outcome=>[
    {outcome,side:'buy' as const,quantity:25,priceTicks:20},
    {outcome,side:'sell' as const,quantity:25,priceTicks:30},
  ]));
  const round=prepareMarketRound(game),choices=round.traders[2].choices;
  assert.deepEqual(JSON.parse(round.state).showdownEquity.equities,[1,0,0,0]);
  assert.equal(choices.buy_0_15[0].priceTicks,30,'book-taking remains optional');
  assert.equal(choices.buy_0_value[0].priceTicks,98);
  assert.equal(choices.buy_0_conviction[0].priceTicks,99);
  assert.equal(choices.sell_1_value[0].priceTicks,2);
  assert.equal(choices.sell_1_conviction[0].priceTicks,1);
  const executed=replaceTraderOrders(game.market,'trader-2',choices.buy_0_value);
  assert.equal(executed.fills.at(-1)?.priceTicks,30,'the actual resting order sets the execution price');
  assertFunded(executed);
  for(const trader of round.traders) {
    assert.ok(Object.keys(trader.choices).length<=34,'bounded choice count');
    for(const orders of Object.values(trader.choices)) {
      assert.ok(orders.length<=24);
      assert.ok(orders.every(o=>o.quantity>=1&&o.quantity<=25&&o.priceTicks>=1&&o.priceTicks<=99));
    }
  }
  game.poker.players[1].folded=true;
  assert.ok(prepareMarketRound(game).traders.every(t=>Object.values(t.choices).flat().every(o=>o.outcome!==1)));
});

test("cancel_quotes removes only the selected trader's orders while hold preserves them", () => {
  let game=fixture();
  game.market=replaceTraderOrders(game.market,'trader-0',[{outcome:0,side:'sell',quantity:10,priceTicks:50}]);
  game.market=replaceTraderOrders(game.market,'trader-1',[{outcome:1,side:'sell',quantity:10,priceTicks:50}]);
  game.market=placeHumanOrder(game.market,{outcome:0,side:'buy',quantity:3,limitPrice:.01,orderType:'limit'}).state;
  game=reserveMarketRound(game,'cancel-quotes',NOW)!;
  const round=prepareMarketRound(game),hold=Object.fromEntries(round.traders.map(t=>[t.id,'hold']));
  const held=finishMarketRound(game,'cancel-quotes',round,hold,NOW+1)!;
  assert.deepEqual(held.market.orders,game.market.orders);
  const canceled=finishMarketRound(game,'cancel-quotes',round,{...hold,'trader-0':'cancel_quotes'},NOW+1)!;
  assert.deepEqual(canceled.market.orders,game.market.orders.filter(o=>o.owner!=='trader-0'));
  assert.deepEqual(canceled.market.accounts,game.market.accounts);
  assert.deepEqual(canceled.market.fills,game.market.fills);
  assertFunded(canceled.market);
});
