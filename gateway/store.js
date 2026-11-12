import {DatabaseSync} from 'node:sqlite';
import {createHash,randomBytes,randomUUID,createCipheriv,createDecipheriv} from 'node:crypto';
import {periods,yuan,SCALE,PRICES} from './pricing.js';
const digest=s=>createHash('sha256').update(s).digest('hex');
const json=v=>JSON.stringify(v);
export class GateError extends Error{constructor(message,status=400,code='invalid_request'){super(message);this.status=status;this.code=code;}}
const text=(v,label)=>{if(typeof v!=='string'||!v.trim()||v.length>100)throw new GateError(`${label}须为 1 至 100 字符`);return v.trim();};
function integer(v,label,min,max){if(!Number.isSafeInteger(v)||v<min||v>max)throw new GateError(`${label}须为 ${min} 至 ${max} 的整数`);return v;}
export class Store{
 constructor(path,encryptionKey,now=Date.now){
  if(!Buffer.isBuffer(encryptionKey)||encryptionKey.length!==32)throw new Error('Encryption key must contain 32 bytes');
  this.cryptoKey=encryptionKey;this.now=now;this.db=new DatabaseSync(path);
  this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS upstreams(id TEXT PRIMARY KEY,name TEXT NOT NULL,encrypted TEXT NOT NULL,last4 TEXT NOT NULL,models TEXT NOT NULL,monthly_budget INTEGER,enabled INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS keys(id TEXT PRIMARY KEY,name TEXT NOT NULL,upstream_id TEXT NOT NULL REFERENCES upstreams(id),hash TEXT UNIQUE NOT NULL,prefix TEXT NOT NULL,policy TEXT NOT NULL,created INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,key_id TEXT NOT NULL REFERENCES keys(id),upstream_id TEXT NOT NULL,model TEXT NOT NULL,month TEXT NOT NULL,day TEXT NOT NULL,created INTEGER NOT NULL,status TEXT NOT NULL,reserve INTEGER NOT NULL,cost INTEGER,usage TEXT,detail TEXT);
   CREATE INDEX IF NOT EXISTS req_key_month ON requests(key_id,month);
   CREATE INDEX IF NOT EXISTS req_upstream_month ON requests(upstream_id,month);
   CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY,key_id TEXT NOT NULL,month TEXT NOT NULL,kind TEXT NOT NULL,message TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(key_id,month,kind));`);
  this.db.prepare("UPDATE requests SET status='uncertain',detail='服务重启，预留费用待核对' WHERE status='pending'").run();
 }
 close(){this.db.close();}
 encrypt(value){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.cryptoKey,iv);return json({iv:iv.toString('base64'),data:Buffer.concat([c.update(value,'utf8'),c.final()]).toString('base64'),tag:c.getAuthTag().toString('base64')});}
 decrypt(value){const e=JSON.parse(value),d=createDecipheriv('aes-256-gcm',this.cryptoKey,Buffer.from(e.iv,'base64'));d.setAuthTag(Buffer.from(e.tag,'base64'));return Buffer.concat([d.update(Buffer.from(e.data,'base64')),d.final()]).toString('utf8');}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 upstream(id){const row=this.db.prepare('SELECT * FROM upstreams WHERE id=?').get(id);if(!row)throw new GateError('找不到官方密钥配置',404);return row;}
 saveUpstream(raw,models,id){
  const name=text(raw.name,'名称'),budget=yuan(raw.monthlyBudget??null,true);
  const prior=id?this.upstream(id):null;
  if(prior&&!prior.enabled)throw new GateError('此官方密钥已删除',404);
  const key=raw.apiKey?.trim();
  if(!prior&&!key)throw new GateError('请填写 DeepSeek 官方 API 密钥');
  if(key&&(!/^[\x21-\x7e]{16,512}$/.test(key)))throw new GateError('官方密钥格式无效');
  const uid=id??randomUUID();
  this.db.prepare(`INSERT INTO upstreams(id,name,encrypted,last4,models,monthly_budget,created) VALUES(?,?,?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET name=excluded.name,encrypted=excluded.encrypted,last4=excluded.last4,models=excluded.models,monthly_budget=excluded.monthly_budget`).run(uid,name,key?this.encrypt(key):prior.encrypted,key?key.slice(-4):prior.last4,json(models),budget,this.now());
  return this.upstreamView(this.upstream(uid));
 }
 upstreamView(row){const s=this.totals('upstream_id',row.id);return {id:row.id,name:row.name,last4:row.last4,models:JSON.parse(row.models),monthlyBudget:row.monthly_budget===null?null:row.monthly_budget/SCALE,spent:s.spent/SCALE,held:s.held/SCALE,enabled:!!row.enabled};}
 deleteUpstream(id){
  return this.transaction(()=>{
   const u=this.upstream(id);
   if(!u.enabled)throw new GateError('此官方密钥已删除',404);
   const keys=this.db.prepare('SELECT id,policy FROM keys WHERE upstream_id=?').all(id);
   for(const k of keys)this.db.prepare('UPDATE keys SET policy=? WHERE id=?').run(json({...JSON.parse(k.policy),enabled:false}),k.id);
   this.db.prepare("UPDATE upstreams SET encrypted='',last4='',models='[]',enabled=0 WHERE id=?").run(id);
   return {ok:true,disabledKeys:keys.length};
  });
 }
 policy(raw){
  const models=raw.models;
  if(!Array.isArray(models)||models.length===0||models.some(m=>!Object.hasOwn(PRICES,m)))throw new GateError('至少选择一个已配置计价的 DeepSeek 模型');
  if(typeof raw.enabled!=='boolean')throw new GateError('密钥启用状态无效');
  return {monthlyBudget:yuan(raw.monthlyBudget),dailyBudget:yuan(raw.dailyBudget??null,true),warnPercent:integer(raw.warnPercent??80,'提醒百分比',1,100),rpm:integer(raw.rpm??60,'每分钟请求数',1,1000),parallel:integer(raw.parallel??3,'并发数',1,30),maxOutputTokens:integer(raw.maxOutputTokens??8192,'输出上限',1,131072),models:[...new Set(models)],enabled:raw.enabled,webTools:raw.webTools===true};
 }
 key(id){const row=this.db.prepare('SELECT * FROM keys WHERE id=?').get(id);if(!row)throw new GateError('找不到成员密钥',404);return {...row,policy:JSON.parse(row.policy)};}
 createKey(raw){
  const name=text(raw.name,'成员名称'),u=this.upstream(raw.upstreamId),policy=this.policy({...raw,enabled:raw.enabled??true});
  if(!u.enabled)throw new GateError('此官方密钥已删除，请选择其他官方密钥');
  if(policy.models.some(m=>!JSON.parse(u.models).includes(m)))throw new GateError('所选模型不在官方密钥的可用模型列表中');
  const secret='sk-team-'+randomBytes(30).toString('base64url'),id=randomUUID();
  this.db.prepare('INSERT INTO keys(id,name,upstream_id,hash,prefix,policy,created) VALUES(?,?,?,?,?,?,?)').run(id,name,u.id,digest(secret),secret.slice(0,16),json(policy),this.now());
  return {key:this.keyView(this.key(id)),secret};
 }
 updateKey(id,raw){
  if(this.key(id).policy.deleted)throw new GateError('此成员密钥已删除',404);
  const old=this.key(id),policy=this.policy({...old.policy,monthlyBudget:old.policy.monthlyBudget/SCALE,dailyBudget:old.policy.dailyBudget===null?null:old.policy.dailyBudget/SCALE,...raw});
  const u=this.upstream(old.upstream_id);
  if(policy.enabled&&!u.enabled)throw new GateError('对应的官方密钥已删除，无法恢复此成员密钥');
  if(u.enabled&&policy.models.some(m=>!JSON.parse(u.models).includes(m)))throw new GateError('所选模型不在官方密钥的可用模型列表中');
  this.db.prepare('UPDATE keys SET name=?,policy=? WHERE id=?').run(text(raw.name??old.name,'成员名称'),json(policy),id);return this.keyView(this.key(id));
 }
 deleteKey(id){return this.transaction(()=>{const k=this.key(id);if(k.policy.deleted)throw new GateError('此成员密钥已删除',404);this.db.prepare('UPDATE keys SET hash=?,policy=? WHERE id=?').run(digest(randomBytes(32)),json({...k.policy,enabled:false,deleted:true}),id);return {ok:true};});}
 rotate(id){if(this.key(id).policy.deleted)throw new GateError('此成员密钥已删除',404);const secret='sk-team-'+randomBytes(30).toString('base64url');this.db.prepare('UPDATE keys SET hash=?,prefix=? WHERE id=?').run(digest(secret),secret.slice(0,16),id);return {secret,key:this.keyView(this.key(id))};}
 authenticate(secret){if(typeof secret!=='string'||secret.length>512)throw new GateError('成员密钥无效',401,'invalid_api_key');const row=this.db.prepare('SELECT id FROM keys WHERE hash=?').get(digest(secret));if(!row)throw new GateError('成员密钥无效',401,'invalid_api_key');return this.key(row.id);}
 totals(column,id,period='month',stamp=periods(this.now())[period]){
  if(!['key_id','upstream_id'].includes(column)||!['month','day'].includes(period))throw new Error('Invalid query');
  const row=this.db.prepare(`SELECT COALESCE(SUM(cost),0) spent,COALESCE(SUM(CASE WHEN status IN ('pending','uncertain') THEN reserve ELSE 0 END),0) held,COUNT(*) requests FROM requests WHERE ${column}=? AND ${period}=?`).get(id,stamp);return row;
 }
 keyView(row){const month=this.totals('key_id',row.id),day=this.totals('key_id',row.id,'day');const p=row.policy;return {id:row.id,name:row.name,upstreamId:row.upstream_id,prefix:row.prefix+'…',...p,monthlyBudget:p.monthlyBudget/SCALE,dailyBudget:p.dailyBudget===null?null:p.dailyBudget/SCALE,spent:month.spent/SCALE,held:month.held/SCALE,todaySpent:day.spent/SCALE,requests:month.requests,remaining:Math.max(0,p.monthlyBudget-month.spent-month.held)/SCALE};}
 alert(key,kind,message){this.db.prepare('INSERT OR IGNORE INTO alerts(id,key_id,month,kind,message,created) VALUES(?,?,?,?,?,?)').run(randomUUID(),key.id,periods(this.now()).month,kind,message,this.now());}
 reserve(key,prepared){
  try{return this.transaction(()=>{
   const fresh=this.key(key.id),p=fresh.policy,u=this.upstream(fresh.upstream_id),now=this.now(),stamp=periods(now);
   if(!p.enabled||!u.enabled)throw new GateError('此成员密钥已停用',403,'key_disabled');
   if(prepared.protocol==='search'||prepared.protocol==='fetch'){if(!p.webTools)throw new GateError('此密钥未开放联网搜索与抓取',403,'tool_not_allowed');}
   else if(!p.models.includes(prepared.model))throw new GateError('此密钥无权调用该模型',403,'model_not_allowed');
   const m=this.totals('key_id',key.id),d=this.totals('key_id',key.id,'day'),parent=this.totals('upstream_id',u.id);
   if(m.spent+m.held+prepared.reserve>p.monthlyBudget)throw new GateError('本月剩余预算不足以预留本次请求；已停止调用',402,'monthly_budget_exceeded');
   if(p.dailyBudget!==null&&d.spent+d.held+prepared.reserve>p.dailyBudget)throw new GateError('今日剩余预算不足以预留本次请求',402,'daily_budget_exceeded');
   if(u.monthly_budget!==null&&parent.spent+parent.held+prepared.reserve>u.monthly_budget)throw new GateError('官方密钥对应的团队总预算不足',402,'upstream_budget_exceeded');
   const concurrent=this.db.prepare("SELECT count(*) n FROM requests WHERE key_id=? AND status='pending'").get(key.id).n;
   if(concurrent>=p.parallel)throw new GateError('同时调用数已达上限，请稍后再试',429,'concurrency_limit');
   if(this.db.prepare('SELECT count(*) n FROM requests WHERE key_id=? AND created>?').get(key.id,now-60000).n>=p.rpm)throw new GateError('每分钟调用次数已达上限',429,'rate_limit');
   const id=randomUUID();this.db.prepare('INSERT INTO requests(id,key_id,upstream_id,model,month,day,created,status,reserve) VALUES(?,?,?,?,?,?,?,?,?)').run(id,key.id,u.id,prepared.model,stamp.month,stamp.day,now,'pending',prepared.reserve);
   return {id,keyId:key.id,upstreamId:u.id,reserve:prepared.reserve,upstreamKey:this.decrypt(u.encrypted),warning:(m.spent+m.held)/Math.max(p.monthlyBudget,1)*100>=p.warnPercent};
  });}catch(e){if(e.code?.includes('budget'))this.alert(key,e.code,`${key.name}：${e.message}`);throw e;}
 }
 settle(id,cost,usage,status,detail=''){
  this.transaction(()=>{
   const row=this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);if(!row||row.status!=='pending')throw new Error('Request already settled');
   if(cost!==null&&(!Number.isSafeInteger(cost)||cost<0))throw new Error('Invalid cost');
   this.db.prepare('UPDATE requests SET cost=?,usage=?,status=?,detail=? WHERE id=?').run(cost,usage?json(usage):null,status,detail,id);
   const key=this.key(row.key_id),totals=this.totals('key_id',key.id),p=key.policy;
   if(totals.spent+totals.held>=p.monthlyBudget)this.alert(key,'budget_reached',`${key.name}：本月预算已用完，后续请求停止`);
   else if((totals.spent+totals.held)*100>=p.monthlyBudget*p.warnPercent)this.alert(key,'budget_warning',`${key.name}：本月预算使用已达到 ${p.warnPercent}%`);
   if(status==='uncertain')this.alert(key,'usage_uncertain',`${key.name}：有请求未返回完整用量，已保留预算等待核对`);
   if(cost!==null&&cost>row.reserve){this.db.prepare('UPDATE keys SET policy=? WHERE id=?').run(json({...p,enabled:false}),key.id);this.alert(key,'pricing_overrun',`${key.name}：实际计费超出预留，已停用，请检查计价`);}
  });
 }
 reconcile(id,amount){
  const cost=yuan(amount);const row=this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);if(!row||row.status!=='uncertain')throw new GateError('只能核对待确认的请求');
  this.db.prepare("UPDATE requests SET cost=?,status='reconciled',detail='管理员已核对' WHERE id=?").run(cost,id);return {ok:true};
 }
 analytics(){
  const stamp=periods(this.now()),start=periods(this.now()-29*86400000).day;
  const daily=this.db.prepare("SELECT day,COUNT(*) requests,COALESCE(SUM(cost),0) cost,COALESCE(SUM(json_extract(usage,'$.total')),0) tokens,SUM(CASE WHEN status IN ('pending','uncertain') THEN 1 ELSE 0 END) unconfirmed FROM requests WHERE day>=? GROUP BY day ORDER BY day").all(start).map(r=>({...r,cost:r.cost/SCALE}));
  const month=this.db.prepare("SELECT COALESCE(SUM(json_extract(usage,'$.total')),0) tokens,COUNT(*) requests FROM requests WHERE month=?").get(stamp.month);
  return {today:stamp.day,daily,month};
 }
 state(){return {analytics:this.analytics(),month:periods(this.now()).month,currency:'CNY',pricing:'beijing-schedule-estimate',priceDate:'2026-11-11',priceSource:'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',models:Object.keys(PRICES),upstreams:this.db.prepare('SELECT * FROM upstreams WHERE enabled=1 ORDER BY created').all().map(r=>this.upstreamView(r)),keys:this.db.prepare('SELECT id FROM keys ORDER BY created').all().map(r=>this.keyView(this.key(r.id))).filter(k=>!k.deleted),archivedKeys:this.db.prepare('SELECT id FROM keys ORDER BY created').all().map(r=>this.keyView(this.key(r.id))).filter(k=>k.deleted),alerts:this.db.prepare('SELECT * FROM alerts ORDER BY created DESC LIMIT 30').all(),recent:this.db.prepare('SELECT id,key_id,model,created,status,reserve,cost,usage,detail FROM requests ORDER BY created DESC LIMIT 60').all().map(r=>({...r,reserve:r.reserve/SCALE,cost:r.cost===null?null:r.cost/SCALE,usage:r.usage?JSON.parse(r.usage):null}))};}
}
