import {readFileSync} from 'node:fs';
import {DEFAULT_MODELS,requestDecision} from '../lib/providers.ts';
import {createHand,getObservation,applyAction} from '../lib/poker.ts';
import {randomBytes} from 'node:crypto';
const key=readFileSync(new URL('../.dev.vars',import.meta.url),'utf8').match(/^AI_GATEWAY_API_KEY=(.+)$/m)?.[1];
if(!key)throw new Error('No local key configured.');
for(const [seat,model] of (process.env.RIVER_TEST_MODELS?.split(',')??DEFAULT_MODELS).entries()) {
  const game=createHand(randomBytes(32).toString('hex'),(seat+1)%4);
  const observation=getObservation(game,seat), start=Date.now();
  let action=await requestDecision(observation,model,key);
  try {applyAction(game,action);} catch(error) {action=await requestDecision(observation,model,key,error.message);applyAction(game,action);}
  console.log(JSON.stringify({model,seat,verified:true,action,elapsedMs:Date.now()-start}));
}
