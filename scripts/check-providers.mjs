import {readFileSync} from 'node:fs';
import {DEFAULT_MODELS} from '../lib/providers.ts';
const apiKey=readFileSync(new URL('../.dev.vars',import.meta.url),'utf8').match(/^AI_GATEWAY_API_KEY=(.+)$/m)?.[1];
if(!apiKey)throw new Error('No local key configured.');
for(const model of process.env.RIVER_TEST_MODELS?.split(',')??DEFAULT_MODELS) {
  const start=Date.now();
  const response=await fetch('https://ai-gateway.vercel.sh/v1/chat/completions',{
    method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${apiKey}`},
    body:JSON.stringify({model,messages:[{role:'user',content:'Return exactly {"action":"check","raiseTo":null} as JSON.'}],max_tokens:1000}),signal:AbortSignal.timeout(25000)});
  const data=await response.json();
  const summary={model,status:response.status,elapsedMs:Date.now()-start,returnedModel:data.model,usage:data.usage,error:data.error?{code:data.error.code,type:data.error.type,message:data.error.message}:undefined,content:data.choices?.[0]?.message?.content};
  console.log(JSON.stringify(summary).replaceAll(apiKey,'[REDACTED]'));
}
