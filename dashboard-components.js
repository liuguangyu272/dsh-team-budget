// Included in client.js by the local UI build script; no extra runtime requests.
function Glyph({name,size=16}){
 const paths={wallet:'M3 6h17v14H3z M3 6l13-3v3 M15 12h6v4h-6z',clock:'M12 8v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',chart:'M4 20V4 M4 20h17 M8 16v-4 M13 16V7 M18 16v-7',key:'M14 7a5 5 0 1 1-4-4 M10 11l10 10 M16 17l3-3',shield:'M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z M8 12l3 3 5-6',refresh:'M20 8a8 8 0 1 0 0 8 M20 3v5h-5',calendar:'M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16',arrow:'M5 12h14 M14 7l5 5-5 5',alert:'M12 3l10 18H2z M12 9v5 M12 17v1',users:'M16 21v-3c0-3-8-3-8 0v3 M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M19 12c3 0 3 3 3 5 M18 4c3 1 3 5 0 6'};
 return h('svg',{viewBox:'0 0 24 24',width:size,height:size,fill:'none',stroke:'currentColor',strokeWidth:1.6,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true},h('path',{d:paths[name]??paths.chart}));
}
function EmptyState({icon='chart',title,note,action}){return h('div',{className:'dkg-empty'},h('div',{className:'dkg-empty-icon'},h(Glyph,{name:icon,size:21})),h('strong',null,title),note?h('small',null,note):null,action);}
function Overview({data,keys,t,setTab,range,setRange,selected,setSelected}){
 const daily=data.analytics?.daily??[],today=data.analytics?.today??data.month+'-01';
 const days=Array.from({length:range},(_,i)=>{const day=new Date(Date.parse(today+'T12:00:00+08:00')-(range-1-i)*86400000).toISOString().slice(0,10);return {day,cost:0,requests:0,tokens:0,unconfirmed:0,...daily.find(d=>d.day===day)};});
 const picked=days.find(d=>d.day===selected)??days.at(-1),sum=days.reduce((a,d)=>a+d.cost,0),has=days.some(d=>d.requests>0),peak=Math.max(...days.map(d=>d.cost),0.000001),active=data.keys.filter(k=>k.enabled),budget=active.reduce((s,k)=>s+k.monthlyBudget,0),used=active.reduce((s,k)=>s+k.spent+k.held,0),percent=budget?Math.min(100,used/budget*100):0;
 const ranking=[...keys].filter(k=>k.spent>0).sort((a,b)=>b.spent-a.spent).slice(0,5),maxMember=Math.max(...ranking.map(k=>k.spent),0.000001);
 const chartWidth=600,step=550/range,baseline=140;
 const chart=h('svg',{className:'dkg-chart',viewBox:'0 0 600 175',preserveAspectRatio:'none',role:'img','aria-label':t('trendChart')},
  ...[0,.5,1].map((n,i)=>h('g',{key:'grid'+i},h('line',{x1:44,x2:596,y1:baseline-n*120,y2:baseline-n*120}),has?h('text',{x:0,y:baseline-n*120+3},money(peak*n)):null)),
  ...days.map((d,i)=>{const x=46+i*step+step*.16,width=step*.68,height=d.cost/peak*120,label=d.day.slice(5).replace('-','/'),a=()=>setSelected(d.day);return h('g',{key:d.day},h('rect',{className:'dkg-bar',x,y:baseline-height,width,height:Math.max(height,0),rx:Math.min(width/4,4),tabIndex:height?0:undefined,role:height?'button':undefined,'aria-label':d.day+' '+money(d.cost)+' '+d.requests+' '+t('requests'),onMouseEnter:a,onFocus:a,onClick:a,onKeyDown:e=>{if(e.key==='Enter'||e.key===' ')a();}},h('title',null,d.day+' · '+money(d.cost)+' · '+d.requests+' '+t('requests'))),(range===7||i%5===0||i===range-1)?h('text',{x:x+width/2,y:163,textAnchor:'middle'},label):null);}),
  !has?h('text',{x:320,y:85,textAnchor:'middle'},t('noTrend')):null);
 return h(React.Fragment,null,
  h('div',{className:'dkg-dashboard-grid'},
   h('section',{className:'dkg-card'},h('div',{className:'dkg-section-head'},h('div',null,h('h2',null,t('trendTitle'))),h('div',{className:'dkg-toggle'},...[7,30].map(n=>h('button',{key:n,type:'button','aria-pressed':range===n,onClick:()=>setRange(n)},n+' '+t('days'))))),
    h('div',{className:'dkg-chart-summary'},h('strong',null,money(sum))),chart,
    h('div',{className:'dkg-chart-footer'},h('span',null,h('i',{className:'dkg-legend-dot'}),t('cost')),h('span',{'aria-live':'polite'},picked.day.slice(5).replace('-','/')+' · '+money(picked.cost)+' · '+picked.requests+' '+t('calls')))),
   h('section',{className:'dkg-card'},h('div',{className:'dkg-section-head'},h('div',null,h('h2',null,t('budgetTitle'))),h(Glyph,{name:'shield'})),
    h('div',{className:'dkg-budget-visual'},h('div',{className:'dkg-ring',style:{background:`conic-gradient(${percent>=80?'var(--amber)':'var(--accent-fill)'} ${percent*3.6}deg,var(--wash) 0)`},role:'img','aria-label':t('budgetTitle')+' '+(budget?percent.toFixed(1)+'%':t('noActiveBudget'))},h('div',{className:'dkg-ring-inner'},h('strong',null,budget?percent.toFixed(1)+'%':'—'),h('small',null,budget?t('budgetUsed'):t('noActiveBudget'))))),
    h('div',{className:'dkg-budget-legend'},h('div',null,h('span',null,t('activeBudget')),h('b',null,money(budget))),h('div',null,h('span',null,t('usedAndHeld')),h('b',null,money(used))),h('div',null,h('span',null,t('remaining')),h('b',null,money(Math.max(0,budget-used))))))),
  h('div',{className:'dkg-dashboard-grid dkg-dashboard-lower'},
   h('section',{className:'dkg-card'},h('div',{className:'dkg-section-head'},h('div',null,h('h2',null,t('memberRanking'))),h('button',{type:'button',onClick:()=>setTab('keys')},t('manageMembers'),h(Glyph,{name:'arrow',size:13}))),
    ranking.length?h('ol',{className:'dkg-ranking'},...ranking.map((k,i)=>h('li',{key:k.id},h('span',{className:'dkg-rank'},String(i+1).padStart(2,'0')),h('div',null,h('strong',null,k.name),k.deleted?h('small',null,t('deletedMember')):null,h('div',{className:'dkg-progress'},h('i',{style:{width:k.spent/maxMember*100+'%'}}))),h('b',null,money(k.spent))))):h(EmptyState,{icon:'users',title:t('noMemberSpend')})),
   h('section',{className:'dkg-card'},h('div',{className:'dkg-section-head'},h('div',null,h('h2',null,t('alerts'))),h('span',{className:'dkg-tab-count'},data.alerts.length)),
    data.alerts.length?data.alerts.slice(0,3).map(a=>h('div',{className:'dkg-alert-item',key:a.id},h('span',{className:'dkg-alert-icon'},h(Glyph,{name:'alert',size:15})),h('div',null,h('p',null,a.message),h('small',null,new Date(a.created).toLocaleString())))):h(EmptyState,{icon:'shield',title:t('noAlerts')}))));
}
