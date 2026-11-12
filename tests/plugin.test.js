import test from 'node:test';
import assert from 'node:assert/strict';
import {apply,normalizeBase} from '../index.js';
const token='administrator-fixture-'.padEnd(48,'x');
function host(){let route,record;apply({credentials:{readRecord:async()=>record,modifyRecord:async(name,fn)=>{record=await fn();},describe:async()=>({configured:false})},connection:{fetch:{register:r=>{route=r;}}}});return {call:async(action,payload={})=>(await route.fetch(new Request('http://localhost/api/team-budget',{method:'POST',body:JSON.stringify({action,payload})}))).json(),record:()=>record};}
test('first install asks for setup without assuming a developer gateway',async()=>{const h=host();assert.deepEqual((await h.call('state')).value,{setupRequired:true});assert.equal(h.record(),undefined);});
test('only safe HTTPS or loopback gateway URLs are accepted',()=>{assert.equal(normalizeBase('https://gateway.example.com/v1/'),'https://gateway.example.com');assert.equal(normalizeBase('http://127.0.0.1:8791/'),'http://127.0.0.1:8791');for(const base of ['http://remote.example.com','https://user:pass@gateway.example.com','https://gateway.example.com/?secret=x','file:///tmp/x'])assert.throws(()=>normalizeBase(base));});
test('connection is verified before credentials are saved; no administrator token in UI responses',async()=>{
 const original=globalThis.fetch;const h=host();const calls=[];
 try{globalThis.fetch=async(url,options)=>{calls.push({url,options});return Response.json({keys:[],upstreams:[]});};
  const result=await h.call('connect',{base:'https://gateway.example.com/v1',token});assert.equal(result.ok,true);assert.equal(h.record().payload.base,'https://gateway.example.com');assert.equal(h.record().payload.token,token);assert.ok(!JSON.stringify(result).includes(token));
  await h.call('keyDelete',{id:'member-123'});assert.equal(calls.at(-1).url,'https://gateway.example.com/admin/keys/member-123');assert.equal(calls.at(-1).options.method,'DELETE');assert.equal(calls.at(-1).options.headers.Authorization,'Bearer '+token);
  assert.equal((await h.call('keyDelete',{id:'../other'})).ok,false);
 }finally{globalThis.fetch=original;}
});
test('a rejected administrator token cannot overwrite a saved connection',async()=>{
 const original=globalThis.fetch,h=host();try{globalThis.fetch=async()=>Response.json({error:{message:'管理员认证失败'}},{status:401});const result=await h.call('connect',{base:'https://gateway.example.com',token});assert.equal(result.ok,false);assert.equal(h.record(),undefined);assert.ok(!JSON.stringify(result).includes(token));}finally{globalThis.fetch=original;}
});
