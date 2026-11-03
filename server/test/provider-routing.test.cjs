const assert = require('node:assert/strict');
const {requestDraftModel} = require('../../server-dist/server/src/patternDraft.js');
const body={model:'anthropic/claude-sonnet-5',max_tokens:8000,response_format:{type:'json_object'},messages:[{role:'system',content:'Return JSON'},{role:'user',content:'Evidence'}]};
process.env.ANTHROPIC_API_KEY='fixture-anthropic';process.env.OPENROUTER_API_KEY='fixture-router';
const original=global.fetch;
(async()=>{
 const calls=[];
 global.fetch=async(url,opts)=>{calls.push([url,opts]);return new Response(JSON.stringify({model:'claude-sonnet-5',content:[{type:'text',text:'{"problem":"evidence"}'}],usage:{input_tokens:9,output_tokens:3}}),{status:200});};
 const first=await requestDraftModel(body);
 assert.equal(first.provider,'anthropic');assert.equal(calls.length,1);assert.match(calls[0][0],/api.anthropic.com/);
 const sent=JSON.parse(calls[0][1].body);assert.equal(sent.model,'claude-sonnet-5');assert.equal(sent.system[0].cache_control.ttl,'1h');assert.equal(sent.messages[0].content,'Evidence');assert.equal(calls[0][1].headers['x-api-key'],'fixture-anthropic');assert.equal(first.json.choices[0].message.content,'{"problem":"evidence"}');
 calls.length=0;
 global.fetch=async(url,opts)=>{calls.push([url,opts]);return url.includes('anthropic.com')?new Response('{"error":{"message":"credit balance is too low"}}',{status:400}):new Response('{"choices":[{"message":{"content":"{}"}}]}',{status:200});};
 const fallback=await requestDraftModel(body);assert.equal(fallback.provider,'openrouter');assert.equal(calls.length,2);assert.match(fallback.primary_error,/credit balance/);assert.deepEqual(JSON.parse(calls[1][1].body),body);assert.equal(calls[1][1].headers.Authorization,'Bearer fixture-router');
 global.fetch=async()=>new Response('{"error":{"message":"unavailable"}}',{status:503});
 await assert.rejects(requestDraftModel(body),/Neither model provider answered.*anthropic:.*openrouter:/);
 console.log('Provider routing: direct primary, cached system, same evidence on fallback, both-provider failure passed');
})().finally(()=>{global.fetch=original;}).catch(e=>{console.error(e);process.exitCode=1;});
