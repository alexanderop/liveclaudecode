const $=s=>document.querySelector(s);
let offline=false;
async function jget(url){                 // never throw: the server may restart mid-run
  try{ const r=await fetch(url); if(!r.ok) throw 0; const j=await r.json(); setConn(true); return j; }
  catch(e){ setConn(false); return null; }
}
function setConn(ok){
  if(ok===!offline) return; offline=!ok;
  let b=document.getElementById('conn');
  if(!b){ b=document.createElement('div'); b.id='conn';
    b.style.cssText='position:fixed;top:8px;right:12px;z-index:9;font:11px var(--mono);background:#3a1c1c;color:#ff9b9b;border:1px solid #6a2c2c;border-radius:6px;padding:3px 9px';
    document.body.appendChild(b); }
  b.textContent='viewer offline — retrying'; b.style.display=ok?'none':'block';
}
let cur=null, since=0, roots=[], flat={}, evs=[], node=null, density='normal', treeSig='';
const esc=s=>(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const hhmm=ts=>ts?new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'';
const kb=n=>!n?0:n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'k':n;
const secs=(a,b)=>(!a||!b)?0:(new Date(b)-new Date(a))/1000;
const dur=(a,b)=>{const s=Math.round(secs(a,b));return !s?'0s':s<60?s+'s':s<3600?Math.floor(s/60)+'m'+(s%60)+'s':Math.floor(s/3600)+'h'+Math.floor(s%3600/60)+'m';};
const ICON={Read:'📖',Glob:'🔍',Grep:'🔍',Edit:'✏️',Write:'✏️',MultiEdit:'✏️',NotebookEdit:'✏️',
  Bash:'⌘',Agent:'⇄',Task:'⇄',Skill:'⚡',TodoWrite:'☑',WebFetch:'🌐',WebSearch:'🌐'};

/* ---------------- sidebar ---------------- */
async function loadTree(){
  const j=await jget('/api/tree'); if(!j) return;
  roots=j.roots; flat={};
  const q=$('#q').value.toLowerCase(), liveOnly=$('#liveOnly').checked, hideIdle=$('#hideIdle').checked;
  const keep=n=>{ // keep a node if it or any descendant matches
    const kids=(n.children||[]).filter(keep);
    const self=(!liveOnly||n.subLive)&&(!hideIdle||n.tools>0||kids.length)&&
               (!q||(n.label||'').toLowerCase().includes(q)||(n.agentType||'').toLowerCase().includes(q));
    n._kids=kids; return self||kids.length;
  };
  const vis=roots.filter(keep);
  const sig=JSON.stringify(vis.map(function s(n){return [n.key,n.live,n.tools,n.errors,n.spawnState,(n._kids||[]).map(s)]}));
  const el=$('#tree');
  if(sig!==treeSig){ // only rebuild when something actually changed (keeps clicks + scroll stable)
    treeSig=sig; const top=el.scrollTop; el.innerHTML='';
    vis.slice(0,20).forEach(r=>el.appendChild(nodeEl(r,0)));
    el.scrollTop=top;
  }
  index(roots,null);
  if(!cur && vis.length) select(deepestLive(vis[0]).key);
  // "follow the active agent" stays inside the run you're watching: it hops to
  // whichever agent in THIS tree is currently writing, never to another run.
  if($('#autojump').checked && cur && flat[cur]){
    const root=rootOf(cur);
    const live=descendants(root).filter(n=>n.live).sort((a,b)=>b.mtime-a.mtime)[0];
    if(live && live.key!==cur) select(live.key);
  }
}
function index(ns,parent){ ns.forEach(n=>{ n._parent=parent; flat[n.key]=n; index(n.children||[],n.key); }); }
function rootOf(k){ let n=flat[k]; while(n&&n._parent&&flat[n._parent]) n=flat[n._parent]; return n; }
function descendants(n,out){ out=out||[]; if(!n) return out; out.push(n); (n.children||[]).forEach(c=>descendants(c,out)); return out; }
function nodeEl(n,depth){
  const d=document.createElement('div');
  d.className='n'+(cur===n.key?' sel':''); d.tabIndex=0; d.setAttribute('role','button');
  const running=n.spawnState==='running'||(n.live&&n.kind==='subagent');
  d.innerHTML=`<div class="t">${esc(n.label||n.key)}</div>
    <div class="m"><span class="dot ${n.subLive?'on':''} ${n.subErrors&&!n.subLive?'err':''}"></span>
    ${n.agentType?`<span class="tag ${running?'hot':''}">${esc(n.agentType)}</span>`:'<span class="tag">session</span>'}
    ${running?'<span class="tag hot">running</span>':''}
    <span>${n.subTools} tools</span>${n.subErrors?`<span style="color:var(--err)">${n.subErrors} err</span>`:''}
    ${n.subAgents?`<span>${n.subAgents} agents</span>`:''}
    <span>${dur(n.firstTs,n.subLast)}</span></div>
    ${n.current?`<div class="cur">▶ ${esc(n.current.tool)} ${esc((n.current.summary||'').slice(0,40))}</div>`:''}`;
  d.onclick=()=>select(n.key);
  d.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){e.preventDefault();select(n.key);} };
  const wrap=document.createElement('div');
  if(depth>0) wrap.className='kid';
  wrap.appendChild(d);
  (n._kids||n.children||[]).forEach(c=>wrap.appendChild(nodeEl(c,depth+1)));
  return wrap;
}
function deepestLive(n){ const l=(n.children||[]).filter(c=>c.subLive); return l.length?deepestLive(l[l.length-1]):n; }

/* ---------------- hero: describes the RUN; the feed below follows one agent -------- */
function renderHero(){
  const root=rootOf(cur)||flat[cur]; if(!root) return;
  const sel=flat[cur]||{};
  $('#htitle').textContent=root.label||cur;
  $('#hdot').className='dot '+(root.subLive?'on':'');
  const pill=$('#hpill');
  pill.className='pill '+(root.subLive?'run':root.subErrors?'fail':'done');
  pill.textContent=(root.subLive?'RUNNING · ':root.subErrors?'ENDED · ':'DONE · ')+dur(root.firstTs,root.subLast)
                   +(!root.subLive&&root.subErrors?` · ${root.subErrors} errors`:'');
  // one plain-language line: who is working and on what, right now
  const all=descendants(root);
  const busy=all.filter(n=>n.live);
  const s=$('#say');
  if(busy.length){
    const lead=busy.map(n=>n.current?{n,c:n.current}:null).filter(Boolean).pop();
    const names=busy.map(n=>esc(n.agentType?n.label:'main session')).join(', ');
    const one=busy.length===1;
    const doing=lead
      ? `${one?'':esc(lead.n.label).slice(0,24)+' '}running <b>${esc(lead.c.tool)}</b> <span style="color:#cbd5e1">${esc(lead.c.summary.replace(/\s+/g,' ').slice(0,80))}</span> <span style="color:var(--faint)">since ${hhmm(lead.c.ts)}</span>`
      : 'thinking — no tool in flight';
    s.innerHTML=`<span class="dot on"></span> <b>${one?esc(names):busy.length+' agents working: '+names}</b> · ${doing}`;
  }else{
    s.innerHTML=`<span class="dot"></span> idle since ${hhmm(root.subLast)} · last words: <span style="color:var(--dim)">${esc((sel.finalText||root.finalText||'').split('\n')[0].slice(0,140))}</span>`;
  }
  $('#kpis').innerHTML=[
    ['agents',(root.subAgents||0)+1,''],
    ['tools run',root.subTools,''],
    ['files changed',window._fileCount||0,'warn'],
    ['errors',root.subErrors,root.subErrors?'bad':''],
    ['out tokens',kb(root.tokensOut),''],
    ['elapsed',dur(root.firstTs,root.subLast),''],
  ].map(([k,v,c])=>`<div class="kpi ${c}"><b>${v}</b>${k}</div>`).join('');
  $('#viewing').innerHTML=`viewing <b style="color:var(--fg)">${esc(sel.label||cur)}</b>`+
    (sel.agentType?` <span class="tag">${esc(sel.agentType)}</span>`:'')+
    ` · ${sel.tools||0} tools · ${sel.errors||0} err${sel.live?' · <span style="color:var(--live)">live</span>':''}`;
}

/* ---------------- panels ---------------- */
async function loadRun(){
  if(!cur) return;
  const j=await jget('/api/run?key='+encodeURIComponent(cur));
  if(!j||j.error) return;
  window._fileCount=j.files.length;
  renderGantt(j.lanes);
  renderWork(j.files, j.node);
  renderPlan(j.node, j.phases);
  renderHero();
}
function renderGantt(lanes){
  const t0=Math.min(...lanes.map(l=>new Date(l.firstTs||0).getTime()).filter(Boolean));
  const t1=Math.max(...lanes.map(l=>new Date(l.lastTs||0).getTime()).filter(Boolean));
  const span=Math.max(t1-t0,1000);
  $('#tlNote').textContent=` — ${lanes.length} agents over ${dur(new Date(t0).toISOString(),new Date(t1).toISOString())}; bars show when each ran`;
  $('#gantt').innerHTML=lanes.map(l=>{
    const a=new Date(l.firstTs||t0).getTime(), b=new Date(l.lastTs||t0).getTime();
    const left=(a-t0)/span*100, w=Math.max((b-a)/span*100,.6);
    const cls=l.live?'live':l.errors?'err':(l.depth===0?'d0':'');
    return `<div class="lane${l.key===cur?' selL':''}" data-k="${esc(l.key)}">
      <div class="lname" style="padding-left:${l.depth*11}px" title="${esc(l.label)}">${l.depth?'└ ':''}${esc((l.label||'').slice(0,40))}</div>
      <div class="ltrack"><div class="lbar ${cls}" style="left:${left}%;width:${w}%"><span>${dur(l.firstTs,l.lastTs)}${l.errors?' · '+l.errors+'err':''}</span></div></div>
    </div>`;
  }).join('');
  $('#gantt').querySelectorAll('.lane').forEach(e=>e.onclick=()=>select(e.dataset.k));
}
function renderWork(files,n){
  $('#workNote').textContent=` — ${files.length} files, ${(n.commands||[]).length} commands`;
  const f=files.length?`<div><h3 style="font:10px var(--mono);color:var(--faint);margin:0 0 4px">FILES WRITTEN (whole run)</h3>`+
    files.slice(0,40).map(([p,o])=>`<div class="frow"><span class="op">${o}×</span><span class="fp" title="${esc(p)}">${esc(p)}</span></div>`).join('')+'</div>':'';
  const cmds=(n.commands||[]);
  const c=cmds.length?`<div><h3 style="font:10px var(--mono);color:var(--faint);margin:0 0 4px">COMMANDS (this agent)</h3>`+
    cmds.slice(-25).reverse().map(x=>`<div class="crow"><span class="${x.ok===null?'pend':x.ok?'ok':'no'}">${x.ok===null?'⋯':x.ok?'✓':'✗'}</span><code title="${esc(x.cmd)}">${esc(x.cmd.slice(0,90))}</code></div>`).join('')+'</div>':'';
  $('#work').innerHTML=(f+c)||'<span style="color:var(--faint);font:11px var(--mono)">nothing written yet</span>';
}
function renderPlan(n,phases){
  let h='';
  // phases come from every agent in the run (the orchestrator announces most),
  // merged in time order
  const ms=(phases&&phases.length)?phases:(n.milestones||[]);
  if(n.todos&&n.todos.length){
    const done=n.todos.filter(t=>t.status==='completed').length;
    h+=`<div><h3 style="font:10px var(--mono);color:var(--faint);margin:0 0 4px">TODOS ${done}/${n.todos.length}</h3>`+
      n.todos.map(t=>`<div class="todo ${t.status}"><span>${t.status==='completed'?'✔':t.status==='in_progress'?'◐':'○'}</span><span>${esc(t.status==='in_progress'&&t.activeForm?t.activeForm:t.content||'')}</span></div>`).join('')+'</div>';
  }
  if(ms&&ms.length){
    h+='<div><h3 style="font:10px var(--mono);color:var(--faint);margin:0 0 4px">PHASES ANNOUNCED (run)</h3>'+
      ms.map((m,i)=>`<div class="todo ph ${i===ms.length-1?'last':''}" title="${esc(m.who||'')}"><span>${hhmm(m.ts).slice(0,5)}</span><span>${esc(m.title)}</span></div>`).join('')+'</div>';
  }
  const tc=n.toolCounts||{}, keys=Object.keys(tc).sort((a,b)=>tc[b]-tc[a]).slice(0,10);
  if(keys.length) h+='<div><h3 style="font:10px var(--mono);color:var(--faint);margin:0 0 4px">TOOL MIX</h3><div>'+
    keys.map(k=>`<span class="chip">${ICON[k]||''} ${esc(k)} ${tc[k]}</span>`).join('')+'</div></div>';
  if(n.skills&&n.skills.length) h+='<div><h3 style="font:10px var(--mono);color:var(--faint);margin:0 0 4px">SKILLS</h3><div>'+
    n.skills.map(s=>`<span class="chip">/${esc(s.skill)}</span>`).join('')+'</div></div>';
  $('#plan').innerHTML=h||'<span style="color:var(--faint);font:11px var(--mono)">no plan signal yet</span>';
}

/* ---------------- feed ---------------- */
function visible(e){
  if($('#errOnly').checked) return !!e.error;
  if(density==='raw') return true;
  if(density==='compact') return e.kind!=='thinking'&&!(e.kind==='tool_result'&&!e.error)&&e.kind!=='meta'&&e.kind!=='system';
  return e.kind!=='meta'&&e.kind!=='system';
}
function rowEl(e){
  if(e.kind==='tool_use'){
    const d=document.createElement('div');
    d.className='row '+(e.write?'write ':'')+(e.spawn?'spawn ':'');
    d.innerHTML=`<span class="tm">${hhmm(e.ts).slice(0,5)}</span><span class="ic">${ICON[e.tool]||'•'}</span>
      <span class="tx"><b style="color:inherit">${esc(e.tool)}</b> ${esc((e.summary||'').slice(0,150))}</span>`;
    if(e.childKey){ d.style.cursor='pointer'; d.onclick=()=>select(e.childKey); }
    return d;
  }
  if(e.kind==='text'){
    const d=document.createElement('div'); d.className='row say';
    d.innerHTML=`<span class="tm">${hhmm(e.ts).slice(0,5)}</span><span class="ic">💬</span><span class="tx">${esc(e.body.slice(0,400))}</span>`;
    return d;
  }
  if(e.kind==='prompt'){
    const d=document.createElement('div'); d.className='row'; d.style.color='var(--user)';
    d.innerHTML=`<span class="tm">${hhmm(e.ts).slice(0,5)}</span><span class="ic">👤</span><span class="tx" style="color:#9cc4ff">${esc(e.body.slice(0,300))}</span>`;
    return d;
  }
  if(e.kind==='tool_result'&&e.error){
    const d=document.createElement('div'); d.className='row err';
    d.innerHTML=`<span class="tm">${hhmm(e.ts).slice(0,5)}</span><span class="ic">✗</span><span class="tx">${esc((e.tool||'')+' — '+e.body.split('\n')[0].slice(0,180))}</span>`;
    return d;
  }
  return null;
}
function fullEl(e){
  const k=e.kind, d=document.createElement('div');
  let cls=k==='prompt'?'user':k==='text'?'assistant':k;
  if(e.spawn) cls='spawn';
  if(e.write&&k==='tool_use') cls+=' w';
  if(e.error) cls+=' err';
  d.className='ev '+cls;
  const who={prompt:'USER',text:'CLAUDE',thinking:'thinking',tool_use:(e.write?'✏ ':'▶ ')+(e.tool||''),
    tool_result:'└ '+(e.tool||'result'),meta:'system',system:'system'}[k]||k;
  let h=`<div class="h"><span class="who">${esc(e.spawn?'⇄ SPAWN':who)}</span><span>${hhmm(e.ts)}</span>${e.model?`<span>${esc(e.model)}</span>`:''}</div>`;
  if(k==='tool_use'){
    h+=`<div class="callline"><b>${esc(e.tool)}</b> ${esc((e.summary||'').slice(0,500))}</div>
        <details><summary>input</summary><pre>${esc(e.input||'')}</pre></details>`;
    if(e.childKey) h+=`<button class="jump" data-k="${esc(e.childKey)}">open subagent →</button>`;
  }else if(k==='tool_result'){
    const first=(e.body||'').split('\n').slice(0,3).join(' ⏎ ');
    h+=`<details ${e.error?'open':''}><summary>${esc(first.slice(0,170))||'(empty)'} · ${kb(e.full)} chars</summary><pre>${esc(e.body||'')}</pre></details>`;
  }else h+=`<pre>${esc(e.body||'')}</pre>`;
  if(e.full>8000) h+=`<div class="trunc">truncated — ${kb(e.full)} chars total</div>`;
  if(e.usage) h+=`<div class="usage">in ${kb(e.usage.in)} · out ${kb(e.usage.out)} · cache r${kb(e.usage.cr)}/w${kb(e.usage.cw)}</div>`;
  d.innerHTML=h;
  const b=d.querySelector('.jump'); if(b) b.onclick=()=>select(b.dataset.k);
  return d;
}
function paint(newOnes){
  const f=$('#feed'), stick=$('#follow').checked && (f.scrollHeight-f.scrollTop-f.clientHeight<220);
  const em=$('#empty'); if(em&&newOnes.length) em.remove();
  for(const e of newOnes){
    if(!visible(e)) continue;
    const el=density==='compact'?(rowEl(e)||fullEl(e)):fullEl(e);
    f.appendChild(el);
  }
  if(stick) f.scrollTop=f.scrollHeight;
  $('#feedNote').textContent=`${evs.length} events`;
}
function repaint(){ $('#feed').innerHTML=''; paint(evs); }

async function poll(){
  if(!cur) return;
  const j=await jget(`/api/events?key=${encodeURIComponent(cur)}&since=${since}`);
  if(!j||j.error) return;
  since=j.next; node=j.node;
  if(j.events.length){ evs.push(...j.events); paint(j.events); }
  renderHero();
}
function select(key){
  cur=key; since=0; evs=[]; $('#feed').innerHTML=''; treeSig='';
  poll(); loadRun(); loadTree();
}
$('#density').onclick=e=>{ const b=e.target.closest('button'); if(!b) return;
  density=b.dataset.d; [...$('#density').children].forEach(x=>x.classList.toggle('on',x===b)); repaint(); };
$('#errOnly').onchange=repaint;
$('#q').oninput=()=>{treeSig='';loadTree()};
['liveOnly','hideIdle'].forEach(id=>$('#'+id).onchange=()=>{treeSig='';loadTree()});
loadTree(); setInterval(loadTree,4000); setInterval(poll,2000); setInterval(loadRun,6000);
