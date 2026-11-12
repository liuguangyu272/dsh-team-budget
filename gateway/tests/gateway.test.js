import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {createGateway} from '../server.js';
import {Store} from '../store.js';
import {UsageParser,prepare,normalizeUsage,PRICES,tokenCost,SCALE,tariffFactor,settlementPrice} from '../pricing.js';
const admin='admin-'.padEnd(50,'x'),official='sk-official-private-test-key-123456';
const defaultPolicy={name:'Alice',monthlyBudget:10,dailyBudget:null,warnPercent:80,rpm:60,parallel:3,maxOutputTokens:32,models:['deepseek-flash'],enabled:true};
function response(usage={prompt_tokens:1000,completion_tokens:4,prompt_cache_hit_tokens:200}){return Response.json({id:'test',choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}],usage});}
async function setup(mock=async()=>response(),clock=()=>Date.parse('2026-11-11T02:00:00Z')){
 const calls=[];
 const gate=createGateway({database:':memory:',encryptionKey:randomBytes(32),adminToken:admin,publicBase:'https://example.com/gateway',now:clock,fetchImpl:async(url,options)=>{if(url.endsWith('/models'))return Response.json({data:[{id:'deepseek-flash'},{id:'deepseek-v4-pro'}]});calls.push({url,options});return mock(url,options);}});
 await new Promise(r=>gate.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${gate.server.address().port}`;
 const request=async(path,token=admin,body,method=body===undefined?'GET':'POST')=>{const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await r.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:r.status,value,text};};
 const upstream=(await request('/admin/upstreams',admin,{name:'Shared',apiKey:official,monthlyBudget:null})).value;
 const key=async policy=>(await request('/admin/keys',admin,{...defaultPolicy,upstreamId:upstream.id,...policy})).value;
 const chat=(token,body={})=>request('/v1/chat/completions',token,{model:'deepseek-flash',messages:[{role:'user',content:'HELLO_PRIVATE_CONTENT'}],max_tokens:16,...body});
 return {...gate,base,calls,request,key,chat,upstream};
}
test('managed key routes through the official key, records actual cache usage, and never stores prompts',async()=>{
 const g=await setup();try{
  const k=await g.key();const r=await g.chat(k.secret);assert.equal(r.status,200);assert.equal(g.calls.length,1);
  assert.equal(g.calls[0].options.headers.Authorization,`Bearer ${official}`);
  const state=(await g.request('/admin/state')).value;
  assert.equal(state.keys[0].spent,0.00164);assert.equal(state.keys[0].held,0);assert.equal(state.recent[0].usage.total,1004);
  const serialized=JSON.stringify(state);for(const secret of [official,k.secret,'HELLO_PRIVATE_CONTENT'])assert.ok(!serialized.includes(secret));
  assert.ok(!g.store.db.prepare('SELECT encrypted FROM upstreams').get().encrypted.includes(official));
 }finally{await g.close();}
});
test('zero monthly budget blocks before provider dispatch',async()=>{
 const g=await setup();try{const k=await g.key({monthlyBudget:0});const r=await g.chat(k.secret);assert.equal(r.status,402);assert.equal(r.value.error.code,'monthly_budget_exceeded');assert.equal(g.calls.length,0);}finally{await g.close();}
});
test('pre-reservations serialize concurrent traffic against one monthly budget',async()=>{
 let release;const wait=new Promise(r=>release=r);const g=await setup(async()=>{await wait;return response();});
 try{const k=await g.key({monthlyBudget:0.004});const first=g.chat(k.secret);while(g.calls.length===0)await new Promise(r=>setTimeout(r,5));const second=await g.chat(k.secret);assert.equal(second.status,402);assert.equal(g.calls.length,1);release();assert.equal((await first).status,200);}finally{release();await g.close();}
});
test('model permission applies to both model listing and calls',async()=>{
 const g=await setup();try{const k=await g.key();const models=await g.request('/v1/models',k.secret);assert.deepEqual(models.value.data.map(x=>x.id),['deepseek-flash']);assert.equal((await g.chat(k.secret,{model:'deepseek-v4-pro'})).status,403);assert.equal(g.calls.length,0);}finally{await g.close();}
});
test('key disable and rotation immediately affect subsequent authentication',async()=>{
 const g=await setup();try{const k=await g.key();await g.request(`/admin/keys/${k.key.id}`,admin,{enabled:false},'PATCH');assert.equal((await g.chat(k.secret)).status,403);await g.request(`/admin/keys/${k.key.id}`,admin,{enabled:true},'PATCH');const rotated=(await g.request(`/admin/keys/${k.key.id}/rotate`,admin,{})).value;assert.equal((await g.chat(k.secret)).status,401);assert.equal((await g.chat(rotated.secret)).status,200);}finally{await g.close();}
});
test('provider failures return no secret and release unbilled reservations',async()=>{
 const g=await setup(async()=>Response.json({error:{message:official}},{status:401}));try{const k=await g.key();const r=await g.chat(k.secret);assert.equal(r.status,401);assert.ok(!r.text.includes(official));const s=(await g.request('/admin/state')).value;assert.equal(s.keys[0].held,0);assert.equal(s.keys[0].spent,0);}finally{await g.close();}
});
test('missing or failed usage receipts retain budget until administrator reconciliation',async()=>{
 const g=await setup(async()=>Response.json({choices:[]}));try{const k=await g.key();assert.equal((await g.chat(k.secret)).status,200);let s=(await g.request('/admin/state')).value;assert.ok(s.keys[0].held>0);assert.equal(s.recent[0].status,'uncertain');await g.request(`/admin/requests/${s.recent[0].id}/reconcile`,admin,{cost:0});s=(await g.request('/admin/state')).value;assert.equal(s.keys[0].held,0);assert.equal(s.recent[0].status,'reconciled');}finally{await g.close();}
});
test('streamed Chat usage is decoded across frames and forwarded without modification',async()=>{
 const text='data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: {"usage":{"prompt_tokens":1000,"prompt_cache_hit_tokens":200,"completion_tokens":4}}\n\ndata: [DONE]\n\n';
 const bytes=Buffer.from(text);
 const g=await setup(async()=>new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.subarray(i,i+7));c.close();}}),{headers:{'Content-Type':'text/event-stream'}}));
 try{const k=await g.key();const r=await g.chat(k.secret,{stream:true});assert.equal(r.text,text);assert.equal(JSON.parse(g.calls[0].options.body).stream_options.include_usage,true);assert.equal(g.store.state().keys[0].spent,0.00164);assert.equal(g.store.state().keys[0].held,0);}finally{await g.close();}
});
test('Anthropic messages and Responses normalize cached input consistently',async()=>{
 assert.deepEqual(normalizeUsage({input_tokens:800,cache_read_input_tokens:200,output_tokens:4},'messages'),{input:800,cache:200,output:4,total:1004});
 assert.deepEqual(normalizeUsage({input_tokens:1000,input_tokens_details:{cached_tokens:200},output_tokens:4},'responses'),{input:800,cache:200,output:4,total:1004});
 const p=new UsageParser('messages');for(const event of [{type:'message_start',message:{usage:{input_tokens:800,cache_read_input_tokens:200,output_tokens:0}}},{type:'message_delta',usage:{output_tokens:4}}])p.chunk(Buffer.from('data: '+JSON.stringify(event)+'\n\n'));
 assert.equal(tokenCost(p.end(),PRICES['deepseek-flash']),1640000);
});
test('native Messages and Responses route to the correct fixed upstream endpoints',async()=>{
 const g=await setup(async url=>url.includes('anthropic')?Response.json({content:[],usage:{input_tokens:800,cache_read_input_tokens:200,output_tokens:4}}):Response.json({output:[],usage:{input_tokens:1000,input_tokens_details:{cached_tokens:200},output_tokens:4}}));
 try{const k=await g.key();assert.equal((await g.request('/anthropic/v1/messages',k.secret,{model:'deepseek-flash',max_tokens:16,messages:[]})).status,200);assert.equal((await g.request('/v1/responses',k.secret,{model:'deepseek-flash',max_output_tokens:16,input:'hello'})).status,200);assert.ok(g.calls[0].url.endsWith('/anthropic/v1/messages'));assert.ok(g.calls[1].url.endsWith('/responses'));}finally{await g.close();}
});
test('daily and upstream shared budgets also reject before dispatch',async()=>{
 const g=await setup();try{const k=await g.key({dailyBudget:0});assert.equal((await g.chat(k.secret)).value.error.code,'daily_budget_exceeded');await g.request(`/admin/keys/${k.key.id}`,admin,{dailyBudget:null},'PATCH');await g.request(`/admin/upstreams/${g.upstream.id}`,admin,{name:'Shared',monthlyBudget:0},'PATCH');assert.equal((await g.chat(k.secret)).value.error.code,'upstream_budget_exceeded');assert.equal(g.calls.length,0);}finally{await g.close();}
});
test('RPM, output limits and unsupported server-side tools cannot bypass management',async()=>{
 const g=await setup();try{const k=await g.key({rpm:1});assert.equal((await g.chat(k.secret,{max_tokens:1000})).status,200);assert.equal(JSON.parse(g.calls[0].options.body).max_tokens,32);assert.equal((await g.chat(k.secret)).status,429);assert.equal((await g.chat(k.secret,{tools:[{type:'web_search',input_schema:{}}]})).status,400);assert.equal(g.calls.length,1);}finally{await g.close();}
});
test('budget threshold alerts are persisted and deduplicated',async()=>{
 const g=await setup();try{const k=await g.key({monthlyBudget:0.01,warnPercent:10});await g.chat(k.secret);await g.chat(k.secret);const alerts=g.store.state().alerts.filter(x=>x.kind==='budget_warning');assert.equal(alerts.length,1);assert.ok(alerts[0].message.includes('10%'));}finally{await g.close();}
});
test('calendar-month reset works at Beijing midnight without a scheduled job',async()=>{
 let clock=Date.parse('2026-11-30T15:59:00Z');const g=await setup(undefined,()=>clock);try{const k=await g.key();await g.chat(k.secret);assert.ok(g.store.state().keys[0].spent>0);clock=Date.parse('2026-11-30T16:00:00Z');assert.equal(g.store.state().keys[0].spent,0);assert.equal(g.store.state().month,'2026-12');assert.equal((await g.chat(k.secret)).status,200);}finally{await g.close();}
});
test('an interrupted gateway restart preserves pending budget instead of granting free spend',async()=>{
 await mkdir(resolve('work'),{recursive:true});
 const dir=await mkdtemp(resolve('work/gateway-restart-')),file=resolve(dir,'test.sqlite'),enc=randomBytes(32);
 try{let store=new Store(file,enc);const u=store.saveUpstream({name:'test',apiKey:official},['deepseek-flash']);const k=store.createKey({...defaultPolicy,upstreamId:u.id});const key=store.authenticate(k.secret);store.reserve(key,prepare({model:'deepseek-flash',messages:[],max_tokens:16},'chat',key.policy));store.close();store=new Store(file,enc);try{assert.equal(store.state().recent[0].status,'uncertain');assert.ok(store.state().keys[0].held>0);assert.equal(store.decrypt(store.upstream(u.id).encrypted),official);}finally{store.close();}}finally{if(!dir.startsWith(resolve('work')+sep))throw new Error('Cleanup target outside workspace');await rm(dir,{recursive:true,force:true});}
});
test('Search and Fetch are separately permissioned and billed only for successful results',async()=>{
 const g=await setup(async url=>url.endsWith('/search')?Response.json({results:[]}):Response.json({content:'page'}));try{const k=await g.key();assert.equal((await g.request('/v1/tools/search',k.secret,{query:'test'})).status,403);await g.request(`/admin/keys/${k.key.id}`,admin,{webTools:true},'PATCH');await g.request('/v1/tools/search',k.secret,{query:'test'});assert.equal(g.store.state().keys[0].spent,0);await g.request('/v1/tools/fetch',k.secret,{url:'https://example.com'});assert.equal(g.store.state().keys[0].spent,0.005);}finally{await g.close();}
});
test('member keys cannot call administration and unknown routes remain closed',async()=>{
 const g=await setup();try{const k=await g.key();assert.equal((await g.request('/admin/state',k.secret)).status,401);assert.equal((await g.request('/v1/files',k.secret,{})).status,404);assert.equal((await g.chat('invalid')).status,401);assert.equal(g.calls.length,0);}finally{await g.close();}
});
test('developer-role compatibility is translated and multiple completions remain closed',async()=>{
 const g=await setup();try{const k=await g.key();await g.chat(k.secret,{messages:[{role:'developer',content:'system rule'},{role:'user',content:'hello'}]});assert.equal(JSON.parse(g.calls[0].options.body).messages[0].role,'system');assert.equal((await g.chat(k.secret,{n:2})).status,400);assert.equal(g.calls.length,1);}finally{await g.close();}
});


test('Beijing tariff boundaries, weekends and verified holidays use correct discounts',()=>{
 const f=s=>tariffFactor(Date.parse(s+'+08:00'));
 assert.equal(f('2026-11-11T08:59:59'),0.5);assert.equal(f('2026-11-11T09:00:00'),1);
 assert.equal(f('2026-11-11T11:59:59'),1);assert.equal(f('2026-11-11T12:00:00'),0.5);
 assert.equal(f('2026-11-11T14:00:00'),1);assert.equal(f('2026-11-11T18:00:00'),0.5);
 assert.equal(f('2026-10-02T10:00:00'),0.5);assert.equal(f('2026-10-10T10:00:00'),0.5);
 assert.equal(f('2027-02-08T10:00:00'),0.5);assert.equal(f('2027-02-15T10:00:00'),1);
 const p=PRICES['deepseek-flash'];assert.equal(settlementPrice(p,Date.parse('2026-11-11T04:00:00Z')).output,4);
 assert.equal(settlementPrice(p,Date.parse('2026-11-11T03:59:59Z'),Date.parse('2026-11-11T04:00:01Z')).output,8);
});

test('off-peak calls settle at half price while keeping full peak pre-reservations',async()=>{
 const g=await setup(undefined,()=>Date.parse('2026-11-11T13:00:00Z'));
 try{const k=await g.key();await g.chat(k.secret);const s=g.store.state();assert.equal(s.keys[0].spent,0.00082);assert.equal(s.keys[0].held,0);assert.ok(s.recent[0].reserve>s.recent[0].cost*2);}finally{await g.close();}
});

test('deleting a provider removes its saved secret, revokes dependent keys and preserves historical usage',async()=>{
 const g=await setup();try{
  const k=await g.key();assert.equal((await g.chat(k.secret)).status,200);
  assert.equal((await g.request(`/admin/upstreams/${g.upstream.id}`,k.secret,{},'DELETE')).status,401);
  const removed=await g.request(`/admin/upstreams/${g.upstream.id}`,admin,{},'DELETE');assert.equal(removed.status,200);assert.equal(removed.value.disabledKeys,1);
  const s=g.store.state();assert.equal(s.upstreams.length,0);assert.equal(s.keys[0].enabled,false);assert.equal(s.recent.length,1);assert.ok(s.keys[0].spent>0);
  assert.equal(g.store.upstream(g.upstream.id).encrypted,'');assert.equal((await g.chat(k.secret)).status,403);
  assert.equal((await g.request(`/admin/keys/${k.key.id}`,admin,{enabled:true},'PATCH')).status,400);
  assert.equal((await g.request('/admin/keys',admin,{...defaultPolicy,upstreamId:g.upstream.id})).status,400);
  assert.equal((await g.request(`/admin/upstreams/${g.upstream.id}`,admin,{},'DELETE')).status,404);
 }finally{await g.close();}
});

test('member creation and edits reject models unavailable on the selected provider',async()=>{
 const g=await setup();try{
  const bad=await g.request('/admin/keys',admin,{...defaultPolicy,upstreamId:g.upstream.id,models:['deepseek-v4-flash']});assert.equal(bad.status,400);assert.ok(bad.value.error.message.includes('模型'));
  const k=await g.key();assert.equal((await g.request(`/admin/keys/${k.key.id}`,admin,{models:['deepseek-v4-flash']},'PATCH')).status,400);
 }finally{await g.close();}
});

test('member deletion revokes access, removes list entry, keeps ledger and cannot be reversed',async()=>{
 const g=await setup();try{
  const k=await g.key();await g.chat(k.secret);
  assert.equal((await g.request(`/admin/keys/${k.key.id}`,k.secret,{},'DELETE')).status,401);
  assert.equal((await g.request(`/admin/keys/${k.key.id}`,admin,{},'DELETE')).status,200);
  const s=g.store.state();assert.equal(s.keys.length,0);assert.equal(s.archivedKeys.length,1);assert.ok(s.archivedKeys[0].spent>0);assert.equal(s.recent[0].key_id,k.key.id);
  assert.equal((await g.chat(k.secret)).status,401);
  assert.equal((await g.request(`/admin/keys/${k.key.id}`,admin,{enabled:true},'PATCH')).status,404);
  assert.equal((await g.request(`/admin/keys/${k.key.id}/rotate`,admin,{})).status,404);
  assert.equal((await g.request(`/admin/keys/${k.key.id}`,admin,{},'DELETE')).status,404);
 }finally{await g.close();}
});

test('deleting an in-flight member key retains its reservation and does not free shared budget',async()=>{
 let release;const wait=new Promise(r=>release=r);const g=await setup(async()=>{await wait;return response();});
 try{
  await g.request(`/admin/upstreams/${g.upstream.id}`,admin,{name:'Shared',monthlyBudget:0.004},'PATCH');
  const k=await g.key(),pending=g.chat(k.secret);while(!g.calls.length)await new Promise(r=>setTimeout(r,5));
  await g.request(`/admin/keys/${k.key.id}`,admin,{},'DELETE');assert.ok(g.store.state().archivedKeys[0].held>0);
  const next=await g.key();assert.equal((await g.chat(next.secret)).value.error.code,'upstream_budget_exceeded');
  release();assert.equal((await pending).status,200);assert.equal(g.store.state().archivedKeys[0].held,0);assert.ok(g.store.state().archivedKeys[0].spent>0);
 }finally{release();await g.close();}
});

test('dashboard analytics include full history beyond recent rows and retain deleted member spend',async()=>{
 const g=await setup();try{
  const k=await g.key({rpm:1000,parallel:3});
  for(let i=0;i<65;i++)assert.equal((await g.chat(k.secret)).status,200);
  await g.request(`/admin/keys/${k.key.id}`,admin,{},'DELETE');
  const s=g.store.state();assert.equal(s.recent.length,60);assert.equal(s.analytics.today,'2026-11-11');assert.equal(s.analytics.month.requests,65);assert.equal(s.analytics.month.tokens,65*1004);assert.equal(s.analytics.daily[0].requests,65);assert.equal(s.analytics.daily[0].cost,65*0.00164);
 }finally{await g.close();}
});
