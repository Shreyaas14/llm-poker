import assert from 'node:assert/strict';
const origin = process.env.RIVER_TEST_ORIGIN || 'http://127.0.0.1:5173';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)) throw new Error('Smoke tests require the local preview.');
let cookie='';
async function call(path, method='GET', body, expected=200, headers={}) {
  const response=await fetch(origin+path,{method,redirect:'manual',headers:{cookie,origin,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
  for(const value of response.headers.getSetCookie()) cookie=[...cookie.split('; ').filter(part=>!part.startsWith(value.split('=')[0]+'=')),value.split(';')[0]].filter(Boolean).join('; ');
  const text=await response.text();
  assert.equal(response.status,expected,`${method} ${path}: ${text.slice(0,300)}`);
  if(!text)return null;
  try {return JSON.parse(text);} catch {if(expected>=400)return text;throw new Error(`Expected JSON from ${path}`);}
}
await call('/api/bootstrap');
const anonymousCookie=cookie;
await call('/signin-with-chatgpt?return_to=/','GET',undefined,302);
const boot=await call('/api/bootstrap');assert.equal(boot.authenticated,true);
await call('/api/profile','POST',{username:'RiverDemo'});
const live=process.env.RIVER_TEST_LIVE==='1';
const requestId=crypto.randomUUID();
let game=await call('/api/session','POST',{requestId,mode:live?'live':'practice',ranked:!live});
assert.equal(game.mode,live?'live':'practice');
const id=game.id, commandPath=`/api/session/${id}/command`;
const command=body=>call(commandPath,'POST',{requestId:crypto.randomUUID(),...body});
const inaccessible=await fetch(`${origin}/api/session/${id}`,{headers:{cookie:anonymousCookie}});assert.equal(inaccessible.status,404);
await call(commandPath,'POST',{type:'tick',requestId:crypto.randomUUID()},403,{origin:'https://example.com'});
game=await command({type:'playback',paused:true});
assert.equal(game.paused,true);assert.equal(game.tradingOpen,false);
const paused=await call(`/api/session/${id}`);assert.equal(paused.paused,true);
await call(commandPath,'POST',{requestId:crypto.randomUUID(),type:'order',pokerRevision:game.pokerRevision,outcome:0,side:'buy',quantity:1,limitPrice:.99,orderType:'ioc'},409);
await call(commandPath,'POST',{requestId:crypto.randomUUID(),type:'advance',pokerRevision:game.pokerRevision},409);
const pausedTick=await command({type:'tick'});assert.deepEqual(pausedTick.market,game.market);
assert.equal(pausedTick.marketSecondsRemaining,game.marketSecondsRemaining);
game=await command({type:'playback',paused:false});assert.equal(game.paused,false);assert.equal(game.tradingOpen,true);
let expectedCash=1000, count=0;const seen=new Set();
while(game.status!=='complete') {
  if(game.status==='hand_complete') {game=await command({type:'next_hand',pokerRevision:game.pokerRevision});continue;}
  if(game.tradingOpen && game.market.positions.every(p=>p.quantity===0)) {
    const book=game.market.books.find(b=>b.bestAsk!==null && b.bestAsk<.99);
    if(book) {
      const order={requestId:crypto.randomUUID(),type:'order',pokerRevision:game.pokerRevision,outcome:book.outcome,side:'buy',quantity:2,limitPrice:book.bestAsk,orderType:'ioc'};
      game=await call(commandPath,'POST',order);
      const cash=game.market.cash;
      const repeated=await call(commandPath,'POST',order);assert.equal(repeated.market.cash,cash);assert.equal(repeated.version,game.version);
      expectedCash=cash;
    }
  }
  const before=game, started=Date.now();
  seen.add(before.players[before.actor].name);
  game=await command({type:'advance',pokerRevision:before.pokerRevision});count++;
  if(live) console.log(`Live action ${count}: ${before.players[before.actor].name}; ${Date.now()-started}ms; ${game.status}`);
  assert.equal(game.players.length,4);assert.equal(JSON.stringify(game).includes('"deck"'),false);assert.equal(JSON.stringify(game).includes('"seed"'),false);
  if(game.status!=='playing') {
    const payout=before.market.positions.reduce((n,p)=>n+p.quantity*game.market.payouts[p.outcome],0);
    expectedCash+=payout;
    assert.ok(Math.abs(game.market.cash-expectedCash)<1e-6);
    console.log(`Hand ${game.hand}: settled ${game.market.cash.toFixed(4)} credits`);
  }
  const oldOrder={requestId:crypto.randomUUID(),type:'order',pokerRevision:before.pokerRevision,outcome:0,side:'buy',quantity:1,limitPrice:.01,orderType:'ioc'};
  await call(commandPath,'POST',oldOrder,409);
  if(count>200)throw new Error('Game did not terminate.');
}
assert.equal(game.results.length,5);assert.equal(game.pnl,game.market.cash-1000);
const saved=await call(`/api/session/${id}`);assert.equal(saved.pnl,game.pnl);
const after=await call('/api/bootstrap');
if(!live) {const row=after.practiceLeaderboard.find(r=>r.isYou);assert.ok(row);assert.ok(Math.abs(row.pnl-game.pnl)<1e-6);}
console.log(JSON.stringify({verified:true,mode:game.mode,id,actions:count,models:[...seen],finalPnl:game.pnl,ranked:game.ranked}));
