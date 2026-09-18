/**
 * The browse/serve page's client-side behaviour (filtering, sorting, the row
 * detail modal), as a plain string — kept as a TS export rather than a real
 * .js asset so plain `tsc` needs no bundler step to get it into `dist/`.
 * `pageShell()` in `shell.ts` wraps it in `<script>…</script>`, followed by
 * the live-refresh snippet (only present for `famabot serve`) if any.
 *
 * Deliberately old-school ES5-ish vanilla JS (`[].forEach.call`, `var`, no
 * modules) — this runs unbundled straight in the browser from a template
 * literal, so it targets the lowest common denominator rather than whatever
 * syntax the Node toolchain happens to support.
 */
export function clientScript(defaultSortIdx: number): string {
  return `
var t=document.getElementById('t');
var q=document.getElementById('q');
var sortIdx=${defaultSortIdx},sortDir=-1,presetDays=0;

function chosen(cls){return [].filter.call(document.querySelectorAll('.'+cls+':checked'),function(x){return true}).map(function(x){return x.value});}

function dateFieldMs(tr){
  var f=document.getElementById('dField').value;
  var i={indexed:5,posted:6,updated:7}[f];
  return parseFloat(tr.cells[i].dataset.sort)||0;
}

function apply(){
  var s=q.value.toLowerCase();
  var phs=chosen('fPhase'), srch=chosen('fSearch');
  var gone=document.getElementById('fGone').checked;
  var minSc=parseFloat(document.getElementById('fScore').value);
  var from=document.getElementById('dFrom').valueAsNumber;
  var to=document.getElementById('dTo').valueAsNumber;
  var cutoff=presetDays?Date.now()-presetDays*86400000:0;
  var n=0;
  for(var k=0;k<t.tBodies[0].rows.length;k++){
    var tr=t.tBodies[0].rows[k];
    var ok=true;
    if(s && tr.textContent.toLowerCase().indexOf(s)<0) ok=false;
    if(ok && phs.indexOf(tr.dataset.phase)<0) ok=false;
    if(ok && srch.length && srch.indexOf(tr.dataset.search)<0) ok=false;
    if(ok && !gone && tr.dataset.avail!=='active') ok=false;
    if(ok && !isNaN(minSc)){var sc=parseFloat(tr.cells[0].dataset.sort);if(!(sc>=minSc))ok=false;}
    if(ok && (cutoff||!isNaN(from)||!isNaN(to))){
      var dm=dateFieldMs(tr);
      if(!dm) ok=false;
      else{
        if(cutoff && dm<cutoff) ok=false;
        if(!isNaN(from) && dm<from) ok=false;
        if(!isNaN(to) && dm>to+86400000) ok=false;
      }
    }
    tr.style.display=ok?'':'none';
    if(ok)n++;
  }
  document.getElementById('cnt').textContent=n;
  sort();
}

function sort(){
  var num=t.tHead.rows[0].cells[sortIdx].dataset.num==='1';
  var rows=[].slice.call(t.tBodies[0].rows);
  rows.sort(function(a,b){
    var av=a.cells[sortIdx].dataset.sort, bv=b.cells[sortIdx].dataset.sort;
    if(av==null)av=a.cells[sortIdx].textContent;
    if(bv==null)bv=b.cells[sortIdx].textContent;
    if(num)return sortDir*((parseFloat(av)||0)-(parseFloat(bv)||0));
    return sortDir*String(av).localeCompare(String(bv));
  });
  for(var i=0;i<rows.length;i++)t.tBodies[0].appendChild(rows[i]);
  for(var c=0;c<t.tHead.rows[0].cells.length;c++)
    t.tHead.rows[0].cells[c].querySelector('.ar').textContent = c===sortIdx?(sortDir<0?'▼':'▲'):'';
}

for(var c=0;c<t.tHead.rows[0].cells.length;c++)(function(idx){
  t.tHead.rows[0].cells[idx].onclick=function(){
    sortDir = idx===sortIdx ? -sortDir : (idx>=5&&idx<=7?-1:1);
    sortIdx=idx; sort();
  };
})(c);

q.oninput=apply;
document.getElementById('fScore').oninput=apply;
document.getElementById('fGone').onchange=apply;
document.getElementById('dField').onchange=apply;
document.getElementById('dFrom').onchange=apply;
document.getElementById('dTo').onchange=apply;
document.getElementById('phaseGrp').addEventListener('change',apply);
document.getElementById('searchGrp').addEventListener('change',apply);

[].forEach.call(document.querySelectorAll('#dPresets button'),function(b){
  b.onclick=function(){
    presetDays=parseInt(b.dataset.days,10);
    [].forEach.call(document.querySelectorAll('#dPresets button'),function(x){x.classList.remove('on')});
    b.classList.add('on');
    document.getElementById('dFrom').value='';document.getElementById('dTo').value='';
    apply();
  };
});

var ACTIVE=['new','candidate','accepted'];
[].forEach.call(document.querySelectorAll('[data-preset-phase]'),function(b){
  b.onclick=function(){
    var m=b.dataset.presetPhase;
    [].forEach.call(document.querySelectorAll('.fPhase'),function(cb){
      cb.checked = m==='all' ? true : m==='active' ? ACTIVE.indexOf(cb.value)>=0 : cb.value==='candidate';
    });
    apply();
  };
});

/* ---- row detail modal ---- */
var ov=document.getElementById('ov'), curRow=null;
function E(id){return document.getElementById(id);}
function h(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
function fmtDate(iso){return iso?new Date(iso).toLocaleString():'—';}
function money(d){return d.price!=null?(d.currency||'')+Number(d.price).toLocaleString():'—';}

function renderModal(tr){
  if(!tr||!tr.dataset.d) return;
  var d; try{d=JSON.parse(tr.dataset.d);}catch(e){return;}
  curRow=tr;
  E('mTitle').innerHTML='<a href="'+d.url+'" target="_blank" rel="noopener"></a>';
  E('mTitle').firstChild.textContent=d.title||'(untitled)';
  E('mOpen').href=d.url;
  E('mId').textContent='#'+d.fbId;

  var body=E('mBody'); body.innerHTML='';
  var chips=h('div','mchips');
  function pill(label,val){var p=h('span','pill');p.innerHTML=label+' <b></b>';p.querySelector('b').textContent=val;chips.appendChild(p);}
  if(d.score!=null) pill('fit', Number(d.score).toFixed(2));
  pill('phase', String(d.phase).replace(/_/g,' '));
  if(d.evalCostUsd!=null) pill('eval cost', '~$'+Number(d.evalCostUsd).toFixed(4));
  pill('price', money(d));
  if(d.beds!=null) pill('beds', d.beds);
  if(d.driveMin!=null) pill('drive', Math.round(d.driveMin)+' min');
  pill('search', d.search);
  if(d.availability!=='active') pill('status', d.availability);
  body.appendChild(chips);

  if(d.location){var loc=h('div',null);loc.appendChild(h('div','sec','Location'));loc.appendChild(h('div',null,d.location));body.appendChild(loc);}

  var dates=h('div',null);
  dates.appendChild(h('div','sec','Dates'));
  var dl=h('dl','kv');
  [['Listing created',d.postedAt],['Listing updated',d.updatedAt],['Indexed',d.indexedAt]].forEach(function(r){
    dl.appendChild(h('dt',null,r[0])); dl.appendChild(h('dd',null,fmtDate(r[1])));
  });
  dates.appendChild(dl); body.appendChild(dates);

  if(d.reasoning){var rs=h('div',null);rs.appendChild(h('div','sec',"Agent's reasoning"));rs.appendChild(h('div','reason',d.reasoning));body.appendChild(rs);}

  if(d.redFlags&&d.redFlags.length){var rf=h('div',null);rf.appendChild(h('div','sec','Red flags'));
    var ul=h('ul','mlist flags');d.redFlags.forEach(function(x){ul.appendChild(h('li',null,x));});rf.appendChild(ul);body.appendChild(rf);}

  if(d.missingInfo&&d.missingInfo.length){var mi=h('div',null);mi.appendChild(h('div','sec','Missing / unclear'));
    var ul2=h('ul','mlist');d.missingInfo.forEach(function(x){ul2.appendChild(h('li',null,x));});mi.appendChild(ul2);body.appendChild(mi);}

  if(d.evalModel||d.evalCostUsd!=null||d.evalTokensIn!=null){
    var evb=h('div',null); evb.appendChild(h('div','sec','Evaluation'));
    var evl=h('dl','kv');
    function kv(k,v){evl.appendChild(h('dt',null,k));evl.appendChild(h('dd',null,v));}
    if(d.evalModel) kv('model', d.evalModel);
    if(d.evalCostUsd!=null) kv('approx cost', '~$'+Number(d.evalCostUsd).toFixed(4)+' (list price)');
    if(d.evalTokensIn!=null||d.evalTokensOut!=null){
      var tin=d.evalTokensIn||0, tc=d.evalTokensCached||0, tout=d.evalTokensOut||0;
      kv('tokens', tin.toLocaleString()+' in'+(tc?' ('+tc.toLocaleString()+' cached)':'')+' · '+tout.toLocaleString()+' out');
    }
    evb.appendChild(evl); body.appendChild(evb);
  }

  var ex=d.extracted||{}, exKeys=Object.keys(ex).filter(function(k){return ex[k]!=null&&ex[k]!==''});
  if(exKeys.length){var eb=h('div',null);eb.appendChild(h('div','sec','Extracted'));
    var edl=h('dl','kv');exKeys.forEach(function(k){edl.appendChild(h('dt',null,k.replace(/_/g,' ')));edl.appendChild(h('dd',null,String(ex[k])));});
    eb.appendChild(edl);body.appendChild(eb);}

  if(d.links&&d.links.length){var lk=h('div','mlinks');lk.appendChild(h('div','sec','External links'));
    d.links.forEach(function(u){var a=h('a',null,u);a.href=u;a.target='_blank';a.rel='noopener';lk.appendChild(a);});body.appendChild(lk);}

  if(d.description){var ds=h('div',null);ds.appendChild(h('div','sec','Listing description'));ds.appendChild(h('div','desc',d.description));body.appendChild(ds);}

  body.appendChild(renderActions(d));

  ov.hidden=false; ov.scrollTop=0;
}

/* ---- workflow action buttons ---- */
// Mirrors src/pipeline/phases.ts TRANSITIONS + src/domain/candidate-actions.ts —
// only for enabling the right buttons; the server re-validates regardless.
var ACTIONS_BY_PHASE={
  candidate:[['hold','Hold / comment',true],['reject','Reject',false],['accept','Accept',false]],
  accepted:[
    ['acquisition_failed','Acquisition failed',true],
    ['acquisition_rejected','Acquisition rejected',true],
    ['acquired_continue','Acquired — continue searching',false],
    ['acquired_stop','Acquired — stop searching',false]
  ]
};
function renderActions(d){
  var wrap=h('div','wfactions');
  var avail=ACTIONS_BY_PHASE[d.phase];
  if(!avail){wrap.appendChild(h('div','sec','Workflow'));wrap.appendChild(h('div','muted','no actions from phase '+String(d.phase).replace(/_/g,' ')));return wrap;}
  wrap.appendChild(h('div','sec','Workflow'));
  var ta=document.createElement('textarea');
  ta.className='wfcomment'; ta.rows=2; ta.placeholder='comment (feeds future recommendations)…';
  wrap.appendChild(ta);
  var btnRow=h('div','wfbtns');
  var status=h('span','wfstatus');
  avail.forEach(function(a){
    var action=a[0], label=a[1], required=a[2];
    var btn=document.createElement('button');
    btn.type='button'; btn.className='btn'; btn.textContent=label;
    btn.onclick=function(){
      var comment=ta.value.trim();
      if(required && !comment){status.textContent='comment required for '+label;status.className='wfstatus wferr';return;}
      btn.disabled=true; status.textContent='working…'; status.className='wfstatus';
      fetch('/listings/'+encodeURIComponent(d.fbId)+'/actions/'+action,{
        method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({comment:comment||null})
      }).then(function(r){
        if(!r.ok) return r.text().then(function(t){throw new Error(t||('HTTP '+r.status));});
        return r.json();
      }).then(function(res){
        status.textContent=res.fromPhase+' → '+(res.toPhase||res.fromPhase);
        status.className='wfstatus wfok';
        setTimeout(function(){location.reload();},600);
      }).catch(function(e){
        btn.disabled=false; status.textContent=e.message; status.className='wfstatus wferr';
      });
    };
    btnRow.appendChild(btn);
  });
  wrap.appendChild(btnRow);
  wrap.appendChild(status);
  return wrap;
}
function closeModalUI(){ov.hidden=true;curRow=null;openedByPush=false;}
function stripHash(){return location.pathname+location.search;}
var openedByPush=false;

function fbOf(tr){try{return JSON.parse(tr.dataset.d).fbId;}catch(e){return null;}}
function rowByFbId(id){
  return [].filter.call(t.tBodies[0].rows,function(r){return fbOf(r)===id;})[0];
}
// mode: 'open' (click, modal was closed), 'switch' (click/arrows while open), 'restore' (load/popstate)
function showListing(id,mode){
  var tr=rowByFbId(id);
  if(!tr){ history.replaceState(null,'',stripHash()); closeModalUI(); return; }
  if(mode==='open'){ history.pushState({id:id},'','#'+encodeURIComponent(id)); openedByPush=true; }
  else if(mode==='switch'){ history.replaceState({id:id},'','#'+encodeURIComponent(id)); }
  else { history.replaceState({id:id},'','#'+encodeURIComponent(id)); openedByPush=false; }
  renderModal(tr);
}
function dismiss(){                                // ✕ / backdrop / Esc
  if(openedByPush) history.back();                 // -> popstate closes & restores the URL
  else { history.replaceState(null,'',stripHash()); closeModalUI(); }
}
function step(delta){
  if(!curRow) return;
  var rows=[].filter.call(t.tBodies[0].rows,function(r){return r.style.display!=='none';});
  var i=rows.indexOf(curRow); if(i<0) return;
  var next=rows[i+delta], id=next&&fbOf(next);
  if(id) showListing(id,'switch');
}
window.addEventListener('popstate',function(){
  var id=location.hash.replace(/^#/,'');
  if(id) showListing(decodeURIComponent(id),'restore'); else closeModalUI();
});
t.addEventListener('click',function(e){          // delegated so it survives live tbody swaps
  if(e.target.closest('a')||e.target.closest('thead')) return;
  var tr=e.target.closest('tbody tr'), id=tr&&fbOf(tr);
  if(id) showListing(id, ov.hidden?'open':'switch');
});
E('mClose').onclick=dismiss;
ov.addEventListener('click',function(e){if(e.target===ov)dismiss();});
document.addEventListener('keydown',function(e){
  if(ov.hidden) return;
  if(e.key==='Escape') dismiss();
  else if(e.key==='ArrowDown'){e.preventDefault();step(1);}
  else if(e.key==='ArrowUp'){e.preventDefault();step(-1);}
});
if(location.hash.length>1) showListing(decodeURIComponent(location.hash.slice(1)),'restore');

// keep the Search checkbox list in sync with whatever keys are in the table now
function syncSearchBoxes(){
  var have={}, grp=document.getElementById('searchGrp');
  [].forEach.call(grp.querySelectorAll('.fSearch'),function(cb){have[cb.value]=cb});
  var seen={};
  for(var k=0;k<t.tBodies[0].rows.length;k++)seen[t.tBodies[0].rows[k].dataset.search]=1;
  Object.keys(seen).forEach(function(key){
    if(!have[key]){
      var l=document.createElement('label');
      l.className='chk';
      l.innerHTML='<input type="checkbox" class="fSearch" value="'+key+'" checked> '+key;
      grp.appendChild(l);
    }
  });
  if(grp.querySelector('.muted') && Object.keys(seen).length) grp.querySelector('.muted').remove();
}

sort();
`;
}
