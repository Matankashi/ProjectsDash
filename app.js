/* Projects app: the dashboard.
   Views, events, toBlocks and the timer are the claude.ai artifact's code. What changed is where the
   data lives: each project is a Firestore document (firebase.js) instead of JSON inside the page,
   and the calendar is read from Google Calendar directly (calendar.js) instead of through claude.ai.
   Since v1.2 there can be several projects. The artifact's views draw "the current project": use(id)
   points `state` and cal.blocks at one project before its views run, and every event handler first
   calls use() for the project its element belongs to (the nearest [data-p]). */
import {watchAuth,signIn,signOutUser,watchProjects,openProject,openBlocks,openSub,SERVER_NOW} from './firebase.js';
import * as gcal from './calendar.js';

const LS_TIMER='madrid-dash-timer';
/* The calendar window comes from each active project's own dates: CAL_LEAD_DAYS before the earliest
   one, through CAL_TRAIL_DAYS after decision.date (or the latest date if there's no decision), and
   always reaching at least a week past today. All active projects share one request. For the Madrid
   project that is exactly the artifact's old fixed window, 2026-09-20 to 2026-11-16. */
const CAL_LEAD_DAYS=10,CAL_TRAIL_DAYS=2;
const MAX_ACTIVE=3;          // active projects at once; the rest are paused
const STATUS={active:'פעיל',waiting:'ממתין',habit:'הרגל',stuck:'תקוע',done:'הושלם'};
const DAYS=['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳'];
const app=document.getElementById('app');

const projects={};           // id -> {id, state, sync, blocks, gates, syncs, snap, over}; state and blocks are null until their first snapshot
let listed=null;             // project ids in the list, null until the list arrives
let state=null;              // the current project's state (see use())
let cur=null;                // the current project's id
let blocks={};               // the current project's block documents, by calendar event id (v1.3)
let gates={};                // the current project's gate documents, by gate id (v1.3)
let route={name:'home'};     // #/ is home, #/p/<id> is one project
let view='auth',viewMsg='';  // what render() shows until every listed project has arrived

let ui={open:{},stuck:false,warn:null,showLog:false,exp:false,warnP:null,
  editP:null,editSc:null,editMs:null,editLink:null,keyDraft:null,keyConfirm:null,confirmDel:null,  // editing (v1.2)
  run:null,ask:null,editPlan:false,gate:null,gateWarn:null};  // the open block {p,e}, the status being asked about {k,st,w}, its plan form (v1.3)

let saveText='';

/* helpers */
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const today=()=>{const d=new Date();d.setHours(0,0,0,0);return d;};
const parse=s=>{const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d);};
const iso=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
const daysUntil=s=>Math.round((parse(s)-today())/86400000);
const fmt=s=>{const d=parse(s);return d.getDate()+'.'+(d.getMonth()+1);};
const rel=n=>n<-1?`באיחור ${-n} ימים`:n===-1?'באיחור יום':n===0?'היום':n===1?'מחר':`עוד ${n} ימים`;
const urg=n=>n<=3?'red':n<=7?'saffron':'calm';
const uid=()=>Math.random().toString(36).slice(2,9);
const S=id=>state.streams.find(s=>s.id===id);
const byDate=(a,b)=>(a.date||'9999')<(b.date||'9999')?-1:(a.date||'9999')>(b.date||'9999')?1:0;
const hm=d=>String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
function dayLabel(d){const x=new Date(d);x.setHours(0,0,0,0);const n=Math.round((x-today())/86400000);const base=`${DAYS[d.getDay()]} ${d.getDate()}.${d.getMonth()+1}`;return n===0?'היום':n===1?'מחר':n===-1?'אתמול':'יום '+base;}
const whenLabel=b=>dayLabel(b.start)+', '+hm(b.start);
const mins=b=>Math.round((b.end-b.start)/60000);
const weekStart=()=>{const d=today();d.setDate(d.getDate()-d.getDay());return d;};
function stripHtml(h){try{const d=new DOMParser().parseFromString(h||'','text/html');return (d.body.textContent||'').trim();}catch(e){return '';}}
function setStatus(t){saveText=t;const el=document.getElementById('save');if(el)el.textContent=t;}

/* calendar */
const CAL_MSG={
  disconnected:'לחץ "חבר יומן" כדי לטעון את הבלוקים מ־Google Calendar.',
  expired:'החיבור ל־Google Calendar פג (הוא תקף כשעה). לחץ "חבר מחדש".',
  denied:'אין הרשאה לקרוא את היומן. לחץ "חבר יומן" ואשר גישה ליומן במסך של Google.',
  network:'לא הצלחתי להגיע ליומן. בדוק את החיבור ולחץ "רענן".',
  not_configured:'Google Calendar API לא מופעל בפרויקט ב־Google Cloud.',
  popup_closed:'החלון של Google נסגר לפני שהחיבור הושלם.',
  popup_blocked:'הדפדפן חסם את החלון של Google. אפשר חלונות קופצים לאתר הזה ונסה שוב.',
  gis_loading:'ההתחברות של Google עדיין נטענת. נסה שוב בעוד רגע.',
  gis_failed:'לא הצלחתי לטעון את ההתחברות של Google. בדוק את החיבור ונסה שוב.'
};
const CAL_TITLE={disconnected:'היומן לא מחובר',expired:'החיבור ליומן פג',denied:'אין הרשאה לקרוא את היומן',network:'היומן לא זמין כרגע'};
let cal={status:'disconnected',items:[],blocks:[],msg:CAL_MSG.disconnected,storedAt:0};  // items: every event fetched; blocks: the current project's
let calBusy=false;
/* A project's blocks are the events whose title contains its calendarKey ("מדריד — סאבלט: ...");
   the key and the dash after it are dropped from the title. No key, no blocks. */
const reEsc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function toBlocks(payload,draftKey){
  const p=payload,key=String((draftKey===undefined?state.project.calendarKey:draftKey)||'').trim();
  const evs=(p&&Array.isArray(p.items))?p.items:[];
  if(!key)return [];
  const strip=new RegExp('^.*?'+reEsc(key)+'\\s*[—–:\\-]\\s*');
  return evs.filter(e=>e&&e.status!=='cancelled'&&e.start&&e.start.dateTime&&e.end&&(e.summary||'').includes(key)).map(e=>{
    const sum=e.summary||'';
    const title=sum.replace(strip,'').trim()||sum;
    const streams=state.streams.filter(s=>(s.match||[]).some(k=>sum.toLowerCase().includes(k.toLowerCase()))).map(s=>s.id);
    return {id:e.id,title,desc:stripHtml(e.description),start:new Date(e.start.dateTime),end:new Date(e.end.dateTime),link:e.htmlLink||'',streams};
  }).sort((a,b)=>a.start-b.start);
}
function projectRange(){
  const P=state.project,dates=[P.flight,P.buffer&&P.buffer.from,P.buffer&&P.buffer.to,P.decision&&P.decision.date];
  state.streams.forEach(s=>s.milestones.forEach(m=>dates.push(m.date)));
  const ds=dates.filter(Boolean).sort();
  return {from:ds.length?parse(ds[0]):today(),to:parse((P.decision&&P.decision.date)||ds[ds.length-1]||iso(today()))};
}
function calRange(){
  const t=today(),wk=today();wk.setDate(wk.getDate()+7);
  let from=null,to=wk;
  const keep=cur;activeIds().forEach(id=>{use(id);const r=projectRange();if(!from||r.from<from)from=r.from;if(r.to>to)to=r.to;});if(keep&&projects[keep])use(keep);
  from=new Date(from||t);to=new Date(to);
  from.setDate(from.getDate()-CAL_LEAD_DAYS);to.setDate(to.getDate()+CAL_TRAIL_DAYS);
  return {timeMin:from.toISOString(),timeMax:to.toISOString()};
}
function calButton(cls){
  const s=cal.status,act=s==='disconnected'||s==='denied'||s==='expired'?'cal-connect':'refresh';
  return `<button class="${cls}" data-act="${act}">${s==='expired'?'חבר מחדש':act==='cal-connect'?'חבר יומן':'רענן'}</button>`;
}
function calFail(err){
  const k=(err&&err.kind)||(cal.status==='loading'?'network':cal.status);
  cal=Object.assign({},cal,{status:k,msg:CAL_MSG[err&&err.detail]||CAL_MSG[k]||''});
  render();
}
function connectCalendar(){
  let p;
  try{p=gcal.connect({consent:cal.status==='denied'});}  // synchronously inside the click, or the browser blocks Google's popup
  catch(err){console.error('projects-app: calendar connect failed',err);calFail(err);return;}
  p.then(refreshCalendar,err=>{console.error('projects-app: calendar connect failed',err);calFail(err);});
}
async function refreshCalendar(){
  if(calBusy)return;
  const t=gcal.tokenState();
  if(t!=='valid'){calFail({kind:t==='expired'?'expired':'disconnected'});return;}
  calBusy=true;
  if(!cal.items.length){cal=Object.assign({},cal,{status:'loading'});render();}
  try{const r=calRange(),items=await gcal.listEvents(r);cal={status:'ok',items,blocks:[],msg:'',storedAt:Date.now(),range:{from:iso(new Date(r.timeMin)),to:iso(new Date(r.timeMax))}};fillFacts();render();}
  catch(err){console.error('projects-app: calendar refresh failed',err);calFail(err);}
  finally{calBusy=false;}
}
function startCalendar(){
  gcal.init().catch(err=>console.error('projects-app: Google Identity Services did not load',err));
  gcal.onExpire(()=>{if(cal.status==='ok'||cal.status==='network'){cal=Object.assign({},cal,{status:'expired',msg:CAL_MSG.expired});render();}});
  setInterval(()=>{if(gcal.tokenState()==='valid')refreshCalendar();},600000);
}
/* A block is done only when it was confirmed in the app: blocks/{eventId}.status, never the clock. */
const CONFIRMED=['done','partial','skipped'];
const ST={done:['בוצע','done'],partial:['חלקי','saffron'],skipped:['דילגתי','calm']};   // label, chip color
const blk=id=>blocks[id]||{};
/* A block belongs to every stream its title matches (streamIds). streamId is the v1.3-draft single value. */
const sids=k=>Array.isArray(k.streamIds)?k.streamIds:k.streamId?[k.streamId]:[];
const isDone=b=>blk(b.id).status==='done';
const isConfirmed=b=>CONFIRMED.includes(blk(b.id).status);
const blocksOf=id=>cal.blocks.filter(b=>b.streams.includes(id));
/* Past blocks with no status are waiting for me to say what happened. They are not "behind". */
const awaiting=()=>{const n=Date.now();return cal.blocks.filter(b=>b.end<=n&&!isConfirmed(b));};
/* What a stream's latest confirmed block left behind: its next action, unless that block was done. */
function streamNext(sid){
  if(!sid)return null;
  const day=k=>k.date||k.confirmedOn||'';
  const last=Object.values(blocks).filter(k=>sids(k).includes(sid)&&CONFIRMED.includes(k.status)).sort((a,b)=>day(a)<day(b)?1:day(a)>day(b)?-1:0)[0];
  return last&&last.status!=='done'&&last.nextAction?last:null;
}
/* A confirmed block keeps its record whatever happens to its event. When the event is gone from the
   calendar, or now sits on another day, the record is flagged here: never dropped, never moved.
   Checked only inside the dates the calendar was loaded for. */
function orphans(){
  if(cal.status!=='ok'||!cal.range)return [];
  const ev=new Map(cal.blocks.map(b=>[b.id,b]));
  return Object.entries(blocks).map(([id,k])=>Object.assign({},k,{eventId:id}))
    .filter(k=>CONFIRMED.includes(k.status)&&k.date&&k.date>cal.range.from&&k.date<cal.range.to)
    .filter(k=>{const b=ev.get(k.eventId);return !b||iso(b.start)!==k.date;});
}

/* Gates and RAG (v1.3, step 5).
   A stream's light is about the window of one gate: after the previous gate's day, through the gate's
   own day. Only confirmed blocks are judged: the deficit is the confirmed blocks that weren't done
   (partial or skipped). A past block with no status is "awaiting": shown, never counted against the
   stream. Red: a deficit of 2 or more, or an open external dependency with no alternative. Yellow: 1.
   A confirmed block counts on the day recorded when it was confirmed, in every stream it belongs to,
   whatever happened to its calendar event since. Habits and rag:false streams have no light. */
const RAG={green:['ירוק','ontrack'],yellow:['צהוב','late'],red:['אדום','behind']};
const inRag=s=>s.status!=='habit'&&s.rag!==false;
const counted=s=>s.milestones.filter(m=>m.rag!==false);   // rag:false milestones stay visible and don't count
const gateList=()=>Object.entries(gates).map(([id,g])=>Object.assign({},g,{id})).filter(g=>/^\d{4}-\d{2}-\d{2}$/.test(g.date||'')).sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:(a.order||0)-(b.order||0));
const nextGate=()=>gateList().find(g=>g.date>=iso(today()))||null;
const gateWin=g=>{const all=gateList(),i=all.findIndex(x=>x.id===g.id),from=i>0?all[i-1].date:'';return d=>d>from&&d<=g.date;};
/* A gate can't be passed while blocks in its window are still awaiting: unmarked is never failed, and
   never passable either. Every block of the project counts, with or without a stream. */
const gateWaiting=g=>{const inW=gateWin(g),n=Date.now();return cal.blocks.filter(b=>b.end<=n&&!isConfirmed(b)&&inW(iso(b.start)));};
function ragOf(s,g){
  if(!g||!inRag(s))return null;
  const inW=gateWin(g),n=Date.now();
  const recs=Object.values(blocks).filter(k=>CONFIRMED.includes(k.status)&&k.date&&inW(k.date)&&sids(k).includes(s.id));
  const open=cal.blocks.filter(b=>!isConfirmed(b)&&b.streams.includes(s.id)&&inW(iso(b.start)));
  const done=recs.filter(k=>k.status==='done').length,deficit=recs.length-done,wait=open.filter(b=>b.end<=n).length;
  const dep=s.externalDependency,blocked=!!(dep&&dep.open&&!dep.hasAlternative),planned=recs.length+open.length;
  return {color:blocked||deficit>=2?'red':deficit===1?'yellow':planned?'green':null,planned,confirmed:recs.length,done,deficit,wait,blocked};
}
const ragText=r=>!r.planned&&!r.blocked?'אין בלוקים בחלון':`${r.done} מתוך ${r.planned} בלוקים בוצעו${r.deficit?` · ${r.deficit} לא הושלמו`:''}${r.wait?` · ${r.wait} מחכים לסימון`:''}${r.blocked?' · תלות חיצונית פתוחה בלי חלופה':''}`;
/* A gate's light: the worst of its streams. Gates after the next one have no light yet. */
function gateColor(g){
  const next=nextGate();if(next&&g.date>next.date)return null;
  const cs=state.streams.filter(inRag).map(s=>ragOf(s,g).color);
  return cs.includes('red')?'red':cs.includes('yellow')?'yellow':cs.includes('green')?'green':null;
}
const dot=c=>`<span class="rag-dot ${c||'none'}" role="img" aria-label="${c?RAG[c][0]:'בלי נורית'}"></span>`;

/* projects */
function use(id){const p=projects[id];cur=id;state=p.state;blocks=p.blocks||{};gates=p.gates||{};cal.blocks=state?toBlocks({items:cal.items}):[];}
const loadedIds=()=>(listed||[]).filter(id=>projects[id]&&projects[id].state);
const isPaused=id=>projects[id].state.project.status==='paused';
const activeIds=()=>loadedIds().filter(id=>!isPaused(id));
const pausedIds=()=>loadedIds().filter(isPaused);

/* saving: firebase.js debounces and writes only what changed */
const SAVE_TEXT={saving:'שומר…',saved:'נשמר בענן',offline:'אין חיבור. יישמר כשהרשת תחזור'};
function commit(){const p=projects[cur];render();p.sync.save(p.state);}
function onSaveState(s,err){setStatus(s==='error'?'לא נשמר: '+((err&&err.code)||'שגיאה'):s==='saving'&&!navigator.onLine?SAVE_TEXT.offline:SAVE_TEXT[s]);}
// One status line for all projects: an error wins, then "saving", then "saved".
const saveStates={};
const saveStateOf=id=>(s,err)=>{saveStates[id]={s,err};const all=Object.values(saveStates);const x=all.find(v=>v.s==='error')||all.find(v=>v.s==='saving')||{s:'saved'};onSaveState(x.s,x.err);};
const eachSync=f=>Object.values(projects).forEach(p=>{if(p.sync)f(p.sync);});
window.addEventListener('offline',()=>{if(saveText===SAVE_TEXT.saving)setStatus(SAVE_TEXT.offline);});
window.addEventListener('online',()=>{if(saveText===SAVE_TEXT.offline)setStatus(SAVE_TEXT.saving);});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')eachSync(s=>s.flush());});
window.addEventListener('pagehide',()=>eachSync(s=>s.flush()));

/* timer */
const getTimer=()=>{try{return JSON.parse(localStorage.getItem(LS_TIMER)||'null');}catch(e){return null;}};
const setTimer=t=>{try{t?localStorage.setItem(LS_TIMER,JSON.stringify(t)):localStorage.removeItem(LS_TIMER);}catch(e){}};
function tick(){const t=getTimer();if(!t)return;
  const left=t.start+t.minutes*60000-Date.now();
  document.querySelectorAll('.timer').forEach(el=>{
    if(left>0){const m=Math.floor(left/60000),s=Math.floor(left%60000/1000);el.textContent=m+':'+String(s).padStart(2,'0');el.classList.remove('over');}
    else{el.textContent='הזמן נגמר. מה הושלם, ומה נשאר?';el.classList.add('over');}});}
setInterval(tick,1000);

/* actions on blocks */
/* The block's own document carries the status. doneEvents gets a copy of "done" only: it is written
   and never read, as the way back to v1.2, and goes away in v1.4 (see CLAUDE.md).
   A status is only ever set by a tap here. Nothing marks a block by itself. */
const TIMEBOX=90,MAX_CHECK=4;
const facts=b=>b?{date:iso(b.start),streamIds:b.streams.slice(),title:b.title}:{};
const born=(was,b)=>was.timeboxMin?{}:{timeboxMin:b?Math.min(TIMEBOX,mins(b)):TIMEBOX};
/* Until the server has answered, this tab's copy of the block (p.over) wins over incoming snapshots:
   the snapshot of one write can land after the next tap, and would otherwise undo it on screen. */
function putDoc(kind,id,fields,local){
  const p=projects[cur],over=p.over[kind];
  over[id]={n:((over[id]||{}).n||0)+1,doc:Object.assign({},p[kind][id],fields,local)};
  p[kind]=Object.assign({},p[kind],{[id]:over[id].doc});point(p);
  p.syncs[kind].set(id,fields).then(()=>{
    if(projects[p.id]!==p||!over[id]||--over[id].n)return;
    delete over[id];p[kind]=withOver(p,kind);point(p);
  });
}
const putBlock=(id,fields,local)=>putDoc('blocks',id,fields,local);
const withOver=(p,kind)=>{const o=Object.assign({},p.snap[kind]);Object.keys(p.over[kind]).forEach(id=>{o[id]=p.over[kind][id].doc;});return o;};
const point=p=>{if(cur===p.id){blocks=p.blocks||{};gates=p.gates||{};}};
/* status: done, partial, skipped, or planned to take a confirmation back. The day, stream and title
   are recorded from the calendar at the moment of confirming and are not touched again. "done" ticks
   the whole checklist, so it is one tap from any row. */
function confirmBlock(id,status,extra){
  const b=cal.blocks.find(x=>x.id===id),day=iso(today()),was=blk(id),on=status!=='planned';
  const fields=Object.assign({eventId:id,status},on?{confirmedOn:day,confirmedAt:SERVER_NOW}:{confirmedOn:null,confirmedAt:null},
    on&&!CONFIRMED.includes(was.status)?facts(b):{},born(was,b),status==='done'?{nextAction:null,blocker:null}:{},extra);
  if(status==='done'&&(was.checklist||[]).length)fields.checklist=was.checklist.map(c=>Object.assign({},c,{done:true}));
  putBlock(id,fields,on?{confirmedAt:Date.now()}:{});
  if(status==='done'){if(was.status!=='done'){state.doneEvents[id]=day;if(b)state.log.push({d:day,t:b.title,s:b.streams[0]||'',e:id});}}
  else{delete state.doneEvents[id];state.log=state.log.filter(x=>x.e!==id);}
  const t=getTimer();if(on&&t&&t.event===id)setTimer(null);
  ui.ask=null;
  commit();
}
const setDone=(id,on)=>confirmBlock(id,on?'done':'planned');
/* Everything else about a block (its plan, checklist, time-box): only the block's own document. */
function saveBlock(id,fields){
  const b=cal.blocks.find(x=>x.id===id),was=blk(id);
  putBlock(id,Object.assign(was.status?{}:Object.assign({eventId:id,status:'planned'},facts(b)),born(was,b),fields));
  render();
}
/* A confirmed block that has no day yet (one copied over from doneEvents) gets its day, stream and
   title from the calendar the first time its event is seen. Only missing fields are filled. */
function fillFacts(){
  const keep=cur;
  loadedIds().forEach(id=>{const p=projects[id];if(!p.blocks)return;use(id);
    cal.blocks.forEach(b=>{const k=p.blocks[b.id];if(!k||!CONFIRMED.includes(k.status)||k.date)return;
      const f={date:iso(b.start)};if(!sids(k).length)f.streamIds=b.streams.slice();if(!k.title)f.title=b.title;
      putBlock(b.id,f);});});
  if(keep&&projects[keep]&&projects[keep].state)use(keep);
}

/* views */
/* The app bar: save status and the tools that used to sit in the project header. */
function bar(back){
  return `<div class="bar">${back?'<a class="b-link bar-back" href="#/">כל הפרויקטים</a>':'<span></span>'}<span class="top-tools"><span id="save" class="save">${esc(saveText)}</span><a class="b-link out" href="https://calendar.google.com/calendar/r" target="_blank" rel="noopener">יומן Google</a><button class="b-link out" data-act="signout">התנתקות</button></span></div>`;
}
/* The artifact header's countdown: days to the flight, then to the decision. Only for dates the project has. */
function countdown(P){
  const f=P.flight?daysUntil(P.flight):null;
  if(f!==null&&f>0)return `<span class="count-n">${f}</span><span>ימים לטיסה (${fmt(P.flight)})</span>`;
  if(f===0)return '<span class="count-n">היום</span><span>טסים</span>';
  if(P.decision&&P.decision.date)return `<span class="count-n">${daysUntil(P.decision.date)}</span><span>ימים לנקודת ההחלטה</span>`;
  return '';
}
/* A stream at a glance: how much of its calendar is done (or of its milestones, when it has no blocks),
   colored by its RAG light for the next gate. */
function streamPace(s){
  const bl=blocksOf(s.id),ms=counted(s),r=ragOf(s,nextGate());
  const pct=bl.length?Math.round(bl.filter(isDone).length/bl.length*100):ms.length?Math.round(ms.filter(m=>m.done).length/ms.length*100):0;
  if(!r||!r.color)return {pct,cls:'none',note:bl.length?'בלי נורית':'אין בלוקים ביומן'};
  return {pct,cls:RAG[r.color][1],note:RAG[r.color][0]+': '+ragText(r)};
}
/* The project overview: the page's top panel, or a card on the home screen when card is true.
   A card is one link to the project, so nothing inside it is interactive. */
function overview(card){
  const P=state.project,n=Date.now(),id=esc(cur);
  const ms=state.streams.flatMap(counted),md=ms.filter(m=>m.done).length;
  const pct=ms.length?Math.round(md/ms.length*100):0;
  const ws=weekStart(),we=new Date(ws);we.setDate(we.getDate()+7);
  const wb=cal.blocks.filter(b=>b.start>=ws&&b.start<we);
  const week=cal.items.length||cal.status==='ok'?`<p class="ov-week">השבוע: ${wb.filter(isDone).length} מתוך ${wb.length} בלוקים</p>`:'';
  const dl=allOpen()[0];
  const nb=cal.blocks.find(b=>b.end>n&&!isConfirmed(b));
  const missed=awaiting().length;
  const c=countdown(P);
  const tile=(lbl,val)=>`<div class="ov-tile"><span class="ov-lbl">${lbl}</span>${val}</div>`;
  const tiles=[
    tile('התקדמות',`<div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="אבני דרך שהושלמו"><div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div><span class="prog-n">${pct}%</span></div><p class="ov-sub">אבני דרך: ${md} מתוך ${ms.length}</p>${week}`),
    tile('הדד־ליין הבא',dl?`<span class="ov-val">${esc(dl.m.title)}</span><p class="ov-sub"><span class="chip ${urg(daysUntil(dl.m.date))}">${rel(daysUntil(dl.m.date))}</span> ${fmt(dl.m.date)}</p>`:'<span class="ov-val muted">אין דד־ליינים פתוחים</span>'),
    tile('הבלוק הבא',nb?`<span class="ov-val">${esc(nb.title)}</span><p class="ov-sub">${esc(nb.start<=n?'עכשיו, עד '+hm(nb.end):whenLabel(nb))}</p>`:`<span class="ov-val muted">${cal.items.length?'אין בלוקים עתידיים':'היומן לא נטען'}</span>`),
    tile('מחכים לסימון',`<span class="ov-val">${missed?(missed===1?'בלוק אחד מחכה לסימון':missed+' בלוקים מחכים לסימון'):'הכול מסומן'}</span>${missed&&!card?'<p class="ov-sub"><a href="#tray">לסמן מה קרה</a></p>':''}`)
  ].join('');
  const rows=state.streams.map(s=>{const p=streamPace(s);const inner=`<span class="ovs-n">${esc(s.name)}</span><span class="ovs-bar"><span class="ovs-fill ${p.cls}" style="width:${p.pct}%"></span></span><span class="ovs-p ${p.cls}">${p.pct}%</span>`;
    return card?`<li class="ovs" title="${esc(p.note)}">${inner}</li>`:`<li><a class="ovs" href="#st-${esc(s.id)}" title="${esc(p.note)}" aria-label="${esc(s.name)}: ${p.pct}%, ${esc(p.note)}">${inner}</a></li>`;}).join('');
  const head=`<div class="ov-head">${card?`<h2>${esc(P.name)}</h2>`:`<h1>${esc(P.name)}</h1>`}${P.status==='paused'?'<span class="chip calm">מוקפא</span>':''}${card?'':`<button class="b-link ov-edit" data-act="edit-project" aria-expanded="${ui.editP===cur}">${ui.editP===cur?'סגור עריכה':'עריכה'}</button>`}</div>${P.goal?`<p class="goal">${esc(P.goal)}</p>`:''}${c?`<div class="count">${c}</div>`:''}`;
  const body=`${head}<div class="ov-grid">${tiles}</div>${rows?`<ul class="ov-streams" aria-label="המסלולים">${rows}</ul>`:''}`;
  return card?`<a class="ov card" href="#/p/${encodeURIComponent(cur)}" data-p="${id}">${body}</a>`:`<header class="ov top">${body}</header>`;
}
/* Today's blocks from every active project, each with its done toggle. */
function todayView(){
  const act=activeIds(),n=Date.now(),t0=today(),t1=today();t1.setDate(t1.getDate()+1);
  const items=[];act.forEach(id=>{use(id);cal.blocks.filter(b=>b.start>=t0&&b.start<t1).forEach(b=>items.push({id,b,done:isDone(b),st:ST[blk(b.id).status],proj:state.project.name}));});
  items.sort((x,y)=>x.b.start-y.b.start);
  const multi=act.length>1;
  const list=items.map(({id,b,done,proj,st})=>{const wait=!st&&b.end<=n;
    return `<li class="${done?'done':''}" data-p="${esc(id)}"><label><input type="checkbox" data-act="ev-toggle" data-e="${esc(b.id)}"${done?' checked':''}><span class="wk-time">${hm(b.start)}</span><span class="wk-t">${esc(b.title)}</span></label>${multi?`<span class="wk-s">${esc(proj)}</span>`:''}${b.link?`<a class="wk-cal" href="${esc(b.link)}" target="_blank" rel="noopener">פתח ביומן</a>`:''}${st&&!done?`<span class="chip ${st[1]}">${st[0]}</span>`:''}${wait?'<span class="chip calm">מחכה לסימון</span>':''}<button class="b-link wk-open" data-act="run" data-e="${esc(b.id)}">פתח</button></li>`;}).join('');
  const empty=cal.status==='loading'?'טוען את הלו״ז מהיומן…':cal.items.length||cal.status==='ok'?'אין בלוקים היום.':(CAL_TITLE[cal.status]||'')+'. '+(cal.msg||'');
  return `<section class="sec today-strip" aria-labelledby="today-h"><div class="sec-head"><h2 id="today-h">היום</h2>${cal.status==='ok'?'':calButton('b-link')}</div>
  <div class="wk">${items.length?`<div class="wk-day"><ul>${list}</ul></div>`:`<p class="muted">${esc(empty)}</p>`}</div></section>`;
}
function pausedView(){
  const ids=pausedIds();if(!ids.length)return '';
  return `<details class="paused sec"${ui.warnP?' open':''}><summary>מוקפאים (${ids.length})</summary>${ui.warnP?`<p class="warn" role="alert">${esc(ui.warnP)}</p>`:''}<ul>${ids.map(id=>{const P=projects[id].state.project;
    return `<li data-p="${esc(id)}"><a href="#/p/${encodeURIComponent(id)}">${esc(P.name)}</a>${P.goal?`<span class="muted">${esc(P.goal)}</span>`:''}<button class="b-sec" data-act="activate">הפעל</button></li>`;}).join('')}</ul></details>`;
}
/* Editing. Everything edited here lives in `project` or `streams`, which are saved as whole fields
   (last write wins), like the stream edits the artifact already had. */
const MAX_LEN={title:200,text:500,label:80,url:2000,key:40};
const isUrl=u=>/^https?:\/\/\S+$/i.test(u)&&u.length<=MAX_LEN.url;   // the same rule streamLinks() shows links by
const isDate=d=>/^\d{4}-\d{2}-\d{2}$/.test(d);
const eKey=(...a)=>[cur,...a].join(':');   // ids of the row being edited, per project
/* Deleting takes two taps on the same row: × turns into "למחוק? כן, למחוק / ביטול". "ביטול" lands where
   × was, so a double tap cancels instead of deleting. `attrs` are the × button's data attributes. */
function delButton(key,act,attrs,label){
  return ui.confirmDel===key
    ?`<span class="del-q" role="status">למחוק?</span><button class="b-del" data-act="${act}" ${attrs}>כן, למחוק</button><button class="b-link" data-act="del-cancel">ביטול</button>`
    :`<button class="x" data-act="${act}" ${attrs} aria-label="${label}">×</button>`;
}
// Runs the delete on the second tap; returns false after the first.
function confirmDel(key){if(ui.confirmDel===key){ui.confirmDel=null;return true;}ui.confirmDel=key;render();focusIn('.b-del');return false;}
/* How many blocks in the loaded calendar a calendar key would match; null when no calendar is loaded. */
function keyCount(key){return cal.items.length||cal.status==='ok'?toBlocks({items:cal.items},key).length:null;}
function keyNote(key){
  const k=String(key||'').trim(),n=keyCount(k);
  if(!k)return {warn:true,text:'צריך מילה כדי שהפרויקט יזהה בלוקים ביומן.'};
  if(n===null)return {warn:true,text:'היומן לא מחובר, אז אי אפשר לבדוק כמה בלוקים תואמים. חבר את היומן כדי לבדוק.'};
  if(n===0)return {warn:true,text:'אף בלוק ביומן לא תואם למילה הזו (בטווח התאריכים שנטען).'};
  return {warn:false,text:(n===1?'בלוק אחד':n+' בלוקים')+' ביומן תואמים למילה הזו (בטווח התאריכים שנטען).'};
}
function editPanel(){
  const P=state.project,sc=P.success||[],key=ui.keyDraft!==null?ui.keyDraft:(P.calendarKey||''),kn=keyNote(key);
  const confirm=ui.keyConfirm!==null&&ui.keyConfirm===key.trim();
  const scRows=sc.map((x,i)=>ui.editSc===eKey(i)
    ?`<li><form class="form" data-form="sc-edit" data-i="${i}"><input name="text" value="${esc(x)}" required maxlength="${MAX_LEN.text}" aria-label="קריטריון הצלחה"><button class="b-sec">שמור</button><button type="button" class="b-link" data-act="edit-cancel">ביטול</button></form></li>`
    :`<li><span class="ed-t">${esc(x)}</span>${ui.confirmDel===eKey('sc',i)?'':`<button class="b-link" data-act="sc-edit" data-i="${i}">עריכה</button>`}${delButton(eKey('sc',i),'sc-del',`data-i="${i}"`,'מחק: '+esc(x))}</li>`).join('');
  const paused=P.status==='paused';
  return `<section class="sec edit" aria-labelledby="edit-h"><div class="sec-head"><h2 id="edit-h">עריכת הפרויקט</h2><button class="b-link" data-act="edit-project">סגור</button></div>
  <form class="edit-block" data-form="name"><h3><label for="ed-name">שם הפרויקט</label></h3><div class="form"><input id="ed-name" name="name" value="${esc(P.name||'')}" required maxlength="${MAX_LEN.title}"><button class="b-sec">שמור</button></div></form>
  <form class="edit-block" data-form="goal"><h3><label for="ed-goal">מטרה</label></h3><div class="form"><textarea id="ed-goal" name="goal" rows="2" maxlength="${MAX_LEN.text}">${esc(P.goal||'')}</textarea><button class="b-sec">שמור</button></div></form>
  <div class="edit-block"><h3>קריטריוני הצלחה</h3>${sc.length?`<ul class="ed-list">${scRows}</ul>`:'<p class="muted">אין עדיין קריטריונים.</p>'}
    <form class="form" data-form="sc-add"><input name="text" required maxlength="${MAX_LEN.text}" placeholder="קריטריון חדש" aria-label="קריטריון חדש"><button class="b-sec">הוסף</button></form></div>
  <form class="edit-block" data-form="key" novalidate><h3><label for="ed-key">מילת היומן</label></h3><p class="ed-help">אירוע ביומן שייך לפרויקט אם הכותרת שלו מכילה את המילה, למשל "${esc(P.calendarKey||'מדריד')} — סאבלט: ...".</p>
    <div class="form"><input id="ed-key" name="key" data-act="key-input" value="${esc(key)}" maxlength="${MAX_LEN.key}" autocomplete="off"><button class="b-sec" id="key-save">${confirm?'שמור בכל זאת':'שמור'}</button></div>
    <p id="key-count" class="${kn.warn?'warn':'ed-ok'}" role="status">${esc(kn.text)}</p></form>
  <div class="edit-block"><h3>סטטוס</h3><p class="ed-help">הפרויקט ${paused?'מוקפא: הוא לא מופיע ב"היום" והבלוקים שלו לא נטענים.':'פעיל.'} אפשר עד ${MAX_ACTIVE} פרויקטים פעילים.</p>
    <button class="b-sec" data-act="${paused?'activate':'pause'}">${paused?'הפעל את הפרויקט':'הקפא את הפרויקט'}</button>${ui.warnP?`<p class="warn" role="alert">${esc(ui.warnP)}</p>`:''}</div>
  </section>`;
}
/* The calendar key: a key that matches nothing, or can't be checked, needs a second tap. */
function saveKey(form,key){
  const k=key.slice(0,MAX_LEN.key),kn=keyNote(k);
  const out=form.querySelector('#key-count');
  if(!k){out.className='warn';out.textContent=kn.text;return;}
  if(k===(state.project.calendarKey||'')){ui.keyDraft=null;ui.keyConfirm=null;out.className='ed-ok';out.textContent='המילה לא השתנתה. '+kn.text;return;}
  if(kn.warn&&ui.keyConfirm!==k){ui.keyConfirm=k;ui.keyDraft=k;out.className='warn';out.textContent=kn.text+' לשמור בכל זאת?';form.querySelector('#key-save').textContent='שמור בכל זאת';return;}
  state.project.calendarKey=k;ui.keyDraft=null;ui.keyConfirm=null;commit();
}
/* Stream links: add or edit, http(s) only. Errors show in the form, so nothing typed is lost. */
function saveLink(form,s,label,url){
  const err=form.querySelector('.form-err');
  if(!isUrl(url)){err.textContent='הכתובת צריכה להתחיל ב־https:// (או http://), בלי רווחים.';err.hidden=false;return;}
  const link={label:label.slice(0,MAX_LEN.label),url};
  if(form.dataset.form==='link-edit'){const i=+form.dataset.i;if(!s.links||!s.links[i])return;s.links[i]=link;}
  else (s.links=s.links||[]).push(link);
  ui.editLink=null;commit();
}
/* An open dependency on someone else, with no alternative, makes the stream red whatever its blocks say. */
function depEditor(s){
  if(!inRag(s))return '';
  const d=s.externalDependency||{};
  return `<div class="st-links-edit st-dep"><h4>תלות חיצונית</h4><label><input type="checkbox" data-act="dep" data-k="open" data-s="${esc(s.id)}"${d.open?' checked':''}> יש תלות חיצונית פתוחה</label><label><input type="checkbox" data-act="dep" data-k="hasAlternative" data-s="${esc(s.id)}"${d.hasAlternative?' checked':''}> יש חלופה</label></div>`;
}
function linksEditor(s){
  const L=s.links||[];
  const rows=L.map((l,i)=>ui.editLink===eKey(s.id,i)
    ?`<li><form class="form" data-form="link-edit" data-s="${esc(s.id)}" data-i="${i}" novalidate><input name="label" value="${esc(l&&l.label||'')}" maxlength="${MAX_LEN.label}" placeholder="שם הקישור" aria-label="שם הקישור"><input name="url" type="url" dir="ltr" value="${esc(l&&l.url||'')}" maxlength="${MAX_LEN.url}" placeholder="https://" aria-label="כתובת"><button class="b-sec">שמור</button><button type="button" class="b-link" data-act="edit-cancel">ביטול</button><p class="warn form-err" role="alert" hidden></p></form></li>`
    :`<li><span class="ed-t">${esc(l&&l.label||l&&l.url||'')}</span><span class="lk-u" dir="ltr">${esc(l&&l.url||'')}</span>${isUrl(String(l&&l.url||''))?'':'<span class="chip red">לא מוצג: לא http(s)</span>'}${ui.confirmDel===eKey('link',s.id,i)?'':`<button class="b-link" data-act="link-edit" data-s="${esc(s.id)}" data-i="${i}">עריכה</button>`}${delButton(eKey('link',s.id,i),'link-del',`data-s="${esc(s.id)}" data-i="${i}"`,'מחק קישור')}</li>`).join('');
  return `<div class="st-links-edit"><h4>קישורים</h4>${L.length?`<ul class="ed-list">${rows}</ul>`:''}
  <form class="form" data-form="link-add" data-s="${esc(s.id)}" novalidate><input name="label" maxlength="${MAX_LEN.label}" placeholder="שם הקישור" aria-label="שם הקישור החדש"><input name="url" type="url" dir="ltr" maxlength="${MAX_LEN.url}" placeholder="https://" aria-label="כתובת הקישור החדש"><button class="b-sec">הוסף קישור</button><p class="warn form-err" role="alert" hidden></p></form></div>`;
}
/* The block screens (v1.3). */
const PLAN=[['goal','מטרה'],['deliverable','תוצר'],['firstAction','פעולה ראשונה'],['dod','Definition of Done']];
/* Any status other than "done" has to leave the next physical step behind. */
function askForm(id,where){
  const a=ui.ask;if(!a||a.k!==eKey(id)||a.w!==where)return '';
  return `<form class="form bk-ask" data-form="bk-status" data-e="${esc(id)}" data-st="${a.st}"><input name="next" required maxlength="${MAX_LEN.text}" placeholder="הצעד הפיזי הבא (חובה)" aria-label="הצעד הבא"><input name="blocker" maxlength="${MAX_LEN.text}" placeholder="מה חסם?" aria-label="חסם"><button class="b-sec">שמור: ${ST[a.st][0]}</button><button type="button" class="b-link" data-act="edit-cancel">ביטול</button></form>`;
}
/* The catch-up tray: every past block with no status, newest first, one tap each. */
function trayView(ids){
  const rows=[];ids.forEach(id=>{use(id);awaiting().forEach(b=>rows.push({id,b,proj:state.project.name,nm:names(b),na:b.streams.map(streamNext).find(Boolean)}));});
  if(!rows.length)return '';
  rows.sort((x,y)=>y.b.start-x.b.start);
  const multi=ids.length>1;
  return `<section class="sec tray" id="tray" aria-labelledby="tray-h"><h2 id="tray-h">עוד לא סומנו (${rows.length})</h2><ul class="tray-list">${rows.map(({id,b,proj,nm,na})=>{use(id);const e=esc(b.id);
    return `<li data-p="${esc(id)}"><div class="tray-main"><span class="wk-t">${esc(b.title)}</span><span class="wk-s">${esc(whenLabel(b))}${nm?' · '+esc(nm):''}${multi?' · '+esc(proj):''}</span>${na?`<span class="tray-na">הצעד הבא שנשאר: ${esc(na.nextAction)}</span>`:''}</div>
    <div class="tray-acts"><button class="b-sec" data-act="bk-done" data-e="${e}">בוצע</button><button class="b-sec alt" data-act="bk-ask" data-w="tray" data-st="partial" data-e="${e}">חלקי</button><button class="b-sec alt" data-act="bk-ask" data-w="tray" data-st="skipped" data-e="${e}">דילגתי</button><button class="b-link" data-act="run" data-e="${e}">פתח</button></div>${askForm(b.id,'tray')}</li>`;}).join('')}</ul></section>`;
}
function orphansView(ids){
  const rows=[];ids.forEach(id=>{use(id);orphans().forEach(k=>rows.push({id,k}));});
  if(!rows.length)return '';
  return `<details class="sec orphans"><summary>סומנו, והאירוע נמחק או הוזז ביומן (${rows.length})</summary><p class="muted">הרישום נשמר כמו שהוא. שום דבר לא נמחק ולא מחושב מחדש.</p><ul class="ed-list">${rows.map(({id,k})=>`<li data-p="${esc(id)}"><span class="ed-t">${esc(k.title||'בלוק')}</span><span class="chip ${ST[k.status][1]}">${ST[k.status][0]}</span><span class="ms-d">${fmt(k.date)}</span><button class="b-link" data-act="run" data-e="${esc(k.eventId)}">פתח</button></li>`).join('')}</ul></details>`;
}
/* One block: its plan, a checklist of at most MAX_CHECK items, the time-box, and the status.
   "בוצע" is available only when the whole checklist is ticked; otherwise it's "חלקי". */
function runnerView(ids){
  const r=ui.run;if(!r||!ids.includes(r.p)||!projects[r.p]||!projects[r.p].state)return '';
  use(r.p);
  const id=r.e,e=esc(id),k=blk(id),b=cal.blocks.find(x=>x.id===id),conf=CONFIRMED.includes(k.status);
  const list=k.checklist||[],all=list.every(c=>c.done);
  const tb=k.timeboxMin||(b?Math.min(TIMEBOX,mins(b)):TIMEBOX),t=getTimer(),running=t&&t.event===id;
  const orphan=orphans().some(o=>o.eventId===id);
  const hasPlan=PLAN.some(([f])=>k[f]);
  const plan=ui.editPlan||!hasPlan
    ?`<form class="run-plan" data-form="bk-plan" data-e="${e}">${PLAN.map(([f,l])=>`<label>${l}<input name="${f}" value="${esc(k[f]||'')}" maxlength="${MAX_LEN.text}"></label>`).join('')}<div class="f-row"><button class="b-sec">שמור</button>${hasPlan?'<button type="button" class="b-link" data-act="plan-edit">ביטול</button>':''}</div></form>`
    :`<dl class="run-dl">${PLAN.filter(([f])=>k[f]).map(([f,l])=>`<dt>${l}</dt><dd>${esc(k[f])}</dd>`).join('')}</dl><button class="b-link" data-act="plan-edit">עריכה</button>`;
  const checks=`<h3>צ׳קליסט</h3>${list.length?`<ul class="ed-list run-ck">${list.map((c,i)=>`<li><label><input type="checkbox" data-act="ck-toggle" data-e="${e}" data-i="${i}"${c.done?' checked':''}><span>${esc(c.text)}</span></label>${delButton(eKey('ck',id,i),'ck-del',`data-e="${e}" data-i="${i}"`,'מחק: '+esc(c.text))}</li>`).join('')}</ul>`:''}
  ${list.length<MAX_CHECK?`<form class="form" data-form="ck-add" data-e="${e}"><input name="text" required maxlength="${MAX_LEN.title}" placeholder="פריט לצ׳קליסט" aria-label="פריט חדש"><button class="b-sec">הוסף</button></form>`:`<p class="muted">עד ${MAX_CHECK} פריטים. צריך יותר? אלה שני בלוקים.</p>`}`;
  const timer=conf?'':`<div class="run-acts">${running?'<div class="timer" aria-live="polite"></div>':''}<button class="b-sec alt" data-act="timer" data-e="${e}" data-min="${tb}">${running?'עצור טיימר':`התחל ${tb} דק׳`}</button><button class="b-sec alt" data-act="tb-stop" data-e="${e}"${k.timeboxStopped?' disabled':''}>${k.timeboxStopped?`נעצר ב־${tb} ✓`:`עצרתי ב־${tb}`}</button></div>`;
  // A time is shown only for a confirmation made in the app; a copied-over one has only its day.
  const when=conf&&k.confirmedOn?`אושר ב־${fmt(k.confirmedOn)}${k.confirmedAt?', '+hm(new Date(k.confirmedAt)):''}`:'';
  const status=conf
    ?`<div class="run-acts"><span class="chip ${ST[k.status][1]}">${ST[k.status][0]}</span><span class="muted">${when}${k.timeboxStopped?` · נעצר ב־${tb}`:''}</span><button class="b-link" data-act="bk-undo" data-e="${e}">בטל סימון</button></div>${k.status!=='done'&&k.nextAction?`<p class="run-na"><b>הצעד הבא:</b> ${esc(k.nextAction)}</p>`:''}${k.status!=='done'&&k.blocker?`<p class="muted">חסם: ${esc(k.blocker)}</p>`:''}`
    :`<div class="run-acts"><button class="b-sec" data-act="bk-done" data-e="${e}"${all?'':' disabled'}>בוצע</button><button class="b-sec alt" data-act="bk-ask" data-w="run" data-st="partial" data-e="${e}">חלקי</button><button class="b-sec alt" data-act="bk-ask" data-w="run" data-st="skipped" data-e="${e}">דילגתי</button></div>${all?'':'<p class="muted">"בוצע" נפתח כשכל הצ׳קליסט מסומן. אחרת: חלקי, עם הצעד הבא.</p>'}${askForm(id,'run')}`;
  return `<section class="sec run" id="runner" data-p="${esc(r.p)}" aria-labelledby="run-h"><div class="sec-head"><h2 id="run-h">${esc(b?b.title:k.title||'בלוק')}</h2><button class="b-link" data-act="run-close">סגור</button></div>
  <p class="muted">${b?esc(whenLabel(b))+', '+mins(b)+' דק׳'+(names(b)?' · '+esc(names(b)):''):k.date?fmt(k.date):''}</p>
  ${orphan?'<p class="warn">האירוע נמחק או הוזז ביומן. הרישום נשמר כמו שהוא.</p>':!b?'<p class="muted">האירוע לא נמצא ביומן שנטען.</p>':''}
  ${plan}${checks}${timer}${status}</section>`;
}
/* The critical stream is red: the fixed banner. The app only says so; it never touches the calendar. */
function criticalBanner(ids){
  const out=[];ids.forEach(id=>{use(id);const g=nextGate();state.streams.filter(s=>s.critical&&inRag(s)).forEach(s=>{const r=ragOf(s,g);if(r&&r.color==='red')out.push(`<p class="crit" role="alert"><b>ה־Critical Path בפיגור.</b> 90 הדקות הבאות עוברות ל${esc(s.name)}.</p>`);});});
  return out.join('');
}
/* The gates rail: every gate with its light, the next one marked. A tap opens its criteria (ticked by
   hand, never automatically) and each stream's state in that gate's window. */
function gatesView(){
  const all=gateList();if(!all.length)return '';
  const next=nextGate(),open=ui.gate&&ui.gate.p===cur?all.find(g=>g.id===ui.gate.g):null;
  const head=next?`<p class="gate-next">הגייט הבא: <b>${esc(next.id)}${next.label?' · '+esc(next.label):''}</b> <span class="chip ${urg(daysUntil(next.date))}">${rel(daysUntil(next.date))}</span> <span class="ms-d">${fmt(next.date)}</span></p>`:'<p class="gate-next muted">כל הגייטים עברו.</p>';
  const rail=all.map(g=>`<li><button class="gate${next&&g.id===next.id?' cur':''}${open&&open.id===g.id?' open':''}" data-act="gate" data-g="${esc(g.id)}" aria-expanded="${!!(open&&open.id===g.id)}"${next&&g.id===next.id?' aria-current="step"':''}>${dot(gateColor(g))}<span class="gate-id">${esc(g.id)}</span><span class="gate-d">${fmt(g.date)}</span>${gateWaiting(g).length?`<span class="gate-w">${gateWaiting(g).length===1?'1 מחכה':gateWaiting(g).length+' מחכים'}</span>`:''}</button></li>`).join('');
  let panel='';
  if(open){
    const crit=(open.criteria||[]).map((c,i)=>{const st=c.streamId?S(c.streamId):null,u=c.link&&isUrl(String(c.link.url||''))?c.link:null;
      return `<li><label><input type="checkbox" data-act="gate-met" data-g="${esc(open.id)}" data-i="${i}"${c.met?' checked':''}><span>${esc(c.text)}</span></label><span class="wk-s">${st?esc(st.name):'בלי מסלול, נבדק ידנית'}${c.met&&c.metOn?' · סומן ב־'+fmt(c.metOn):''}</span>${u?`<a class="wk-cal" href="${esc(u.url)}" target="_blank" rel="noopener">${esc(u.label||u.url)}</a>`:''}</li>`;}).join('');
    const rows=state.streams.filter(inRag).map(s=>{const r=ragOf(s,open);return `<li>${dot(r.color)}<span class="ed-t">${esc(s.name)}</span><span class="wk-s">${ragText(r)}</span></li>`;}).join('');
    const wait=gateWaiting(open),refused=ui.gateWarn&&ui.gateWarn.p===cur&&ui.gateWarn.g===open.id;
    const hold=!cal.storedAt?(refused?'<p class="warn" role="alert">אי אפשר לסמן קריטריון לפני שהיומן נטען: אי אפשר לדעת אילו בלוקים מחכים לסימון. חבר יומן ונסה שוב.</p>':'')
      :wait.length?`<div class="gate-hold${refused?' warn':''}"${refused?' role="alert"':''}><p>${refused?'אי אפשר לסמן קריטריון: ':''}${wait.length===1?'בלוק אחד בחלון של הגייט מחכה':wait.length+' בלוקים בחלון של הגייט מחכים'} לסימון. סמן ${wait.length===1?'אותו':'אותם'} במגש "עוד לא סומנו":</p><ul>${wait.map(b=>`<li>${esc(b.title)} · ${fmt(iso(b.start))}${names(b)?' · '+esc(names(b)):''}</li>`).join('')}</ul></div>`:'';
    panel=`<div class="gate-panel"><h3>${esc(open.id)}${open.label?' · '+esc(open.label):''} <span class="ms-d">${fmt(open.date)}</span></h3>${hold}${crit?`<ul class="ed-list run-ck">${crit}</ul>`:'<p class="muted">אין קריטריונים לגייט הזה.</p>'}<h4>המסלולים בחלון של הגייט</h4><ul class="ed-list">${rows}</ul></div>`;
  }
  return `<section class="sec gates" aria-labelledby="gates-h"><h2 id="gates-h">גייטים</h2>${head}<div class="gate-scroll"><ol class="gate-rail">${rail}</ol></div>${panel}</section>`;
}
/* One project's full page: the overview panel, then the artifact's dashboard. */
function projectPage(extra){return `<div data-p="${esc(cur)}">${overview(false)}${ui.editP===cur?editPanel():''}${gatesView()}${extra||''}${nowView()}${weekView()}${streams()}${upcoming()}${timeline()}${logView()}${rulesView()}</div>`;}
/* Cards: the nearest open deadline first, projects without one last, ties by name. */
const nextDeadline=id=>{use(id);const o=allOpen()[0];return o?o.m.date:'9999-12-31';};
function byDeadline(a,b){const x=nextDeadline(a),y=nextDeadline(b);return x<y?-1:x>y?1:projects[a].state.project.name.localeCompare(projects[b].state.project.name,'he');}
/* Home: today across projects, then the one active project's full page, or a card per active project. */
function homeView(){
  const act=activeIds();
  let h=bar(false)+trayView(act)+orphansView(act)+criticalBanner(act)+runnerView(act)+todayView();
  if(act.length===1){use(act[0]);h+=projectPage(pausedView());}
  else{h+=act.length?`<section class="cards sec" aria-label="פרויקטים פעילים">${act.slice().sort(byDeadline).map(id=>{use(id);return overview(true);}).join('')}</section>`:'<p class="muted sec">אין פרויקטים פעילים.</p>';h+=pausedView();}
  return h;
}
const names=b=>b.streams.map(id=>(S(id)||{}).name).filter(Boolean).join(' + ');
function nowView(){
  if(cal.status==='loading')return `<section class="now"><div class="now-head"><span class="now-tag">הבלוק הבא</span></div><h2 class="now-title">טוען את הלו״ז מהיומן…</h2></section>`;
  if(!cal.blocks.length)return `<section class="now"><div class="now-head"><span class="now-tag">הבלוק הבא</span></div><h2 class="now-title">${cal.status==='ok'?`אין בלוקים של ${esc(state.project.calendarKey||state.project.name)} ביומן`:CAL_TITLE[cal.status]}</h2><p class="now-meta">${esc(cal.msg||'')}</p><div class="now-actions">${calButton('b-light')}</div></section>`;
  const n=Date.now();
  const b=cal.blocks.find(x=>x.start<=n&&x.end>n&&!isConfirmed(x))||cal.blocks.find(x=>x.start>n&&!isConfirmed(x));
  const missed=awaiting();
  const missedLine=missed.length?`<p class="now-missed">${missed.length===1?'בלוק אחד מחכה לסימון':missed.length+' בלוקים מחכים לסימון'}. <a href="#tray">לסמן מה קרה</a></p>`:'';
  if(!b)return `<section class="now"><div class="now-head"><span class="now-tag">הבלוק הבא</span></div><h2 class="now-title">אין עוד בלוקים עתידיים ביומן</h2>${missedLine}</section>`;
  const live=b.start<=n,t=getTimer(),running=t&&t.event===b.id;
  return `<section class="now" aria-labelledby="now-h">
  <div class="now-head"><span class="now-tag">${live?'עכשיו':'הבלוק הבא'}</span><span>${esc(names(b))}</span></div>
  <h2 id="now-h" class="now-title">${esc(b.title)}</h2>
  <p class="now-meta">${live?'עד '+hm(b.end):esc(whenLabel(b))}, ${mins(b)} דקות</p>
  ${b.desc?`<p class="now-dod">${esc(b.desc)}</p>`:''}
  ${state.stuck[b.id]?`<p class="now-dod">הצעד המוקטן: ${esc(state.stuck[b.id])}</p>`:''}
  ${running?'<div class="timer" id="timer" aria-live="polite"></div>':''}
  <div class="now-actions">
    <button class="b-light" data-act="timer" data-e="${esc(b.id)}" data-min="${mins(b)}">${running?'עצור טיימר':'התחל טיימר '+mins(b)+' דק׳'}</button>
    <button class="b-light" data-act="ev-done" data-e="${esc(b.id)}">בוצע</button>
    <button class="b-ghost" data-act="run" data-e="${esc(b.id)}">פתח את הבלוק</button>
    <button class="b-ghost" data-act="stuck-ask">נתקעתי</button>
    ${b.link?`<a class="b-ghost" href="${esc(b.link)}" target="_blank" rel="noopener">פתח ביומן</a>`:''}
  </div>
  ${ui.stuck?`<form class="inline" data-form="stuck" data-e="${esc(b.id)}"><p class="f-q">לא מחליפים פרויקט. מה הגרסה הכי קטנה של הבלוק הזה, משהו שאפשר להתחיל בעוד דקה?</p><input name="title" required placeholder="למשל: לפנות רק מדף אחד"><div class="f-row"><button class="b-light">זה הצעד עכשיו</button><button type="button" class="b-link" data-act="cancel">ביטול</button></div></form>`:''}
  ${missedLine}
</section>`;
}
function weekView(){
  if(!cal.blocks.length)return '';
  const n=Date.now(),end=today();end.setDate(end.getDate()+7);
  const items=cal.blocks.filter(b=>b.start>=today()&&b.start<end);   // past blocks with no status are in the tray
  const note=cal.status==='ok'?`מסונכרן עם Google Calendar, עודכן ב־${hm(new Date(cal.storedAt||Date.now()))}`:`${esc(cal.msg)} מוצג הלו״ז שנטען ב־${hm(new Date(cal.storedAt))}.`;
  const groups=[];items.forEach(b=>{const k=iso(b.start);let g=groups.find(x=>x.k===k);if(!g){g={k,d:b.start,list:[]};groups.push(g);}g.list.push(b);});
  return `<section class="sec" id="week"><div class="sec-head"><h2>הלו״ז הקרוב ביומן</h2>${calButton('b-link')}</div><p class="cal-note">${note}</p>
  <div class="wk">${groups.map(g=>`<div class="wk-day"><h3>${esc(dayLabel(g.d))}${dayLabel(g.d).startsWith('יום')?'':` <span class="muted">${DAYS[g.d.getDay()]} ${g.d.getDate()}.${g.d.getMonth()+1}</span>`}</h3><ul>${g.list.map(b=>{const done=isDone(b),st=ST[blk(b.id).status],wait=!st&&b.end<=n;
    return `<li class="${done?'done':''}"><label><input type="checkbox" data-act="ev-toggle" data-e="${esc(b.id)}"${done?' checked':''}><span class="wk-time">${hm(b.start)}</span><span class="wk-t">${esc(b.title)}</span></label><span class="wk-s">${esc(names(b))}</span>${b.link?`<a class="wk-cal" href="${esc(b.link)}" target="_blank" rel="noopener">פתח ביומן</a>`:''}${st&&!done?`<span class="chip ${st[1]}">${st[0]}</span>`:''}${wait?'<span class="chip calm">מחכה לסימון</span>':''}<button class="b-link wk-open" data-act="run" data-e="${esc(b.id)}">פתח</button></li>`;}).join('')}</ul></div>`).join('')||'<p class="muted">אין בלוקים בשבוע הקרוב.</p>'}</div></section>`;
}
function allOpen(){const a=[];state.streams.forEach(s=>counted(s).forEach(m=>{if(!m.done&&m.date)a.push({m,s});}));return a.sort((x,y)=>byDate(x.m,y.m));}
function upcoming(){
  const items=allOpen().slice(0,5);
  if(!items.length)return '';
  return `<section class="sec"><h2>הדד־ליינים הקרובים</h2><ul class="up">${items.map(({m,s})=>{const d=daysUntil(m.date);return `<li><span class="chip ${urg(d)}">${rel(d)}</span><span class="up-t">${esc(m.title)}</span><button class="chk" data-act="ms-done" data-s="${s.id}" data-m="${m.id}">בוצע</button><span class="up-s">${esc(s.name)}, ${fmt(m.date)}</span></li>`;}).join('')}</ul></section>`;
}
function timeline(){
  const P=state.project,dated=[];
  state.streams.forEach(s=>s.milestones.forEach(m=>{if(m.date)dated.push(m);}));
  const endDate=(P.decision&&P.decision.date)||dated.map(m=>m.date).sort().pop();
  if(!endDate)return '';
  let start=today();dated.forEach(m=>{if(parse(m.date)<start)start=parse(m.date);});
  const end=parse(endDate);const total=Math.max(end-start,86400000);
  const pos=d=>Math.min(100,Math.max(0,(parse(d)-start)/total*100));
  const groups={};dated.forEach(m=>{(groups[m.date]=groups[m.date]||[]).push(m);});
  const dots=Object.keys(groups).map(d=>{const g=groups[d],open=g.filter(m=>!m.done);const cls=open.length?urg(daysUntil(d)):'done';
    const tip=fmt(d)+': '+g.map(m=>m.title+(m.done?' (בוצע)':'')).join(', ');
    return `<span class="tl-dot ${cls}" style="inset-inline-start:${pos(d)}%" title="${esc(tip)}" role="img" aria-label="${esc(tip)}">${g.length>1?g.length:''}</span>`;}).join('');
  // Ticks on the 1st and 15th of each month, plus the end date (for Madrid: the artifact's 1.10, 15.10, 1.11, 14.11).
  const tickDates=[];for(let d=new Date(start.getFullYear(),start.getMonth(),1);d<=end;d.setMonth(d.getMonth()+1)){tickDates.push(iso(d));tickDates.push(iso(new Date(d.getFullYear(),d.getMonth(),15)));}
  tickDates.push(endDate);
  const ticks=[...new Set(tickDates)].sort().filter(d=>parse(d)>=start&&parse(d)<=end).map(d=>`<span class="tl-tick" style="inset-inline-start:${pos(d)}%">${fmt(d)}</span>`).join('');
  const tp=Math.min(100,Math.max(0,(today()-start)/total*100));
  return `<section class="sec"><h2>ציר הזמן</h2><div class="tl-scroll"><div class="tl">
  <div class="tl-axis"></div>
  ${P.buffer?`<div class="tl-band" style="inset-inline-start:${pos(P.buffer.from)}%;width:${pos(P.buffer.to)-pos(P.buffer.from)+1}%" title="באפר: מסירה ואריזה בלבד"></div>`:''}
  <div class="tl-mark today" style="inset-inline-start:${tp}%"><span>היום</span></div>
  ${P.flight?`<div class="tl-mark flight" style="inset-inline-start:${pos(P.flight)}%"><span>טיסה</span></div>`:''}
  ${P.decision?'<div class="tl-mark decide" style="inset-inline-start:100%"><span>החלטה</span></div>':''}
  ${dots}${ticks}</div></div></section>`;
}
function ragLine(s){
  const g=nextGate(),r=ragOf(s,g);
  return r?`<p class="prog-meta rag-line">${dot(r.color)}<span>עד ${esc(g.id)} (${fmt(g.date)}): ${ragText(r)}</span></p>`:'';
}
function progress(s){
  const ms=counted(s),md=ms.filter(m=>m.done).length,mt=ms.length;
  const bl=blocksOf(s.id);
  if(!bl.length){
    if(!mt)return ragLine(s);
    const pct=Math.round(md/mt*100);
    return `<div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="התקדמות ${esc(s.name)}"><div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div><span class="prog-n">${pct}%</span></div><p class="prog-meta">אבני דרך: ${md} מתוך ${mt}</p>${ragLine(s)}`;
  }
  const done=bl.filter(isDone).length,total=bl.length,pct=Math.round(done/total*100);
  return `<div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="התקדמות ${esc(s.name)}"><div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div><span class="prog-n">${pct}%</span></div>
  <p class="prog-meta">${done} מתוך ${total} בלוקים ביומן${mt?`. אבני דרך: ${md} מתוך ${mt}`:''}</p>${ragLine(s)}`;
}
/* Per-stream links live in the document: streams[].links = [{label, url}]. Only http(s) addresses
   become links; anything else is skipped with one warning per address. */
const warnedLinks=new Set();
function streamLinks(s){
  if(!Array.isArray(s.links))return '';
  const a=s.links.map(l=>{const u=String((l&&l.url)||'');
    if(!/^https?:\/\/\S+$/i.test(u)){if(!warnedLinks.has(s.id+' '+u)){warnedLinks.add(s.id+' '+u);console.warn('projects-app: skipped a link that is not http(s) in stream '+s.id);}return '';}
    return `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(String(l.label||'').trim()||u)}</a>`;}).join('');
  return a?`<div class="st-links">${a}</div>`:'';
}
function streamView(s){
  const open=!!ui.open[s.id],n=Date.now();
  const ms=s.milestones.slice().sort((a,b)=>(a.done-b.done)||byDate(a,b));
  const shown=open?ms:ms.filter(m=>!m.done).slice(0,2);
  const nb=blocksOf(s.id).find(b=>b.end>n&&!isConfirmed(b)),na=streamNext(s.id);
  const left=na?`<div class="st-next st-na"><span class="lbl">הצעד הבא שנשאר:</span><span class="t">${esc(na.nextAction)}</span>${na.blocker?`<span class="mins">חסם: ${esc(na.blocker)}</span>`:''}</div>`:'';
  const next=cal.blocks.length?`<div class="st-next"><span class="lbl">הבלוק הבא:</span>${nb?`<span class="t">${esc(nb.title)}</span><span class="mins">${esc(whenLabel(nb))}, ${mins(nb)} דק׳</span>`:'<span class="t">אין בלוקים עתידיים ביומן</span>'}</div>`:'';
  let habit='';
  if(s.habit&&cal.blocks.length){
    const ws=weekStart(),we=new Date(ws);we.setDate(we.getDate()+7);
    const wb=blocksOf(s.id).filter(b=>b.start>=ws&&b.start<we);
    const c=wb.filter(isDone).length;
    habit=`<div class="habit"><span>השבוע: ${c} מתוך ${wb.length}</span><div class="dots">${wb.map(b=>`<button class="dot${isDone(b)?' on':''}" data-act="ev-flip" data-e="${esc(b.id)}" aria-pressed="${isDone(b)}" aria-label="ספרדית ${esc(whenLabel(b))}" title="${esc(whenLabel(b))}"></button>`).join('')}</div><p class="habit-f">${esc(s.habit.focus)}</p></div>`;
  }
  const list=shown.length?`<ul class="ms">${shown.map(m=>{const d=m.date?daysUntil(m.date):null;
    if(open&&ui.editMs===eKey(s.id,m.id))return `<li><form class="form" data-form="ms-edit" data-s="${s.id}" data-m="${m.id}"><input name="title" value="${esc(m.title)}" required maxlength="${MAX_LEN.title}" aria-label="שם אבן הדרך"><input name="date" type="date" value="${esc(m.date||'')}" aria-label="תאריך"><button class="b-sec">שמור</button><button type="button" class="b-link" data-act="edit-cancel">ביטול</button></form></li>`;
    return `<li class="${m.done?'done':''}"><label><input type="checkbox" data-act="ms-toggle" data-s="${s.id}" data-m="${m.id}"${m.done?' checked':''}><span class="ms-t">${esc(m.title)}</span></label>${m.rag===false?'<span class="chip calm">לא נספר</span>':''}${m.date?(m.done?`<span class="ms-d">${fmt(m.date)}</span>`:`<span class="ms-d">${fmt(m.date)}</span><span class="chip ${urg(d)}">${rel(d)}</span>`):''}${open?`${ui.confirmDel===eKey('ms',s.id,m.id)?'':`<button class="b-link ms-ed" data-act="ms-edit" data-s="${s.id}" data-m="${m.id}" aria-label="עריכה: ${esc(m.title)}">עריכה</button>`}${delButton(eKey('ms',s.id,m.id),'ms-del',`data-s="${s.id}" data-m="${m.id}"`,'מחק')}`:''}</li>`;}).join('')}</ul>`:'';
  const moreBtn=(ms.length>shown.length||open)?`<button class="b-link more" data-act="more" data-s="${s.id}">${open?'פחות':`כל אבני הדרך (${ms.length})`}</button>`:(!ms.length&&!s.habit?`<button class="b-link more" data-act="more" data-s="${s.id}">הוסף אבן דרך</button>`:'');
  const add=open?`<form class="form" data-form="add-ms" data-s="${s.id}"><input name="title" required maxlength="${MAX_LEN.title}" placeholder="אבן דרך חדשה"><input name="date" type="date" aria-label="תאריך"><button class="b-sec">הוסף</button></form>${depEditor(s)}${linksEditor(s)}`:'';
  return `<article class="st st-${s.status}" id="st-${esc(s.id)}">
  <div class="st-head"><h3>${inRag(s)&&nextGate()?dot(ragOf(s,nextGate()).color):''}${esc(s.name)}${s.critical?' <span class="chip calm">Critical</span>':''}</h3><div class="st-tools">
    <select class="st-status" data-act="status" data-s="${s.id}" aria-label="סטטוס">${Object.keys(STATUS).map(k=>`<option value="${k}"${k===s.status?' selected':''}>${STATUS[k]}</option>`).join('')}</select>
    ${s.habit?'':`<button class="tog" data-act="heavy" data-s="${s.id}" aria-pressed="${!!s.heavy}">מוקד כבד</button>`}
    <button class="b-link st-edit" data-act="more" data-s="${s.id}" aria-expanded="${open}">${open?'סיום עריכה':'עריכה'}</button>
  </div></div>${streamLinks(s)}${progress(s)}${left}${next}${habit}${list}${moreBtn}${add}</article>`;
}
function streams(){
  const h=state.streams.filter(s=>s.heavy).length;
  return `<section class="sec"><h2>המסלולים</h2><p class="heavy-note">מוקדים כבדים השבוע: ${h} מתוך ${state.maxHeavy}</p>${ui.warn?`<p class="warn" role="alert">${esc(ui.warn)}</p>`:''}${state.streams.map(streamView).join('')}</section>`;
}
function logView(){
  const L=state.log;
  if(!L.length)return `<section class="sec"><h2>מה כבר עשיתי</h2><p class="muted">כל בלוק שתסמן כבוצע יופיע כאן.</p></section>`;
  const items=(ui.showLog?L:L.slice(-5)).slice().reverse();
  return `<section class="sec"><h2>מה כבר עשיתי (${L.length})</h2><ul class="log">${items.map(x=>`<li><span class="ms-d">${fmt(x.d)}</span><span>${esc(x.t)}</span><span class="muted">${esc((S(x.s)||{}).name||'')}</span></li>`).join('')}</ul>${L.length>5?`<button class="b-link" style="color:var(--cobalt)" data-act="log">${ui.showLog?'פחות':'הכול'}</button>`:''}</section>`;
}
function rulesView(){
  const P=state.project;
  return `<section class="sec rules"><h2>הכללים</h2><ul>${(state.rules||[]).map(r=>`<li>${esc(r)}</li>`).join('')}${P.decision?`<li>${fmt(P.decision.date)}: נקודת החלטה. ${esc(P.decision.question)}</li>`:''}</ul>
  ${(P.success||[]).length?`<h3>הצלחה עד הטיסה</h3><ul>${P.success.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>`:''}
  <button class="b-sec" data-act="export">${ui.exp?'הסתר נתונים':'ייצוא נתונים (JSON)'}</button>${ui.exp?`<textarea class="export" readonly aria-label="נתוני הדשבורד">${esc(JSON.stringify(state,null,2))}</textarea>`:''}</section>`;
}
function loginView(){
  return `<main class="login"><h1>Projects app</h1><p class="login-sub">הדשבורד פרטי. צריך להתחבר כדי להמשיך.</p>
  <form class="login-form" data-form="login" novalidate>
    <label for="email">אימייל</label><input type="email" id="email" name="email" dir="ltr" autocomplete="username" required>
    <label for="password">סיסמה</label><input type="password" id="password" name="password" dir="ltr" autocomplete="current-password" required>
    <p class="login-err" id="login-err" role="alert" hidden></p>
    <button class="b-primary" id="login-btn">כניסה</button>
  </form></main>`;
}
const BOOT={auth:'טוען…',loading:'טוען את הנתונים…',offline:'אין חיבור לשרת. מנסה שוב…',empty:'אין עדיין פרויקטים',error:'לא הצלחתי לטעון את הנתונים'};
function bootView(){
  return `<section class="sec boot" aria-live="polite"><h2>${BOOT[view]}</h2>${viewMsg?`<p class="muted">${esc(viewMsg)}</p>`:''}${view==='empty'||view==='error'?'<button class="b-link out" data-act="signout">התנתקות</button>':''}</section>`;
}
const ready=()=>listed!==null&&listed.length>0&&view!=='error'&&listed.every(id=>projects[id]&&projects[id].state&&projects[id].blocks);
function readRoute(){const m=location.hash.match(/^#\/p\/([^/]+)$/);route=m?{name:'project',id:decodeURIComponent(m[1])}:{name:'home'};}
function render(){
  if(!ready()){app.innerHTML=view==='login'?loginView():bootView();return;}
  const p=route.name==='project'&&projects[route.id];
  if(p){const top=trayView([route.id])+orphansView([route.id])+criticalBanner([route.id])+runnerView([route.id]);use(route.id);app.innerHTML=bar(true)+top+projectPage();}
  else app.innerHTML=homeView();
  tick();
}

/* events */
function focusIn(sel){const el=app.querySelector(sel);if(el)el.focus();}
// Before any handler: act on the project the element belongs to.
function useFor(el){const h=el.closest('[data-p]');if(h&&projects[h.dataset.p]&&projects[h.dataset.p].state)use(h.dataset.p);}
app.addEventListener('click',e=>{
  // In-page links (#week, #st-<stream>) scroll; only #/... changes the route.
  const link=e.target.closest('a[href^="#"]');
  if(link&&!link.getAttribute('href').startsWith('#/')){e.preventDefault();const el=document.getElementById(link.getAttribute('href').slice(1));if(el)el.scrollIntoView({behavior:'smooth',block:'start'});return;}
  const b=e.target.closest('[data-act]');if(!b||b.tagName==='SELECT'||b.type==='checkbox')return;
  if(b.dataset.act==='signout'){signOut();return;}
  useFor(b);
  const a=b.dataset.act,s=S(b.dataset.s),id=b.dataset.e;
  if(ui.confirmDel&&!/-del$/.test(a))ui.confirmDel=null;   // any other tap drops a pending delete
  const m=s&&b.dataset.m?s.milestones.find(x=>x.id===b.dataset.m):null;
  switch(a){
    case 'timer':{const t=getTimer();if(t&&t.event===id)setTimer(null);else setTimer({start:Date.now(),minutes:+b.dataset.min||30,event:id});render();break;}
    case 'ev-done':setDone(id,true);break;
    case 'ev-flip':setDone(id,!isDone({id}));break;
    case 'run':ui.run={p:cur,e:id};ui.ask=null;ui.editPlan=false;render();{const el=document.getElementById('runner');if(el)el.scrollIntoView({block:'start'});}break;
    case 'gate':ui.gateWarn=null;ui.gate=ui.gate&&ui.gate.p===cur&&ui.gate.g===b.dataset.g?null:{p:cur,g:b.dataset.g};render();break;
    case 'run-close':ui.run=null;ui.ask=null;render();break;
    case 'bk-done':confirmBlock(id,'done');break;
    case 'bk-ask':ui.ask={k:eKey(id),st:b.dataset.st==='skipped'?'skipped':'partial',w:b.dataset.w};render();focusIn('.bk-ask input');break;
    case 'bk-undo':confirmBlock(id,'planned');break;
    case 'plan-edit':ui.editPlan=!ui.editPlan;render();break;
    case 'tb-stop':{const t=getTimer();if(t&&t.event===id)setTimer(null);saveBlock(id,{timeboxStopped:true});break;}
    case 'ck-del':{const i=+b.dataset.i,l=(blk(id).checklist||[]).slice();if(l[i]&&confirmDel(eKey('ck',id,i))){l.splice(i,1);saveBlock(id,{checklist:l});}break;}
    case 'stuck-ask':ui.stuck=true;render();const el=app.querySelector('form[data-form="stuck"] input');if(el)el.focus();break;
    case 'cancel':ui.stuck=false;render();break;
    case 'refresh':refreshCalendar();break;
    case 'cal-connect':connectCalendar();break;
    case 'heavy':if(!s.heavy&&state.streams.filter(x=>x.heavy).length>=state.maxHeavy){ui.warn=`כבר יש ${state.maxHeavy} מוקדים כבדים. תוריד אחד לפני שמוסיפים.`;render();}else{s.heavy=!s.heavy;ui.warn=null;commit();}break;
    case 'ms-done':if(m){m.done=true;commit();}break;
    case 'ms-del':if(m&&confirmDel(eKey('ms',s.id,m.id))){s.milestones=s.milestones.filter(x=>x!==m);commit();}break;
    case 'del-cancel':render();break;
    case 'more':ui.open[s.id]=!ui.open[s.id];render();break;
    case 'log':ui.showLog=!ui.showLog;render();break;
    case 'export':ui.exp=!ui.exp;render();break;
    case 'edit-project':ui.editP=ui.editP===cur?null:cur;ui.editSc=null;ui.keyDraft=null;ui.keyConfirm=null;ui.warnP=null;render();break;
    case 'edit-cancel':ui.editSc=ui.editMs=ui.editLink=ui.ask=null;render();break;
    case 'sc-edit':ui.editSc=eKey(+b.dataset.i);render();focusIn('[data-form="sc-edit"] input');break;
    case 'sc-del':{const sc=state.project.success||[],i=+b.dataset.i;if(sc[i]!==undefined&&confirmDel(eKey('sc',i))){sc.splice(i,1);ui.editSc=null;commit();}break;}
    case 'ms-edit':if(m){ui.editMs=eKey(s.id,m.id);render();focusIn('[data-form="ms-edit"] input');}break;
    case 'link-edit':ui.editLink=eKey(s.id,+b.dataset.i);render();focusIn('[data-form="link-edit"] input');break;
    case 'link-del':{const i=+b.dataset.i;if(s&&s.links&&s.links[i]&&confirmDel(eKey('link',s.id,i))){s.links.splice(i,1);if(!s.links.length)delete s.links;ui.editLink=null;commit();}break;}
    case 'pause':state.project.status='paused';ui.warnP=null;commit();break;
    case 'activate':if(activeIds().length>=MAX_ACTIVE){ui.warnP=`כבר יש ${MAX_ACTIVE} פרויקטים פעילים. תקפיא אחד לפני שמפעילים עוד.`;render();}else{state.project.status='active';ui.warnP=null;commit();if(gcal.tokenState()==='valid')refreshCalendar();}break;
  }
});
app.addEventListener('change',e=>{
  const t=e.target,a=t.dataset.act;if(!a)return;useFor(t);const s=S(t.dataset.s);
  if(a==='status'){s.status=t.value;commit();}
  else if(a==='ms-toggle'){const m=s.milestones.find(x=>x.id===t.dataset.m);if(m){m.done=t.checked;commit();}}
  else if(a==='ev-toggle')setDone(t.dataset.e,t.checked);
  else if(a==='dep'){if(s&&(t.dataset.k==='open'||t.dataset.k==='hasAlternative')){s.externalDependency=Object.assign({open:false,hasAlternative:false},s.externalDependency,{[t.dataset.k]:t.checked});commit();}}
  else if(a==='gate-met'){const g=gates[t.dataset.g],cr=g&&(g.criteria||[]).map(c=>Object.assign({},c)),c=cr&&cr[+t.dataset.i];if(c){
    // Ticking is refused while the gate's window has awaiting blocks, or when the calendar was never loaded (unknown). Unticking always works.
    if(t.checked&&(!cal.storedAt||gateWaiting(Object.assign({},g,{id:t.dataset.g})).length)){ui.gateWarn={p:cur,g:t.dataset.g};render();return;}
    ui.gateWarn=null;c.met=t.checked;c.metOn=t.checked?iso(today()):null;putDoc('gates',t.dataset.g,{criteria:cr});render();}}
  else if(a==='ck-toggle'){const l=(blk(t.dataset.e).checklist||[]).map(c=>Object.assign({},c)),c=l[+t.dataset.i];if(c){c.done=t.checked;saveBlock(t.dataset.e,{checklist:l});}}
});
// The calendar key's match count updates while typing, in place, so the field keeps its focus.
app.addEventListener('input',e=>{
  const t=e.target;if(t.dataset.act!=='key-input')return;useFor(t);
  ui.keyDraft=t.value;ui.keyConfirm=null;const kn=keyNote(t.value);
  const out=app.querySelector('#key-count'),btn=app.querySelector('#key-save');
  if(out){out.className=kn.warn?'warn':'ed-ok';out.textContent=kn.text;}if(btn)btn.textContent='שמור';
});
app.addEventListener('submit',e=>{
  e.preventDefault();const f=e.target,d=new FormData(f);
  if(f.dataset.form==='login'){login(d);return;}
  useFor(f);
  const v=k=>String(d.get(k)||'').trim(),s=f.dataset.s?S(f.dataset.s):null;
  switch(f.dataset.form){
    case 'name':if(v('name')){state.project.name=v('name').slice(0,MAX_LEN.title);commit();}return;
    case 'goal':state.project.goal=v('goal').slice(0,MAX_LEN.text);commit();return;
    case 'sc-add':if(v('text')){(state.project.success=state.project.success||[]).push(v('text').slice(0,MAX_LEN.text));commit();}return;
    case 'sc-edit':{const sc=state.project.success||[],i=+f.dataset.i;if(v('text')&&sc[i]!==undefined){sc[i]=v('text').slice(0,MAX_LEN.text);ui.editSc=null;commit();}return;}
    case 'key':saveKey(f,v('key'));return;
    case 'ms-edit':{const m=s&&s.milestones.find(x=>x.id===f.dataset.m);if(m&&v('title')){m.title=v('title').slice(0,MAX_LEN.title);m.date=isDate(v('date'))?v('date'):null;ui.editMs=null;commit();}return;}
    case 'link-add':case 'link-edit':if(s)saveLink(f,s,v('label'),v('url'));return;
    case 'bk-status':if(v('next'))confirmBlock(f.dataset.e,f.dataset.st==='skipped'?'skipped':'partial',{nextAction:v('next').slice(0,MAX_LEN.text),blocker:v('blocker').slice(0,MAX_LEN.text)||null});return;
    case 'bk-plan':{const o={};PLAN.forEach(([k])=>{o[k]=v(k).slice(0,MAX_LEN.text)||null;});ui.editPlan=false;saveBlock(f.dataset.e,o);return;}
    case 'ck-add':{const l=(blk(f.dataset.e).checklist||[]).slice();if(v('text')&&l.length<MAX_CHECK){l.push({id:uid(),text:v('text').slice(0,MAX_LEN.title),done:false});saveBlock(f.dataset.e,{checklist:l});}return;}
  }
  const title=String(d.get('title')||'').trim();if(!title)return;
  if(f.dataset.form==='stuck'){state.stuck[f.dataset.e]=title;ui.stuck=false;}
  else if(f.dataset.form==='add-ms'){S(f.dataset.s).milestones.push({id:uid(),date:String(d.get('date')||'')||null,title,done:false});}
  commit();
});

/* sign-in and first load: nothing is read and nothing renders until Firebase Auth has an answer */
const LOGIN_ERR={
  'auth/invalid-credential':'אימייל או סיסמה שגויים.',
  'auth/wrong-password':'אימייל או סיסמה שגויים.',
  'auth/user-not-found':'אימייל או סיסמה שגויים.',
  'auth/invalid-email':'כתובת אימייל לא תקינה.',
  'auth/too-many-requests':'יותר מדי ניסיונות. נסה שוב בעוד כמה דקות.',
  'auth/network-request-failed':'אין חיבור לרשת. בדוק את החיבור ונסה שוב.'
};
function login(d){
  const err=document.getElementById('login-err'),btn=document.getElementById('login-btn');
  err.hidden=true;btn.disabled=true;
  signIn(String(d.get('email')||'').trim(),String(d.get('password')||'')).catch(e=>{
    console.error('projects-app: sign-in failed',e&&e.code);
    err.textContent=LOGIN_ERR[e&&e.code]||'משהו השתבש. נסה שוב.';err.hidden=false;btn.disabled=false;
  });
}
async function signOut(){
  try{await Promise.all(Object.values(projects).filter(p=>p.sync).flatMap(p=>[p.sync.flushAndWait(),...Object.values(p.syncs).map(x=>x.wait())]));}catch(e){console.error('projects-app: saving before sign-out failed',e);}
  eachSync(s=>s.discardBackup());Object.values(projects).forEach(p=>Object.values(p.syncs).forEach(x=>x.discardBackup()));  // nothing of this account's data stays in the browser
  try{await signOutUser();}catch(e){console.error('projects-app: sign-out failed',e);}
  location.reload();
}
let signedIn=false;
watchAuth(user=>{
  if(!user){if(signedIn)location.reload();else{view='login';render();}return;}
  if(signedIn)return;
  signedIn=true;view='loading';render();
  startCalendar();
  watchProjects(user.uid,{
    onList:ids=>syncList(user.uid,ids),
    onOffline:()=>{if(listed===null){view='offline';render();}},
    onError:showError
  });
});
function showError(err){view='error';viewMsg=(err&&err.code==='permission-denied'?'אין הרשאה (permission-denied). ייתכן שחוקי Firestore או ה־UID בהם לא מעודכנים.':'שגיאה: '+((err&&(err.code||err.message))||'לא ידועה'))+' רענן את העמוד כדי לנסות שוב.';render();}
// Opens a listener for each new project in the list and closes the ones that left it.
function syncList(userId,ids){
  listed=ids.slice();
  ids.forEach(id=>{if(projects[id])return;const p=projects[id]={id,state:null,sync:null,blocks:null,gates:null,syncs:{},snap:{},over:{blocks:{},gates:{}}};
    p.sync=openProject(userId,id,{
      onData:data=>{data.doneEvents=data.doneEvents||{};data.stuck=data.stuck||{};if(!loadedIds().length)setStatus('נשמר בענן');p.state=data;if(cur===id)state=data;render();},
      onMissing:()=>dropProject(id),   // deleted: drop it, never recreate it
      onOffline:()=>{},
      onError:showError,
      onSaveState:saveStateOf(id)
    });
    p.syncs.blocks=openBlocks(userId,id,{
      onData:(b,changed)=>{const first=!p.blocks;p.snap.blocks=b;p.blocks=withOver(p,'blocks');point(p);if(first)fillFacts();if(first||changed)render();},   // no redraw for the echo of a write
      onError:showError,
      onSaveState:saveStateOf(id+'/blocks')
    });
    p.syncs.gates=openSub(userId,id,'gates',{
      onData:(g,changed)=>{p.snap.gates=g;p.gates=withOver(p,'gates');point(p);if(changed)render();},
      onError:showError,
      onSaveState:saveStateOf(id+'/gates')
    });});
  Object.keys(projects).forEach(id=>{if(!ids.includes(id))dropProject(id);});
  if(!ids.length&&view!=='error')view='empty';
  render();
}
function dropProject(id){
  const p=projects[id];if(!p)return;
  p.sync.close();Object.values(p.syncs).forEach(x=>x.close());delete projects[id];delete saveStates[id];delete saveStates[id+'/blocks'];delete saveStates[id+'/gates'];
  if(listed)listed=listed.filter(x=>x!==id);
  if(cur===id){cur=null;state=null;}
  if(listed&&!listed.length&&view!=='error')view='empty';
  render();
}
readRoute();
window.addEventListener('hashchange',()=>{if(location.hash&&!location.hash.startsWith('#/'))return;readRoute();ui.warnP=null;render();window.scrollTo(0,0);});
