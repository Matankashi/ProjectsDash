/* Projects app: the dashboard.
   Views, events, toBlocks and the timer are the claude.ai artifact's code. What changed is where the
   data lives: the project state is a Firestore document (firebase.js) instead of JSON inside the page,
   and the calendar is read from Google Calendar directly (calendar.js) instead of through claude.ai. */
import {watchAuth,signIn,signOutUser,openProject,loadSeed,importIfMissing} from './firebase.js';
import * as gcal from './calendar.js';

const PROJECT_ID='madrid-field-trial';
const LS_TIMER='madrid-dash-timer';
/* The calendar window comes from the project's own dates: CAL_LEAD_DAYS before the earliest one,
   through CAL_TRAIL_DAYS after decision.date. For the Madrid project that is exactly the artifact's
   old fixed window, 2026-09-20 to 2026-11-16. */
const CAL_LEAD_DAYS=10,CAL_TRAIL_DAYS=2;
const STATUS={active:'פעיל',waiting:'ממתין',habit:'הרגל',stuck:'תקוע',done:'הושלם'};
const DAYS=['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳'];
const app=document.getElementById('app');

let state=null;              // the project document from Firestore; null until it arrives
let view='auth',viewMsg='';  // what render() shows while state is null
let sync=null;

let ui={open:{},stuck:false,warn:null,showLog:false,exp:false};

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
let cal={status:'disconnected',blocks:[],msg:CAL_MSG.disconnected,storedAt:0};
let calBusy=false;
function toBlocks(payload){
  const p=payload;
  const evs=(p&&Array.isArray(p.items))?p.items:[];
  return evs.filter(e=>e&&e.status!=='cancelled'&&e.start&&e.start.dateTime&&e.end&&/מדריד/.test(e.summary||'')).map(e=>{
    const sum=e.summary||'';
    const title=sum.replace(/^.*?מדריד\s*[—–:\-]\s*/,'').trim()||sum;
    const streams=state.streams.filter(s=>(s.match||[]).some(k=>sum.toLowerCase().includes(k.toLowerCase()))).map(s=>s.id);
    return {id:e.id,title,desc:stripHtml(e.description),start:new Date(e.start.dateTime),end:new Date(e.end.dateTime),link:e.htmlLink||'',streams};
  }).sort((a,b)=>a.start-b.start);
}
function calRange(){
  const P=state.project,dates=[P.flight,P.buffer&&P.buffer.from,P.buffer&&P.buffer.to,P.decision.date];
  state.streams.forEach(s=>s.milestones.forEach(m=>dates.push(m.date)));
  const from=parse(dates.filter(Boolean).sort()[0]),to=parse(P.decision.date);
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
  if(!cal.blocks.length){cal=Object.assign({},cal,{status:'loading'});render();}
  try{const items=await gcal.listEvents(calRange());cal={status:'ok',blocks:toBlocks({items}),msg:'',storedAt:Date.now()};render();}
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

/* saving: firebase.js debounces and writes only what changed */
const SAVE_TEXT={saving:'שומר…',saved:'נשמר בענן',offline:'אין חיבור. יישמר כשהרשת תחזור'};
function commit(){render();sync.save(state);}
function onSaveState(s,err){setStatus(s==='error'?'לא נשמר: '+((err&&err.code)||'שגיאה'):s==='saving'&&!navigator.onLine?SAVE_TEXT.offline:SAVE_TEXT[s]);}
window.addEventListener('offline',()=>{if(saveText===SAVE_TEXT.saving)setStatus(SAVE_TEXT.offline);});
window.addEventListener('online',()=>{if(saveText===SAVE_TEXT.offline)setStatus(SAVE_TEXT.saving);});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&sync)sync.flush();});
window.addEventListener('pagehide',()=>{if(sync)sync.flush();});

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
function header(){
  const P=state.project,f=daysUntil(P.flight);
  const c=f>0?`<span class="count-n">${f}</span><span>ימים לטיסה (${fmt(P.flight)})</span>`:f===0?'<span class="count-n">היום</span><span>טסים</span>':`<span class="count-n">${daysUntil(P.decision.date)}</span><span>ימים לנקודת ההחלטה</span>`;
  return `<header class="top"><div class="top-row"><h1>${esc(P.name)}</h1><span class="top-tools"><span id="save" class="save">${esc(saveText)}</span><button class="b-link out" data-act="signout">התנתקות</button></span></div><p class="goal">${esc(P.goal)}</p><div class="count">${c}</div></header>`;
}
const names=b=>b.streams.map(id=>(S(id)||{}).name).filter(Boolean).join(' + ');
function nowView(){
  if(cal.status==='loading')return `<section class="now"><div class="now-head"><span class="now-tag">הבלוק הבא</span></div><h2 class="now-title">טוען את הלו״ז מהיומן…</h2></section>`;
  if(!cal.blocks.length)return `<section class="now"><div class="now-head"><span class="now-tag">הבלוק הבא</span></div><h2 class="now-title">${cal.status==='ok'?'אין בלוקים של מדריד ביומן':CAL_TITLE[cal.status]}</h2><p class="now-meta">${esc(cal.msg||'')}</p><div class="now-actions">${calButton('b-light')}</div></section>`;
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
    return `<li class="${done?'done':''}${missed?' missed':''}"><label><input type="checkbox" data-act="ev-toggle" data-e="${esc(b.id)}"${done?' checked':''}><span class="wk-time">${hm(b.start)}</span><span class="wk-t">${esc(b.title)}</span></label><span class="wk-s">${esc(names(b))}</span>${missed?'<span class="chip red">עבר ולא סומן</span>':''}</li>`;}).join('')}</ul></div>`).join('')||'<p class="muted">אין בלוקים בשבוע הקרוב.</p>'}</div></section>`;
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
  let start=today();dated.forEach(m=>{if(parse(m.date)<start)start=parse(m.date);});
  const end=parse(P.decision.date);const total=Math.max(end-start,86400000);
  const pos=d=>Math.min(100,Math.max(0,(parse(d)-start)/total*100));
  const groups={};dated.forEach(m=>{(groups[m.date]=groups[m.date]||[]).push(m);});
  const dots=Object.keys(groups).map(d=>{const g=groups[d],open=g.filter(m=>!m.done);const cls=open.length?urg(daysUntil(d)):'done';
    const tip=fmt(d)+': '+g.map(m=>m.title+(m.done?' (בוצע)':'')).join(', ');
    return `<span class="tl-dot ${cls}" style="inset-inline-start:${pos(d)}%" title="${esc(tip)}" role="img" aria-label="${esc(tip)}">${g.length>1?g.length:''}</span>`;}).join('');
  const ticks=['2026-10-01','2026-10-15','2026-11-01','2026-11-14'].filter(d=>parse(d)>=start&&parse(d)<=end).map(d=>`<span class="tl-tick" style="inset-inline-start:${pos(d)}%">${fmt(d)}</span>`).join('');
  const tp=Math.min(100,Math.max(0,(today()-start)/total*100));
  return `<section class="sec"><h2>ציר הזמן</h2><div class="tl-scroll"><div class="tl">
  <div class="tl-axis"></div>
  <div class="tl-band" style="inset-inline-start:${pos(P.buffer.from)}%;width:${pos(P.buffer.to)-pos(P.buffer.from)+1}%" title="באפר: מסירה ואריזה בלבד"></div>
  <div class="tl-mark today" style="inset-inline-start:${tp}%"><span>היום</span></div>
  <div class="tl-mark flight" style="inset-inline-start:${pos(P.flight)}%"><span>טיסה</span></div>
  <div class="tl-mark decide" style="inset-inline-start:100%"><span>החלטה</span></div>
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
    return `<li class="${m.done?'done':''}"><label><input type="checkbox" data-act="ms-toggle" data-s="${s.id}" data-m="${m.id}"${m.done?' checked':''}><span class="ms-t">${esc(m.title)}</span></label>${m.date?(m.done?`<span class="ms-d">${fmt(m.date)}</span>`:`<span class="ms-d">${fmt(m.date)}</span><span class="chip ${urg(d)}">${rel(d)}</span>`):''}${open?`<button class="x" data-act="ms-del" data-s="${s.id}" data-m="${m.id}" aria-label="מחק">×</button>`:''}</li>`;}).join('')}</ul>`:'';
  const moreBtn=(ms.length>shown.length||open)?`<button class="b-link more" data-act="more" data-s="${s.id}">${open?'פחות':`כל אבני הדרך (${ms.length})`}</button>`:(!ms.length&&!s.habit?`<button class="b-link more" data-act="more" data-s="${s.id}">הוסף אבן דרך</button>`:'');
  const add=open?`<form class="form" data-form="add-ms" data-s="${s.id}"><input name="title" required placeholder="אבן דרך חדשה"><input name="date" type="date" aria-label="תאריך"><button class="b-sec">הוסף</button></form>`:'';
  return `<article class="st st-${s.status}">
  <div class="st-head"><h3>${esc(s.name)}</h3><div class="st-tools">
    <select class="st-status" data-act="status" data-s="${s.id}" aria-label="סטטוס">${Object.keys(STATUS).map(k=>`<option value="${k}"${k===s.status?' selected':''}>${STATUS[k]}</option>`).join('')}</select>
    ${s.habit?'':`<button class="tog" data-act="heavy" data-s="${s.id}" aria-pressed="${!!s.heavy}">מוקד כבד</button>`}
  </div></div>${progress(s)}${next}${habit}${list}${moreBtn}${add}</article>`;
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
  return `<section class="sec rules"><h2>הכללים</h2><ul>${state.rules.map(r=>`<li>${esc(r)}</li>`).join('')}<li>${fmt(P.decision.date)}: נקודת החלטה. ${esc(P.decision.question)}</li></ul>
  <h3>הצלחה עד הטיסה</h3><ul>${P.success.map(r=>`<li>${esc(r)}</li>`).join('')}</ul>
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
const BOOT={auth:'טוען…',loading:'טוען את הנתונים…',importing:'יוצר את הפרויקט מהנתונים הקיימים…',offline:'אין חיבור לשרת. מנסה שוב…',nodata:'אין עדיין נתונים לפרויקט הזה',error:'לא הצלחתי לטעון את הנתונים'};
function bootView(){
  return `<section class="sec boot" aria-live="polite"><h2>${BOOT[view]}</h2>${viewMsg?`<p class="muted">${esc(viewMsg)}</p>`:''}${view==='nodata'||view==='error'?'<button class="b-link out" data-act="signout">התנתקות</button>':''}</section>`;
}
function render(){if(!state){app.innerHTML=view==='login'?loginView():bootView();return;}app.innerHTML=header()+nowView()+weekView()+streams()+upcoming()+timeline()+logView()+rulesView();tick();}

/* events */
app.addEventListener('click',e=>{
  const b=e.target.closest('[data-act]');if(!b||b.tagName==='SELECT'||b.type==='checkbox')return;
  if(b.dataset.act==='signout'){signOut();return;}
  const a=b.dataset.act,s=S(b.dataset.s),id=b.dataset.e;
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
    case 'ms-del':if(m){s.milestones=s.milestones.filter(x=>x!==m);commit();}break;
    case 'more':ui.open[s.id]=!ui.open[s.id];render();break;
    case 'log':ui.showLog=!ui.showLog;render();break;
    case 'export':ui.exp=!ui.exp;render();break;
  }
});
app.addEventListener('change',e=>{
  const t=e.target,a=t.dataset.act;if(!a)return;const s=S(t.dataset.s);
  if(a==='status'){s.status=t.value;commit();}
  else if(a==='ms-toggle'){const m=s.milestones.find(x=>x.id===t.dataset.m);if(m){m.done=t.checked;commit();}}
  else if(a==='ev-toggle')setDone(t.dataset.e,t.checked);
});
app.addEventListener('submit',e=>{
  e.preventDefault();const f=e.target,d=new FormData(f);
  if(f.dataset.form==='login'){login(d);return;}
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
  try{if(sync)await sync.flushAndWait();}catch(e){console.error('projects-app: saving before sign-out failed',e);}
  if(sync)sync.discardBackup();  // nothing of this account's data stays in the browser
  try{await signOutUser();}catch(e){console.error('projects-app: sign-out failed',e);}
  location.reload();
}
async function importProject(userId){
  state=null;view='importing';viewMsg='';render();
  try{
    const seed=await loadSeed();
    if(!seed){view='nodata';viewMsg='הייבוא הראשוני רץ רק מעותק מקומי (localhost) שיש בו data-export.json או source-artifact.html. ראה README.';render();return;}
    const created=await importIfMissing(userId,PROJECT_ID,seed.state);  // either way, the listener delivers the document
    console.info('projects-app: import '+(created?'created the document from '+seed.source:'skipped, the document already exists'));
  }catch(err){console.error('projects-app: import failed',err);view='error';viewMsg='הייבוא נכשל: '+((err&&(err.code||err.message))||'');render();}
}
let signedIn=false;
watchAuth(user=>{
  if(!user){if(signedIn)location.reload();else{view='login';render();}return;}
  if(signedIn)return;
  signedIn=true;view='loading';render();
  startCalendar();
  sync=openProject(user.uid,PROJECT_ID,{
    onData:data=>{data.doneEvents=data.doneEvents||{};data.stuck=data.stuck||{};if(!state)setStatus('נשמר בענן');state=data;render();},
    onMissing:()=>importProject(user.uid),
    onOffline:()=>{if(!state){view='offline';render();}},
    onError:err=>{state=null;view='error';viewMsg=(err&&err.code==='permission-denied'?'אין הרשאה (permission-denied). ייתכן שחוקי Firestore או ה־UID בהם לא מעודכנים.':'שגיאה: '+((err&&(err.code||err.message))||'לא ידועה'))+' רענן את העמוד כדי לנסות שוב.';render();},
    onSaveState
  });
});
