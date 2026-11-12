import http from 'node:http';
import {mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';
import {Store,GateError} from './store.js';
import {PRICES,prepare,normalizeUsage,tokenCost,UsageParser,settlementPrice} from './pricing.js';

const sha=s=>createHash('sha256').update(s).digest();
const equal=(a,b)=>timingSafeEqual(sha(a),sha(b));
const ROUTES={
 '/v1/chat/completions':{kind:'chat',path:'/chat/completions'},
 '/chat/completions':{kind:'chat',path:'/chat/completions'},
 '/v1/responses':{kind:'responses',path:'/responses'},
 '/v1/messages':{kind:'messages',path:'/anthropic/v1/messages'},
 '/anthropic/v1/messages':{kind:'messages',path:'/anthropic/v1/messages'},
 '/v1/tools/search':{kind:'search',path:'/v1/tools/search'},
 '/v1/tools/fetch':{kind:'fetch',path:'/v1/tools/fetch'},
};
async function readJson(req,max=2*1024*1024){let n=0;const chunks=[];for await(const c of req){n+=c.length;if(n>max)throw new GateError('请求过大',413,'request_too_large');chunks.push(c);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new GateError('请求不是有效 JSON');}}
function bearer(req){const auth=req.headers.authorization;if(typeof auth==='string'&&auth.startsWith('Bearer '))return auth.slice(7);return req.headers['x-api-key'];}
const reply=(res,status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));};
export function createGateway({database,encryptionKey,adminToken,publicBase,fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=300000}){
 if(typeof adminToken!=='string'||adminToken.length<32)throw new Error('Missing strong admin token');
 const store=new Store(database,encryptionKey,now),inflight=new Set();
 async function validateUpstream(secret){
  if(typeof secret!=='string'||!/^[\x21-\x7e]{16,512}$/.test(secret.trim()))throw new GateError('官方密钥格式无效');
  const r=await fetchImpl('https://api.deepseek.com/models',{headers:{Authorization:`Bearer ${secret.trim()}`},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw new GateError(`DeepSeek 密钥验证失败（HTTP ${r.status}）`);
  const value=await r.json();
  const models=(value.data??[]).map(x=>x.id).filter(m=>Object.hasOwn(PRICES,m));
  if(models.length===0)throw new GateError('官方未返回当前已支持计价的模型，请核对模型目录');
  return models;
 }
 const server=http.createServer(async(req,res)=>{
  let ticket,prepared;
  try{
   const pathname=new URL(req.url,'http://localhost').pathname;
   if(req.method==='GET'&&pathname==='/health'){reply(res,200,{ok:true,service:'dsh-managed-gateway'});return;}
   if(pathname.startsWith('/admin/')){
    if(typeof bearer(req)!=='string'||!equal(bearer(req),adminToken))throw new GateError('管理员认证失败',401,'unauthorized');
    if(req.method==='GET'&&pathname==='/admin/state'){reply(res,200,{...store.state(),publicBase,baseUrl:publicBase+'/v1'});return;}
    const body=req.method==='DELETE'?{}:await readJson(req,64*1024);
    let value;
    if(req.method==='POST'&&pathname==='/admin/upstreams'){
     const models=await validateUpstream(body.apiKey);value=store.saveUpstream(body,models);
    }else if(req.method==='DELETE'&&/^\/admin\/upstreams\/[\w-]+$/.test(pathname)){
     value=store.deleteUpstream(pathname.split('/').at(-1));
    }else if(req.method==='PATCH'&&/^\/admin\/upstreams\/[\w-]+$/.test(pathname)){
     const id=pathname.split('/').at(-1),prior=store.upstream(id),models=body.apiKey?await validateUpstream(body.apiKey):JSON.parse(prior.models);value=store.saveUpstream(body,models,id);
    }else if(req.method==='POST'&&pathname==='/admin/keys')value=store.createKey(body);
    else if(req.method==='DELETE'&&/^\/admin\/keys\/[\w-]+$/.test(pathname))value=store.deleteKey(pathname.split('/').at(-1));
    else if(req.method==='PATCH'&&/^\/admin\/keys\/[\w-]+$/.test(pathname))value=store.updateKey(pathname.split('/').at(-1),body);
    else if(req.method==='POST'&&/^\/admin\/keys\/[\w-]+\/rotate$/.test(pathname))value=store.rotate(pathname.split('/').at(-2));
    else if(req.method==='POST'&&/^\/admin\/requests\/[\w-]+\/reconcile$/.test(pathname))value=store.reconcile(pathname.split('/').at(-2),body.cost);
    else throw new GateError('管理接口不存在',404);
    reply(res,200,value);return;
   }
   const key=store.authenticate(bearer(req));
   if(!key.policy.enabled)throw new GateError('此密钥已停用',403,'key_disabled');
   if(req.method==='GET'&&['/v1/models','/models'].includes(pathname)){
    reply(res,200,{object:'list',data:key.policy.models.map(id=>({id,object:'model',created:0,owned_by:'deepseek'}))});return;
   }
   if(req.method==='GET'&&pathname==='/v1/usage'){
    const k=store.keyView(key);delete k.upstreamId;delete k.prefix;reply(res,200,{...k,currency:'CNY',pricing:'beijing-schedule-estimate',month:store.state().month});return;
   }
   const route=ROUTES[pathname];
   if(req.method!=='POST'||!route)throw new GateError('仅开放已支持的模型与工具接口',404,'unsupported_route');
   const body=await readJson(req);prepared=prepare(body,route.kind,key.policy);
   ticket=store.reserve(key,prepared);ticket.started=now();inflight.add(ticket.id);
   const upstream=await fetchImpl('https://api.deepseek.com'+route.path,{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${ticket.upstreamKey}`,'User-Agent':'DSH-Managed-Gateway/1.0',...(route.kind==='messages'?{'anthropic-version':'2023-06-01'}:{})},
    body:JSON.stringify(prepared.body),redirect:'error',signal:AbortSignal.timeout(timeoutMs),
   });
   if(!upstream.ok){
    store.settle(ticket.id,0,null,'rejected',`上游 HTTP ${upstream.status}`);inflight.delete(ticket.id);ticket=null;
    reply(res,upstream.status,{error:{message:`DeepSeek 返回 HTTP ${upstream.status}，请检查模型、余额或请求参数`,type:'upstream_error',code:'upstream_error'}});await upstream.body?.cancel();return;
   }
   const headers={'Content-Type':upstream.headers.get('content-type')??'application/json','Cache-Control':'no-store','X-Accel-Buffering':'no',...(ticket.warning?{'X-Budget-Warning':'monthly-threshold-reached'}:{})};
   if(body.stream===true&&!['search','fetch'].includes(route.kind)){
    const parser=new UsageParser(prepared.protocol);res.writeHead(upstream.status,headers);
    for await(const chunk of upstream.body){
     parser.chunk(chunk);
     // If a client disconnects, drain the provider's receipt to settle actual usage instead of releasing unverified spend.
     if(!res.destroyed&&!res.write(chunk))await Promise.race([once(res,'drain'),once(res,'close')]);
    }
    const usage=parser.end(),cost=usage?tokenCost(usage,settlementPrice(prepared.price,ticket.started,now())):null;
    store.settle(ticket.id,cost,usage,usage?'complete':'uncertain',usage?'':'流结束但未返回完整用量，保留预留额度');
    inflight.delete(ticket.id);ticket=null;if(!res.destroyed)res.end();
   }else{
    const raw=await upstream.text();let value;try{value=JSON.parse(raw);}catch{value=null;}
    let usage,cost;
    if(route.kind==='search'||route.kind==='fetch'){
     const valid=route.kind==='search'?Array.isArray(value?.results):typeof value?.content==='string';
     const billed=valid&&(route.kind==='search'?value.results.length>0:value.content.length>0);
     usage=valid?{operations:billed?1:0}:null;cost=valid?(billed?5000000:0):null;
    }else{usage=normalizeUsage(value?.usage,prepared.protocol);cost=usage?tokenCost(usage,settlementPrice(prepared.price,ticket.started,now())):null;}
    store.settle(ticket.id,cost,usage,cost===null?'uncertain':'complete',cost===null?'响应缺少完整用量，保留预留额度':'');
    inflight.delete(ticket.id);ticket=null;res.writeHead(upstream.status,headers);res.end(raw);
   }
  }catch(e){
   if(ticket){
    try{store.settle(ticket.id,null,null,'uncertain','请求异常，费用尚未确认，预留额度未释放');}catch{/* Keep the durable pending reservation; startup recovery retains it. */}
    inflight.delete(ticket.id);
   }
   if(!res.headersSent&&!res.destroyed)reply(res,e.status??(ticket?502:400),{error:{message:e instanceof GateError||!ticket?e.message:'上游连接异常，已保留本次预留预算，请在管理端核对',type:'gateway_error',code:e.code??'gateway_error'}});
   else if(!res.destroyed)res.end();
  }
 });
 server.requestTimeout=350000;server.headersTimeout=15000;
 return {server,store,close:()=>new Promise((resolve,reject)=>server.close(e=>{store.close();e?reject(e):resolve();}))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const data=resolve(process.env.GATEWAY_DATA_DIR??'work/managed-gateway');mkdirSync(data,{recursive:true,mode:0o700});
 const secretFile=join(data,'admin-token.txt'),encFile=join(data,'encryption.key');
 if(!existsSync(secretFile))writeFileSync(secretFile,randomBytes(32).toString('base64url'),{mode:0o600,flag:'wx'});
 if(!existsSync(encFile))writeFileSync(encFile,randomBytes(32),{mode:0o600,flag:'wx'});
 const gateway=createGateway({database:join(data,'gateway.sqlite'),encryptionKey:readFileSync(encFile),adminToken:readFileSync(secretFile,'utf8').trim(),publicBase:process.env.GATEWAY_PUBLIC_BASE??'http://127.0.0.1:8791'});
 gateway.server.listen(Number(process.env.PORT??8791),process.env.HOST??'127.0.0.1',()=>console.log('Managed DeepSeek gateway ready; credentials are not printed.'));
 for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>gateway.close().then(()=>process.exit()));
}
