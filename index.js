export const inject=['connection','credentials'];
export function normalizeBase(value){
 if(typeof value!=='string'||!value.trim())throw new Error('请填写网关地址');
 const url=new URL(value.trim());
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if((url.protocol!=='https:'&&!(url.protocol==='http:'&&local))||url.username||url.password||url.search||url.hash)throw new Error('请使用 HTTPS 网关地址；本机回环地址可使用 HTTP');
 return url.href.replace(/\/+$/,'').replace(/\/v1$/,'');
}
export function apply(ctx,config={}){
 const credential='team-budget/gateway';
 const specs={state:['GET','/admin/state'],upstreamAdd:['POST','/admin/upstreams'],upstreamUpdate:['PATCH','/admin/upstreams/'],upstreamDelete:['DELETE','/admin/upstreams/'],keyAdd:['POST','/admin/keys'],keyDelete:['DELETE','/admin/keys/'],keyUpdate:['PATCH','/admin/keys/'],rotate:['POST','/admin/keys/'],reconcile:['POST','/admin/requests/']};
 async function saved(){const record=await ctx.credentials.readRecord(credential);const payload=record?.kind==='grant'?record.payload:{};return {base:payload?.base??config.gatewayBase??'',token:payload?.token};}
 async function gateway(action,payload={},override){
  const connection=override??await saved();
  if(!connection.base||!connection.token){if(action==='state')return {setupRequired:true};throw new Error('请先连接管理服务');}
  const base=normalizeBase(connection.base),token=connection.token,spec=specs[action];if(!spec)throw new Error('未知管理操作');
  let path=spec[1];const data={...payload};
  if(['keyUpdate','keyDelete','upstreamUpdate','upstreamDelete','rotate','reconcile'].includes(action)){
   if(typeof data.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(data.id))throw new Error('记录 ID 无效');
   path+=data.id+(action==='rotate'?'/rotate':action==='reconcile'?'/reconcile':'');delete data.id;
  }
  const r=await fetch(base+path,{method:spec[0],headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(spec[0]==='GET'?{}:{body:JSON.stringify(data)}),redirect:'error',signal:AbortSignal.timeout(30000)});
  let value;try{value=await r.json();}catch{throw new Error(`管理服务返回了无效响应（HTTP ${r.status}）`);}
  if(!r.ok)throw new Error(value.error?.message??`管理服务 HTTP ${r.status}`);return value;
 }
 ctx.connection.fetch.register({path:'/api/team-budget',methods:['GET','POST'],requestBody:'buffered',async fetch(request){
  try{
   if(request.method==='GET')return Response.json({ok:true,value:await gateway('state')},{headers:{'Cache-Control':'no-store'}});
   const raw=await request.text();if(raw.length>64*1024)throw new Error('管理请求过大');
   const {action,payload={}}=JSON.parse(raw);let value;
   if(action==='connect'){
    const base=normalizeBase(payload.base);
    if(typeof payload.token!=='string'||payload.token.length<32||payload.token.length>200)throw new Error('管理员凭据格式无效');
    await gateway('state',{}, {base,token:payload.token});
    await ctx.credentials.modifyRecord(credential,async()=>({kind:'grant',payload:{base,token:payload.token}}));value={connected:true};
   }else if(action==='configuredKey'){
    const info=await ctx.credentials.describe('DEEPSEEK_API_KEY');value={configured:info.configured};
   }else if(action==='importConfiguredKey'){
    const hit=await ctx.credentials.resolve('DEEPSEEK_API_KEY');if(!hit?.value)throw new Error('本机没有保存可读取的官方 API 密钥，请在输入框填写');
    value=await gateway('upstreamAdd',{...payload,apiKey:hit.value});
   }else value=await gateway(action,payload);
   return Response.json({ok:true,value},{headers:{'Cache-Control':'no-store'}});
  }catch(e){return Response.json({ok:false,error:e.message},{status:400,headers:{'Cache-Control':'no-store'}});}
 }});
}
