/* Projects app: the dashboard.
   Views, events, toBlocks and the timer are the claude.ai artifact's code. What changed is where the
   data lives: each project is a Firestore document (firebase.js) instead of JSON inside the page,
   and the calendar is read from Google Calendar directly (calendar.js) instead of through claude.ai.
   Since v1.2 there can be several projects. The artifact's views draw "the current project": use(id)
   points `state` and cal.blocks at one project before its views run, and every event handler first
   calls use() for the project its element belongs to (the nearest [data-p]). */
import {watchAuth,signIn,signOutUser,watchProjects,openProject} from './firebase.js';
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

const projects={};           // id -> {id, state, sync}; state is null until its first snapshot
let listed=null;             // project ids in the list, null until the list arrives
let state=null;              // the current project's state (see use())
let cur=null;                // the current project's id
let route={name:'home'};     // #/ is home, #/p/<id> is one project
let view='auth',viewMsg='';  // what render() shows until every listed project has arrived

let ui={open:{},stuck:false,warn:null,showLog:false,exp:false,warnP:null,
  editP:null,editSc:null,editMs:null,editLink:null,keyDraft:null,keyConfirm:null,confirmDel:null};  // editing (v1.2)

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
  try{const items=await gcal.listEvents(calRange());cal={status:'ok',items,blocks:[],msg:'',storedAt:Date.now()};render();}
  catch(err){console.error('projects-app: calendar refresh failed',err);calFail(err);}
  finally{calBusy=false;}
}
function startCalendar(){
  gcal.init().catch(err=>console.error('projects-app: Google Identity Services did not load',err));
  gcal.onExpire(()=>{if(cal.status==='ok'||cal.status==='network'){cal=Object.assign({},cal,{status:'expired',msg:CAL_MSG.expired});render();}});
  setInterval(()=>{if(gcal.tokenState()==='valid')refreshCalendar();},600000);
}
const isDone=b=>!!state.doneEvents[b.id];
const blocksOf=id=>cal.blocks.filter(b=>b.streams.includes(id));
const missedBlocks=()=>{const n=Date.now();return cal.blocks.filter(b=>b.end<=n&&!isDone(b));};

/* projects */
function use(id){const p=projects[id];cur=id;state=p.state;cal.blocks=state?toBlocks({items:cal.items}):[];}
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
function tick(){const el=document.getElementById('timer');const t=getTimer();if(!el||!t)return;
  const left=t.start+t.minutes*60000-Date.now();
  if(left>0){const m=Math.floor(left/60000),s=Math.floor(left%60000/1000);el.textContent=m+':'+String(s).padStart(2,'0');el.classList.remove('over');}
  else{el.textContent='הזמן נגמר. מה הושלם, ומה נשאר?';el.classList.add('over');}}
setInterval(tick,1000);

/* actions on blocks */
function setDone(id,on){
  const b=cal.blocks.find(x=>x.id===id);
  if(on){state.doneEvents[id]=iso(today());if(b)state.log.push({d:iso(today()),t:b.title,s:b.streams[0]||'',e:id});}
  else{delete state.doneEvents[id];state.log=state.log.filter(x=>x.e!==id);}
  const t=getTimer();if(on&&t&&t.event===id)setTimer(null);
  commit();
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
/* A stream at a glance: the calendar-based numbers of progress(), or milestones when it has no blocks. */
function streamPace(s){
  const n=Date.now(),bl=blocksOf(s.id);
  if(bl.length){const done=bl.filter(isDone).length,behind=bl.filter(b=>b.end<=n&&!isDone(b)).length;return {pct:Math.round(done/bl.length*100),cls:behind>0?'behind':'ontrack',note:behind>0?(behind===1?'בלוק אחד מאחור':behind+' בלוקים מאחור'):'בזמן'};}
  const mt=s.milestones.length;if(!mt)return {pct:0,cls:'none',note:'אין בלוקים ביומן'};
  return {pct:Math.round(s.milestones.filter(m=>m.done).length/mt*100),cls:'none',note:'אין בלוקים ביומן'};
}
/* The project overview: the page's top panel, or a card on the home screen when card is true.
   A card is one link to the project, so nothing inside it is interactive. */
function overview(card){
  const P=state.project,n=Date.now(),id=esc(cur);
  const ms=state.streams.flatMap(s=>s.milestones),md=ms.filter(m=>m.done).length;
  const pct=ms.length?Math.round(md/ms.length*100):0;
  const ws=weekStart(),we=new Date(ws);we.setDate(we.getDate()+7);
  const wb=cal.blocks.filter(b=>b.start>=ws&&b.start<we);
  const week=cal.items.length||cal.status==='ok'?`<p class="ov-week">השבוע: ${wb.filter(isDone).length} מתוך ${wb.length} בלוקים</p>`:'';
  const dl=allOpen()[0];
  const nb=cal.blocks.find(b=>b.end>n&&!isDone(b));
  const missed=missedBlocks().length;
  const c=countdown(P);
  const tile=(lbl,val)=>`<div class="ov-tile"><span class="ov-lbl">${lbl}</span>${val}</div>`;
  const tiles=[
    tile('התקדמות',`<div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="אבני דרך שהושלמו"><div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div><span class="prog-n">${pct}%</span></div><p class="ov-sub">אבני דרך: ${md} מתוך ${ms.length}</p>${week}`),
    tile('הדד־ליין הבא',dl?`<span class="ov-val">${esc(dl.m.title)}</span><p class="ov-sub"><span class="chip ${urg(daysUntil(dl.m.date))}">${rel(daysUntil(dl.m.date))}</span> ${fmt(dl.m.date)}</p>`:'<span class="ov-val muted">אין דד־ליינים פתוחים</span>'),
    tile('הבלוק הבא',nb?`<span class="ov-val">${esc(nb.title)}</span><p class="ov-sub">${esc(nb.start<=n?'עכשיו, עד '+hm(nb.end):whenLabel(nb))}</p>`:`<span class="ov-val muted">${cal.items.length?'אין בלוקים עתידיים':'היומן לא נטען'}</span>`),
    tile('לא סומנו',`<span class="ov-val${missed?' ov-red':''}">${missed?(missed===1?'בלוק אחד עבר ולא סומן':missed+' בלוקים עברו ולא סומנו'):'הכול מסומן'}</span>${missed&&!card?'<p class="ov-sub"><a href="#week">לסמן מה בוצע</a></p>':''}`)
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
  const items=[];act.forEach(id=>{use(id);cal.blocks.filter(b=>b.start>=t0&&b.start<t1).forEach(b=>items.push({id,b,done:isDone(b),proj:state.project.name}));});
  items.sort((x,y)=>x.b.start-y.b.start);
  const multi=act.length>1;
  const list=items.map(({id,b,done,proj})=>{const missed=!done&&b.end<=n;
    return `<li class="${done?'done':''}${missed?' missed':''}" data-p="${esc(id)}"><label><input type="checkbox" data-act="ev-toggle" data-e="${esc(b.id)}"${done?' checked':''}><span class="wk-time">${hm(b.start)}</span><span class="wk-t">${esc(b.title)}</span></label>${multi?`<span class="wk-s">${esc(proj)}</span>`:''}${b.link?`<a class="wk-cal" href="${esc(b.link)}" target="_blank" rel="noopener">פתח ביומן</a>`:''}${missed?'<span class="chip red">עבר ולא סומן</span>':''}</li>`;}).join('');
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
function linksEditor(s){
  const L=s.links||[];
  const rows=L.map((l,i)=>ui.editLink===eKey(s.id,i)
    ?`<li><form class="form" data-form="link-edit" data-s="${esc(s.id)}" data-i="${i}" novalidate><input name="label" value="${esc(l&&l.label||'')}" maxlength="${MAX_LEN.label}" placeholder="שם הקישור" aria-label="שם הקישור"><input name="url" type="url" dir="ltr" value="${esc(l&&l.url||'')}" maxlength="${MAX_LEN.url}" placeholder="https://" aria-label="כתובת"><button class="b-sec">שמור</button><button type="button" class="b-link" data-act="edit-cancel">ביטול</button><p class="warn form-err" role="alert" hidden></p></form></li>`
    :`<li><span class="ed-t">${esc(l&&l.label||l&&l.url||'')}</span><span class="lk-u" dir="ltr">${esc(l&&l.url||'')}</span>${isUrl(String(l&&l.url||''))?'':'<span class="chip red">לא מוצג: לא http(s)</span>'}${ui.confirmDel===eKey('link',s.id,i)?'':`<button class="b-link" data-act="link-edit" data-s="${esc(s.id)}" data-i="${i}">עריכה</button>`}${delButton(eKey('link',s.id,i),'link-del',`data-s="${esc(s.id)}" data-i="${i}"`,'מחק קישור')}</li>`).join('');
  return `<div class="st-links-edit"><h4>קישורים</h4>${L.length?`<ul class="ed-list">${rows}</ul>`:''}
  <form class="form" data-form="link-add" data-s="${esc(s.id)}" novalidate><input name="label" maxlength="${MAX_LEN.label}" placeholder="שם הקישור" aria-label="שם הקישור החדש"><input name="url" type="url" dir="ltr" maxlength="${MAX_LEN.url}" placeholder="https://" aria-label="כתובת הקישור החדש"><button class="b-sec">הוסף קישור</button><p class="warn form-err" role="alert" hidden></p></form></div>`;
}
/* One project's full page: the overview panel, then the artifact's dashboard. */
function projectPage(extra){return `<div data-p="${esc(cur)}">${overview(false)}${ui.editP===cur?editPanel():''}${extra||''}${nowView()}${weekView()}${streams()}${upcoming()}${timeline()}${logView()}${rulesView()}</div>`;}
/* Cards: the nearest open deadline first, projects without one last, ties by name. */
const nextDeadline=id=>{use(id);const o=allOpen()[0];return o?o.m.date:'9999-12-31';};
function byDeadline(a,b){const x=nextDeadline(a),y=nextDeadline(b);return x<y?-1:x>y?1:projects[a].state.project.name.localeCompare(projects[b].state.project.name,'he');}
/* Home: today across projects, then the one active project's full page, or a card per active project. */
function homeView(){
  const act=activeIds();
  let h=bar(false)+todayView();
  if(act.length===1){use(act[0]);h+=projectPage(pausedView());}
  else{h+=act.length?`<section class="cards sec" aria-label="פרויקטים פעילים">${act.slice().sort(byDeadline).map(id=>{use(id);return overview(true);}).join('')}</section>`:'<p class="muted sec">אין פרויקטים פעילים.</p>';h+=pausedView();}
  return h;
}
const names=b=>b.streams.map(id=>(S(id)||{}).name).filter(Boolean).join(' + ');
function nowView(){
  if(cal.status==='loading')return `<section class="now"><div class="now-head"><span class="now-tag">הבלוק הבא</span></div><h2 class="now-title">טוען את הלו״ז מהיומן…</h2></section>`;
  if(!cal.blocks.length)return `<section class="now"><div class="now-head"><span class="now-tag">הבלוק הבא</span></div><h2 class="now-title">${cal.status==='ok'?`אין בלוקים של ${esc(state.project.calendarKey||state.project.name)} ביומן`:CAL_TITLE[cal.status]}</h2><p class="now-meta">${esc(cal.msg||'')}</p><div class="now-actions">${calButton('b-light')}</div></section>`;
  const n=Date.now();
  const b=cal.blocks.find(x=>x.start<=n&&x.end>n&&!isDone(x))||cal.blocks.find(x=>x.start>n&&!isDone(x));
  const missed=missedBlocks();
  const missedLine=missed.length?`<p class="now-missed">${missed.length===1?'בלוק אחד עבר ולא סומן':missed.length+' בלוקים עברו ולא סומנו'}. <a href="#week">לסמן מה בוצע</a></p>`:'';
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
  const items=cal.blocks.filter(b=>(b.end<=n&&!isDone(b))||(b.start>=today()&&b.start<end));
  const note=cal.status==='ok'?`מסונכרן עם Google Calendar, עודכן ב־${hm(new Date(cal.storedAt||Date.now()))}`:`${esc(cal.msg)} מוצג הלו״ז שנטען ב־${hm(new Date(cal.storedAt))}.`;
  const groups=[];items.forEach(b=>{const k=iso(b.start);let g=groups.find(x=>x.k===k);if(!g){g={k,d:b.start,list:[]};groups.push(g);}g.list.push(b);});
  return `<section class="sec" id="week"><div class="sec-head"><h2>הלו״ז הקרוב ביומן</h2>${calButton('b-link')}</div><p class="cal-note">${note}</p>
  <div class="wk">${groups.map(g=>`<div class="wk-day"><h3>${esc(dayLabel(g.d))}${dayLabel(g.d).startsWith('יום')?'':` <span class="muted">${DAYS[g.d.getDay()]} ${g.d.getDate()}.${g.d.getMonth()+1}</span>`}</h3><ul>${g.list.map(b=>{const done=isDone(b),missed=!done&&b.end<=n;
    return `<li class="${done?'done':''}${missed?' missed':''}"><label><input type="checkbox" data-act="ev-toggle" data-e="${esc(b.id)}"${done?' checked':''}><span class="wk-time">${hm(b.start)}</span><span class="wk-t">${esc(b.title)}</span></label><span class="wk-s">${esc(names(b))}</span>${b.link?`<a class="wk-cal" href="${esc(b.link)}" target="_blank" rel="noopener">פתח ביומן</a>`:''}${missed?'<span class="chip red">עבר ולא סומן</span>':''}</li>`;}).join('')}</ul></div>`).join('')||'<p class="muted">אין בלוקים בשבוע הקרוב.</p>'}</div></section>`;
}
function allOpen(){const a=[];state.streams.forEach(s=>s.milestones.forEach(m=>{if(!m.done&&m.date)a.push({m,s});}));return a.sort((x,y)=>byDate(x.m,y.m));}
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
function progress(s){
  const n=Date.now(),md=s.milestones.filter(m=>m.done).length,mt=s.milestones.length;
  const bl=blocksOf(s.id);
  if(!bl.length){
    if(!mt)return '';
    const pct=Math.round(md/mt*100);
    return `<div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="התקדמות ${esc(s.name)}"><div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div><span class="prog-n">${pct}%</span></div><p class="prog-meta">אבני דרך: ${md} מתוך ${mt}</p>`;
  }
  const done=bl.filter(isDone).length,exp=bl.filter(b=>b.end<=n).length,total=bl.length;
  const pct=Math.round(done/total*100),ep=Math.round(exp/total*100);
  const behind=exp-bl.filter(b=>b.end<=n&&isDone(b)).length;
  const pace=behind>0?`<span class="behind">${behind===1?'בלוק אחד מאחור':behind+' בלוקים מאחור'}</span>`:'<span class="ontrack">בזמן</span>';
  return `<div class="prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="התקדמות ${esc(s.name)}"><div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div>${exp&&exp<total?`<span class="prog-exp" style="inset-inline-start:${ep}%" title="איפה היית אמור להיות לפי היומן"></span>`:''}</div><span class="prog-n">${pct}%</span></div>
  <p class="prog-meta">${done} מתוך ${total} בלוקים ביומן. ${pace}${mt?`. אבני דרך: ${md} מתוך ${mt}`:''}</p>`;
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
  const nb=blocksOf(s.id).find(b=>b.end>n&&!isDone(b));
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
    return `<li class="${m.done?'done':''}"><label><input type="checkbox" data-act="ms-toggle" data-s="${s.id}" data-m="${m.id}"${m.done?' checked':''}><span class="ms-t">${esc(m.title)}</span></label>${m.date?(m.done?`<span class="ms-d">${fmt(m.date)}</span>`:`<span class="ms-d">${fmt(m.date)}</span><span class="chip ${urg(d)}">${rel(d)}</span>`):''}${open?`${ui.confirmDel===eKey('ms',s.id,m.id)?'':`<button class="b-link ms-ed" data-act="ms-edit" data-s="${s.id}" data-m="${m.id}" aria-label="עריכה: ${esc(m.title)}">עריכה</button>`}${delButton(eKey('ms',s.id,m.id),'ms-del',`data-s="${s.id}" data-m="${m.id}"`,'מחק')}`:''}</li>`;}).join('')}</ul>`:'';
  const moreBtn=(ms.length>shown.length||open)?`<button class="b-link more" data-act="more" data-s="${s.id}">${open?'פחות':`כל אבני הדרך (${ms.length})`}</button>`:(!ms.length&&!s.habit?`<button class="b-link more" data-act="more" data-s="${s.id}">הוסף אבן דרך</button>`:'');
  const add=open?`<form class="form" data-form="add-ms" data-s="${s.id}"><input name="title" required maxlength="${MAX_LEN.title}" placeholder="אבן דרך חדשה"><input name="date" type="date" aria-label="תאריך"><button class="b-sec">הוסף</button></form>${linksEditor(s)}`:'';
  return `<article class="st st-${s.status}" id="st-${esc(s.id)}">
  <div class="st-head"><h3>${esc(s.name)}</h3><div class="st-tools">
    <select class="st-status" data-act="status" data-s="${s.id}" aria-label="סטטוס">${Object.keys(STATUS).map(k=>`<option value="${k}"${k===s.status?' selected':''}>${STATUS[k]}</option>`).join('')}</select>
    ${s.habit?'':`<button class="tog" data-act="heavy" data-s="${s.id}" aria-pressed="${!!s.heavy}">מוקד כבד</button>`}
    <button class="b-link st-edit" data-act="more" data-s="${s.id}" aria-expanded="${open}">${open?'סיום עריכה':'עריכה'}</button>
  </div></div>${streamLinks(s)}${progress(s)}${next}${habit}${list}${moreBtn}${add}</article>`;
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
const ready=()=>listed!==null&&listed.length>0&&view!=='error'&&listed.every(id=>projects[id]&&projects[id].state);
function readRoute(){const m=location.hash.match(/^#\/p\/([^/]+)$/);route=m?{name:'project',id:decodeURIComponent(m[1])}:{name:'home'};}
function render(){
  if(!ready()){app.innerHTML=view==='login'?loginView():bootView();return;}
  const p=route.name==='project'&&projects[route.id];
  if(p){use(route.id);app.innerHTML=bar(true)+projectPage();}
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
    case 'ev-flip':setDone(id,!state.doneEvents[id]);break;
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
    case 'edit-cancel':ui.editSc=ui.editMs=ui.editLink=null;render();break;
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
  try{await Promise.all(Object.values(projects).filter(p=>p.sync).map(p=>p.sync.flushAndWait()));}catch(e){console.error('projects-app: saving before sign-out failed',e);}
  eachSync(s=>s.discardBackup());  // nothing of this account's data stays in the browser
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
  ids.forEach(id=>{if(projects[id])return;const p=projects[id]={id,state:null,sync:null};
    p.sync=openProject(userId,id,{
      onData:data=>{data.doneEvents=data.doneEvents||{};data.stuck=data.stuck||{};if(!loadedIds().length)setStatus('נשמר בענן');p.state=data;if(cur===id)state=data;render();},
      onMissing:()=>dropProject(id),   // deleted: drop it, never recreate it
      onOffline:()=>{},
      onError:showError,
      onSaveState:saveStateOf(id)
    });});
  Object.keys(projects).forEach(id=>{if(!ids.includes(id))dropProject(id);});
  if(!ids.length&&view!=='error')view='empty';
  render();
}
function dropProject(id){
  const p=projects[id];if(!p)return;
  p.sync.close();delete projects[id];delete saveStates[id];
  if(listed)listed=listed.filter(x=>x!==id);
  if(cur===id){cur=null;state=null;}
  if(listed&&!listed.length&&view!=='error')view='empty';
  render();
}
readRoute();
window.addEventListener('hashchange',()=>{if(location.hash&&!location.hash.startsWith('#/'))return;readRoute();ui.warnP=null;render();window.scrollTo(0,0);});
