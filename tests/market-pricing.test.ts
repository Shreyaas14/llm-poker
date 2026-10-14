import test from "node:test";
import assert from "node:assert/strict";
import { marketProbabilities, probabilityUnits, coherentMakerOrders } from "../lib/market-pricing.ts";
import { advanceMarket, arbitrateCompleteSets, createMarket, replaceTraderOrders, getMarketView, settleMarket, placeHumanOrder, UNITS_PER_CREDIT as U } from "../lib/market.ts";
import type { MarketState } from "../lib/market.ts";

function ledger(state: MarketState) {
  const accounts = Object.values(state.accounts);
  assert.equal(accounts.reduce((sum,a)=>sum+a.cashUnits,0)+state.collateralUnits,state.initialTotalCashUnits);
  if(state.status === "open") assert.equal(state.collateralUnits,state.completeSetsIssued*U);
  for(let i=0;i<4;i++) assert.equal(accounts.reduce((sum,a)=>sum+a.shares[i],0),state.status === "open"?state.completeSetsIssued:0);
  for(const a of accounts) {
    assert.ok(a.cashUnits>=state.orders.filter(o=>o.owner===a.id&&o.side==='buy').reduce((n,o)=>n+o.remaining*o.priceTicks*U/100,0));
    for(let i=0;i<4;i++) assert.ok(a.shares[i]>=state.orders.filter(o=>o.owner===a.id&&o.side==='sell'&&o.outcome===i).reduce((n,o)=>n+o.remaining,0));
  }
  assert.ok(state.fills.every(f=>f.buyer!==f.seller));
}
function basket(side: 'buy'|'sell', prices: number[], quantity=20) {
  let state=createMarket([.25,.25,.25,.25],92,1000,"jev");
  state=replaceTraderOrders(state,'trader-0',prices.map((priceTicks,outcome)=>({outcome,side,priceTicks,quantity})));
  return state;
}

test("display probabilities normalize marks, distinguish missing quotes, and round to exactly 100%",()=>{
  assert.deepEqual(marketProbabilities([.3,.3,.3,.3]),[.25,.25,.25,.25]);
  assert.deepEqual(marketProbabilities([.8,.2,.9,null],[true,true,false,false]),[.8,.2,0,0]);
  assert.deepEqual(marketProbabilities([null,undefined,NaN,-1]),[.25,.25,.25,.25]);
  assert.deepEqual(marketProbabilities([0,0,0,0],[true,true,false,false]),[.5,.5,0,0]);
  assert.deepEqual(probabilityUnits([1/3,1/3,1/3,0]),[334,333,333,0]);
  assert.deepEqual(probabilityUnits([]),[]);
  for(let i=1;i<100;i++) assert.equal(probabilityUnits([i,100-i,i%7,0]).reduce((a,b)=>a+b,0),1000);
});

test("maker centers form a coherent dollar with six funded-size levels on both sides",()=>{
  for(const weights of [[.25,.25,.25,.25],[.999,.001,0,0],[1/3,1/3,1/3,0],[.1,.2,.3,.4]]) {
    for(const eligible of [[true,true,true,true],[true,true,false,false]]) {
      const orders=coherentMakerOrders(weights,eligible,1);
      assert.equal(orders.length,eligible.filter(Boolean).length*12);
      const bids=weights.map((_,i)=>Math.max(0,...orders.filter(o=>o.outcome===i&&o.side==='buy').map(o=>o.priceTicks)));
      const asks=weights.map((_,i)=>eligible[i]?Math.min(...orders.filter(o=>o.outcome===i&&o.side==='sell').map(o=>o.priceTicks)):0);
      assert.ok(bids.reduce((a,b)=>a+b,0)<=100);
      assert.ok(asks.reduce((a,b)=>a+b,0)>=100);
      assert.ok(orders.every(o=>o.priceTicks>=1&&o.priceTicks<=99));
    }
  }
  assert.deepEqual(coherentMakerOrders([1,0,0,0],[true,false,false,false],1),[]);
});

test("normalizing display leaves actual quotes unchanged and new makers fill a 100-share ticket",()=>{
  let state=createMarket([.25,.25,.25,.25],2,1000,"jev");
  for(const owner of ['trader-0','trader-1']) state=replaceTraderOrders(state,owner,coherentMakerOrders([.25,.25,.25,.25],[true,true,true,true],1));
  const view=getMarketView(state);
  assert.deepEqual(view.probabilities,[.25,.25,.25,.25]);
  assert.equal(view.books[0].bestBid,.24);assert.equal(view.books[0].bestAsk,.26);
  assert.equal(view.books[0].asks.length,6);assert.equal(view.books[0].asks[0].quantity,200);
  assert.equal(view.books[0].asks.reduce((n,l)=>n+l.quantity,0),2800);
  const bought=placeHumanOrder(state,{outcome:0,side:'buy',quantity:100,limitPrice:.26,orderType:'ioc'});
  assert.equal(bought.result.filledQuantity,100);assert.equal(bought.result.averagePrice,.26);ledger(bought.state);
});

test("cheap complete sets buy actual asks and redeem collateral, with no conversion counted as a fill",()=>{
  const before=basket('sell',[20,20,20,20]),source=structuredClone(before),owner='trader-16';
  const state=arbitrateCompleteSets(before);
  assert.deepEqual(before,source);
  assert.equal(state.accounts[owner].cashUnits-before.accounts[owner].cashUnits,4*U);
  assert.equal(state.completeSetsIssued,before.completeSetsIssued-20);
  assert.equal(state.accounts[owner].completeSetDelta,-20);
  assert.equal(state.fills.length,4);assert.ok(state.fills.every(f=>f.quantity===20&&f.priceTicks===20));
  assert.deepEqual(getMarketView(state).traderPositions.at(-1)!.netFilledShares,[20,20,20,20]);
  ledger(state);
  assert.deepEqual(arbitrateCompleteSets(state),state,"no profitable depth remains");
  const settled=settleMarket(state,[.5,.5,0,0]);ledger(settled);
  assert.deepEqual(getMarketView(settled).traderPositions.at(-1)!.netFilledShares,[20,20,20,20]);
});

test("rich complete sets lock collateral and sell at actual bids",()=>{
  const before=basket('buy',[30,30,30,30]),state=arbitrateCompleteSets(before),owner='trader-16';
  assert.equal(state.accounts[owner].cashUnits-before.accounts[owner].cashUnits,4*U);
  assert.equal(state.completeSetsIssued,before.completeSetsIssued+20);
  assert.deepEqual(getMarketView(state).traderPositions.at(-1)!.netFilledShares,[-20,-20,-20,-20]);
  assert.equal(state.fills.length,4);ledger(state);ledger(settleMarket(state,[0,1,0,0]));
});

test("arbitrage recomputes depth and never takes an incomplete or unprofitable basket",()=>{
  let state=basket('sell',[20,20,20,20],7);
  state=replaceTraderOrders(state,'trader-1',[{outcome:0,side:'sell',priceTicks:60,quantity:40}]);
  state=arbitrateCompleteSets(state);
  assert.equal(state.fills.length,4);assert.ok(state.fills.every(f=>f.quantity===7));ledger(state);
  for(const prices of [[25,25,25,25],[26,25,25,25],[20,20,20]]) {
    const idle=basket('sell',prices);assert.equal(arbitrateCompleteSets(idle).fills.length,0);ledger(idle);
  }
});

test("arbitrage respects unavailable cash, reserved inventory, and publicly folded outcomes",()=>{
  for(const side of ['buy','sell'] as const) {
    const state=basket(side,side==='buy'?[30,30,30,30]:[20,20,20,20]);
    const arb=state.accounts['trader-16'],amount=arb.cashUnits;
    arb.cashUnits=0;state.accounts.human.cashUnits+=amount;
    assert.equal(arbitrateCompleteSets(state).fills.length,0);ledger(state);
  }
  const folded=basket('sell',[30,30,30]);folded.values=[1/3,1/3,1/3,0];
  const state=arbitrateCompleteSets(folded);
  assert.equal(state.fills.length,3);ledger(state);
  const noToken=basket('sell',[30,30,30]);noToken.values=[1/3,1/3,1/3,0];
  noToken.accounts.human.shares[3]+=noToken.accounts['trader-16'].shares[3];noToken.accounts['trader-16'].shares[3]=0;
  assert.equal(arbitrateCompleteSets(noToken).fills.length,0);ledger(noToken);
});

test("legacy games retain original opening inventory metadata and settlement probability rounding",()=>{
  const state=createMarket([.25,.25,.25,.25],2,1000,"jev");
  delete state.traders[0].initialSharesPerOutcome;
  assert.equal(getMarketView(state).traderPositions[0].initialSharesPerOutcome,700);
  const settled=settleMarket(state,[1/3,1/3,1/3,0]);
  assert.deepEqual(probabilityUnits(getMarketView(settled).probabilities!),[334,333,333,0]);
  assert.deepEqual(settled.history.at(-1)!.probabilities,[1/3,1/3,1/3,0]);ledger(settled);
});


test("reserved cash and folded-token sell orders constrain complete-set arbitrage",()=>{
  const state=basket('sell',[20,20,20,20]);
  // A legacy large resting limit reserves every available dollar without crossing.
  state.orders.push({id:'reserve-cash',owner:'trader-16',outcome:0,side:'buy',priceTicks:1,quantity:400000,remaining:400000,sequence:++state.sequence,createdAt:0,expiresAt:null});
  assert.equal(arbitrateCompleteSets(state).fills.length,0);ledger(state);
  let folded=basket('sell',[30,30,30]);folded.values=[1/3,1/3,1/3,0];
  folded=replaceTraderOrders({...folded,values:[.25,.25,.25,.25]},'trader-16',Array.from({length:5},()=>({outcome:3,side:'sell' as const,priceTicks:99,quantity:400})));
  folded.values=[1/3,1/3,1/3,0];
  assert.equal(arbitrateCompleteSets(folded).fills.length,0);ledger(folded);
});


test("public folds update probability history without manufacturing ticks or fills",()=>{
  const opening=createMarket([.25,.25,.25,.25],8,1000,"jev");
  const folded=advanceMarket(opening,[0,1,1,1],0);
  assert.equal(folded.tick,0);assert.equal(folded.fills.length,0);
  assert.deepEqual(folded.history.at(-1)!.probabilities,[0,1/3,1/3,1/3]);
  assert.deepEqual(probabilityUnits(folded.history.at(-1)!.probabilities!),[0,334,333,333]);
});
