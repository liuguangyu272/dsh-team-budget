export const SCALE=1e9;
// Holiday ranges: State Council notices for 2026/2027. Weekend make-up workdays remain
// off-peak under DeepSeek's explicit Monday-Friday tariff rule.
const HOLIDAYS={
 2026:['01-01/01-03','02-15/02-23','04-04/04-06','05-01/05-05','06-19/06-21','09-25/09-27','10-01/10-07'],
 2027:['01-01/01-03','02-05/02-13','04-03/04-05','05-01/05-05','06-09/06-09','09-15/09-15','10-01/10-07'],
};
export function tariffFactor(ms){
 const local=new Date(ms+8*3600000),year=local.getUTCFullYear(),day=local.getUTCDay(),date=local.toISOString().slice(5,10),minute=local.getUTCHours()*60+local.getUTCMinutes();
 if(day===0||day===6||!((minute>=540&&minute<720)||(minute>=840&&minute<1080)))return 0.5;
 if(HOLIDAYS[year]?.some(range=>{const [a,b]=range.split('/');return date>=a&&date<=b;}))return 0.5;
 // Unmaintained future holiday calendars conservatively retain weekday peak rates.
 return 1;
}
export function settlementPrice(price,start,end=start){
 // A call crossing a tariff boundary uses the higher endpoint rate. Reservations
 // always use peak prices; published invoice timing can differ at the boundary.
 const factor=Math.max(tariffFactor(start),tariffFactor(end));
 return {...price,input:price.input*factor,cache:price.cache*factor,output:price.output*factor};
}
export const PRICES={
 'deepseek-flash':{input:2,cache:0.04,output:8,context:1048576},
 'deepseek-v4-pro':{input:9,cache:0.3,output:27,context:1048576},
 'deepseek-v4-flash':{input:2,cache:0.04,output:8,context:1048576},
 'deepseek-v4-flash-vision-exp':{input:2,cache:0.04,output:8,context:1048576},
};
export function yuan(value,nullable=false){
 if(nullable&&(value===null||value===''))return null;
 const n=Number(value);
 if(!Number.isFinite(n)||n<0||n>1000000)throw new Error('金额须为 0 至 1000000 元');
 return Math.round(n*SCALE);
}
export function periods(ms){const s=new Date(ms+8*3600000).toISOString();return {month:s.slice(0,7),day:s.slice(0,10)};}
export function tokenCost(u,p){return Math.ceil(u.input*p.input*1000+u.cache*p.cache*1000+u.output*p.output*1000);}
export function normalizeUsage(raw,protocol){
 if(!raw||typeof raw!=='object')return null;
 const count=(v)=>Number.isSafeInteger(v)&&v>=0?v:null;
 let input,cache,output;
 if(protocol==='messages'){
  input=count(raw.input_tokens);cache=count(raw.cache_read_input_tokens??0);output=count(raw.output_tokens);
  const write=count(raw.cache_creation_input_tokens??0);if(write===null)return null;if(input!==null)input+=write;
 }else if(protocol==='responses'){
  input=count(raw.input_tokens);cache=count(raw.input_tokens_details?.cached_tokens??0);output=count(raw.output_tokens);
  if(input!==null&&cache!==null)input-=cache;
 }else{
  input=count(raw.prompt_tokens);cache=count(raw.prompt_cache_hit_tokens??raw.prompt_tokens_details?.cached_tokens??0);output=count(raw.completion_tokens);
  if(input!==null&&cache!==null)input-=cache;
 }
 if(input===null||cache===null||output===null||input<0)return null;
 return {input,cache,output,total:input+cache+output};
}
function containsImage(value){
 if(!value||typeof value!=='object')return false;
 if(['image','image_url','input_image','file','input_file','document'].includes(value.type))return true;
 return Object.values(value).some(v=>Array.isArray(v)?v.some(containsImage):containsImage(v));
}
export function prepare(body,kind,key){
 if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('请求须为 JSON 对象');
 if(kind==='search'||kind==='fetch')return {body,reserve:5000000,model:`deepseek-${kind}`,protocol:kind,price:null};
 const model=body.model,price=PRICES[model];
 if(body.n!==undefined&&body.n!==1)throw new Error('每次请求只允许生成一个回答');
 if(!price)throw new Error('该模型尚未配置计价，无法调用');
 if(!key.models.includes(model))throw Object.assign(new Error('此密钥无权使用该模型'),{status:403,code:'model_not_allowed'});
 if(body.previous_response_id)throw new Error('暂不支持服务端历史引用，请显式发送上下文');
 if(body.tools!==undefined&&!Array.isArray(body.tools))throw new Error('工具列表格式无效');
 const serverTools=body.tools?.some(t=>!t||!(['function','custom'].includes(t.type)||(t.type===undefined&&typeof t.name==='string'&&t.input_schema)));
 if(serverTools)throw new Error('请使用客户端工具或独立 Search/Fetch 接口；暂不开放模型内置联网工具');
 let requested=kind==='responses'?body.max_output_tokens:body.max_completion_tokens??body.max_tokens;
 if(requested!==undefined&&(!Number.isSafeInteger(requested)||requested<=0))throw new Error('输出 Token 上限须为正整数');
 const max=Math.min(requested??key.maxOutputTokens,key.maxOutputTokens);
 const outgoing={...body};
 if(kind==='chat'&&Array.isArray(body.messages))outgoing.messages=body.messages.map(m=>m?.role==='developer'?{...m,role:'system'}:m);
 delete outgoing.max_completion_tokens;
 if(kind==='responses')outgoing.max_output_tokens=max;else outgoing.max_tokens=max;
 if(kind==='chat'&&body.stream)outgoing.stream_options={...body.stream_options,include_usage:true};
 const bytes=Buffer.byteLength(JSON.stringify(outgoing));
 const input=containsImage(outgoing)?price.context:Math.min(bytes+1024,price.context);
 // UTF-8 byte length plus framing is a conservative text-token bound; images reserve the full context.
 const reserve=tokenCost({input,cache:0,output:max},price);
 return {body:outgoing,reserve,model,protocol:kind==='chat'?'chat':kind,price};
}
export class UsageParser{
 constructor(protocol){this.protocol=protocol;this.raw={};this.buffer='';this.decoder=new TextDecoder();this.seen=false;}
 object(obj){
  let raw;
  if(this.protocol==='messages')raw=obj.type==='message_start'?obj.message?.usage:obj.usage;
  else if(this.protocol==='responses')raw=obj.response?.usage??obj.usage;
  else raw=obj.usage;
  if(raw&&typeof raw==='object'){Object.assign(this.raw,raw);this.seen=true;}
 }
 chunk(bytes){this.buffer+=this.decoder.decode(bytes,{stream:true});this.consume();}
 consume(){
  let match;
  while((match=/\r?\n\r?\n/.exec(this.buffer))){
   const event=this.buffer.slice(0,match.index);this.buffer=this.buffer.slice(match.index+match[0].length);
   const data=event.split(/\r?\n/).filter(s=>s.startsWith('data:')).map(s=>s.slice(5).trimStart()).join('\n');
   if(data&&data!=='[DONE]'){try{this.object(JSON.parse(data));}catch{/* A malformed frame cannot establish usage; keep the reservation if no valid receipt arrives. */}}
  }
 }
 end(){this.buffer+=this.decoder.decode();if(this.buffer.trim())this.buffer+='\n\n';this.consume();return this.seen?normalizeUsage(this.raw,this.protocol):null;}
}
