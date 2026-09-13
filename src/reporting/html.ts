import { writeFileSync } from "node:fs";
import { distinctSearches, type BrowseItem } from "./query.js";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** JSON safe to drop into a single-quoted HTML attribute. */
function attrJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/&/g, "&amp;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;");
}

/** Column definitions: label + whether its data-sort is numeric. */
const COLUMNS: { key: string; label: string; num: boolean }[] = [
  { key: "score", label: "Score", num: true },
  { key: "price", label: "Price", num: true },
  { key: "beds", label: "Bd", num: true },
  { key: "drive", label: "Drive", num: true },
  { key: "phase", label: "Phase", num: true },
  { key: "indexed", label: "Indexed", num: true },
  { key: "posted", label: "Posted", num: true },
  { key: "updated", label: "Updated", num: true },
  { key: "search", label: "Search", num: false },
  { key: "location", label: "Location", num: false },
  { key: "title", label: "Title", num: false },
  { key: "flags", label: "Flags", num: true },
  { key: "why", label: "Why", num: false },
];
/** Default sort column index ("Posted") and direction (desc). */
const DEFAULT_SORT = 6;

const PHASE_ORDER = [
  "new",
  "candidate",
  "contacted",
  "visit_scheduled",
  "visited",
  "accepted",
  "rejected",
  "declined",
];

function relAge(msVal: number): string {
  if (!msVal) return "";
  const s = (Date.now() - msVal) / 1000;
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  if (s < 86400 * 14) return Math.round(s / 86400) + "d";
  if (s < 86400 * 60) return Math.round(s / (86400 * 7)) + "w";
  return Math.round(s / (86400 * 30)) + "mo";
}

function dateCell(msVal: number, iso: string | null): string {
  const title = iso ? esc(new Date(iso).toLocaleString()) : "";
  const v = relAge(msVal);
  return `<td data-sort="${msVal}" class="num t" title="${title}">${v || "·"}</td>`;
}

function scoreCell(s: number | null): string {
  if (s == null)
    return `<td data-sort="-1" class="num"><span class="muted">·</span></td>`;
  const cls = s >= 0.6 ? "sc-g" : s >= 0.35 ? "sc-o" : "sc-w";
  return `<td data-sort="${s}" class="num"><span class="sc ${cls}">${s.toFixed(2)}</span></td>`;
}

export function renderRows(items: BrowseItem[]): string {
  return items
    .map((i) => {
      const badges =
        (i.changed
          ? '<span class="bd bd-chg" title="changed since first seen">✎</span>'
          : "") +
        (i.availability !== "active"
          ? `<span class="bd bd-gone" title="${esc(i.availability)}">✕</span>`
          : "") +
        (i.links.length
          ? '<span class="bd bd-ext" title="has an off-platform link">↗</span>'
          : "");
      const flagList = [
        i.availability !== "active" ? `(${i.availability})` : "",
        ...i.redFlags,
      ].filter(Boolean);
      const phaseIdx = Math.max(0, PHASE_ORDER.indexOf(i.phase));
      const detail = {
        fbId: i.fbId,
        url: i.url,
        title: i.title,
        price: i.price,
        currency: i.currency,
        beds: i.beds,
        driveMin: i.driveMin,
        phase: i.phase,
        availability: i.availability,
        search: i.search,
        location: i.location,
        score: i.score,
        verdict: i.verdict,
        reasoning: i.reasoning,
        redFlags: i.redFlags,
        missingInfo: i.missingInfo,
        evalModel: i.evalModel,
        evalCostUsd: i.evalCostUsd,
        evalTokensIn: i.evalTokensIn,
        evalTokensOut: i.evalTokensOut,
        evalTokensCached: i.evalTokensCached,
        extracted: i.extracted,
        links: i.links,
        description: i.description,
        indexedAt: i.indexedAt,
        postedAt: i.postedAt,
        updatedAt: i.updatedAt,
      };
      return `<tr data-phase="${esc(i.phase)}" data-avail="${esc(i.availability)}" data-search="${esc(i.search)}" data-d='${attrJson(detail)}'${
        i.availability !== "active" ? ' class="gone"' : ""
      }>
  ${scoreCell(i.score)}
  <td data-sort="${i.price ?? 1e12}" class="num">${i.price != null ? esc(i.currency) + i.price.toLocaleString() : "·"}</td>
  <td data-sort="${i.beds ?? -1}" class="num">${i.beds ?? "·"}</td>
  <td data-sort="${i.driveMin ?? 1e6}" class="num">${i.driveMin != null ? Math.round(i.driveMin) + "m" : "·"}</td>
  <td data-sort="${phaseIdx}"><span class="ph ph-${esc(i.phase)}">${esc(i.phase.replace(/_/g, " "))}</span></td>
  ${dateCell(i.indexedMs, i.indexedAt)}
  ${dateCell(i.postedMs || i.indexedMs, i.postedAt ?? i.indexedAt)}
  ${dateCell(i.updatedMs, i.updatedAt)}
  <td><span class="clip" style="max-width:12ch">${esc(i.search)}</span></td>
  <td><span class="clip" style="max-width:22ch" title="${esc(i.location)}">${esc(i.location) || "·"}</span></td>
  <td class="ttlcell">${badges}<a class="ttl" href="${esc(i.url)}" target="_blank" rel="noopener" title="${esc(i.reasoning)}">${esc(i.title)}</a></td>
  <td data-sort="${i.redFlags.length}" title="${esc(flagList.join(" · "))}">${flagList.length ? `<span class="fl">⚑ ${flagList.length}</span>` : ""}</td>
  <td class="why"><span class="clip" style="max-width:40ch" title="${esc(i.reasoning)}">${esc(i.reasoning)}</span></td>
</tr>`;
    })
    .join("\n");
}

export interface ShellOpts {
  rows: string;
  count: number;
  /** Distinct search keys present, for the Search filter checkboxes. */
  searchKeys: string[];
  /** When set, the page polls this URL for fresh <tr> HTML every `intervalS`. */
  live?: { url: string; intervalS: number };
}

export function pageShell(o: ShellOpts): string {
  const head =
    "<tr>" +
    COLUMNS.map(
      (c, idx) =>
        `<th data-idx="${idx}" data-num="${c.num ? 1 : 0}">${c.label}<span class="ar"></span></th>`,
    ).join("") +
    "</tr>";

  const searchBoxes = o.searchKeys.length
    ? o.searchKeys
        .map(
          (k) =>
            `<label class="chk"><input type="checkbox" class="fSearch" value="${esc(k)}" checked> ${esc(k)}</label>`,
        )
        .join("")
    : '<span class="muted">—</span>';

  const phaseBoxes = PHASE_ORDER.map(
    (p) =>
      `<label class="chk"><input type="checkbox" class="fPhase" value="${p}" checked> ${p.replace(/_/g, " ")}</label>`,
  ).join("");

  const liveJs = o.live
    ? "var LIVE_URL=" +
      JSON.stringify(o.live.url) +
      ",LIVE_MS=" +
      o.live.intervalS * 1000 +
      ";var lastUpd=Date.now();" +
      "async function refresh(){try{var r=await fetch(LIVE_URL,{cache:'no-store'});if(!r.ok)return;" +
      "var d=document.createElement('tbody');d.innerHTML=await r.text();t.replaceChild(d,t.tBodies[0]);" +
      "syncSearchBoxes();lastUpd=Date.now();apply();}catch(e){}}" +
      "setInterval(refresh,LIVE_MS);" +
      "setInterval(function(){var s=Math.round((Date.now()-lastUpd)/1000);" +
      "var u=document.getElementById('upd');if(u)u.textContent='updated '+s+'s ago';},1000);"
    : "";

  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>famabot${o.live ? " · listings" : ""}</title>
<style>
  :root{
    --bg:#0e1014; --panel:#161a21; --panel-2:#1c212b; --border:#282e3a;
    --text:#e7e9ee; --muted:#8b93a1; --faint:#5f6773;
    --accent:#4f8cff; --accent-ink:#fff;
    --good:#3ecf8e; --ok:#f2b544; --weak:#f2668b; --violet:#a78bfa;
    --chip:#232a37;
    color-scheme:dark;
  }
  @media (prefers-color-scheme:light){:root{
    --bg:#f7f8fa; --panel:#ffffff; --panel-2:#eef1f5; --border:#e2e6ec;
    --text:#1a1d23; --muted:#6b7280; --faint:#9aa1ac;
    --accent:#2563eb; --good:#15a862; --ok:#c4870a; --weak:#dc2f5c; --violet:#7c56d6;
    --chip:#eef1f5;
    color-scheme:light;
  }}
  *{box-sizing:border-box}
  body{margin:0;padding:0 22px 40px;background:var(--bg);color:var(--text);
    font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  a{color:var(--accent);text-decoration:none}
  .muted{color:var(--muted)}

  .topbar{position:sticky;top:0;z-index:6;display:flex;align-items:center;gap:14px;
    padding:14px 0 12px;background:var(--bg);border-bottom:1px solid var(--border)}
  .brand{font-weight:700;font-size:14px;letter-spacing:.02em;display:flex;align-items:center;gap:7px}
  .brand .dot{width:7px;height:7px;border-radius:50%;background:var(--good);
    ${o.live ? "animation:pulse 2.4s ease-in-out infinite" : ""}}
  #q{flex:0 1 320px;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;
    padding:7px 11px;color:var(--text);font:inherit;outline:none}
  #q:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}
  .count{margin-left:auto;color:var(--muted);font-size:12px}
  .count b{color:var(--text)}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

  .filters{display:flex;flex-wrap:wrap;gap:16px 26px;background:var(--panel);
    border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin:16px 0}
  .fgroup{display:flex;flex-direction:column;gap:8px}
  .flabel{font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
  .frow{display:flex;flex-wrap:wrap;align-items:center;gap:7px 14px}
  .chk{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;user-select:none;color:var(--text)}
  .chk input{margin:0;accent-color:var(--accent);width:14px;height:14px}
  select,input[type=date],input[type=number]{background:var(--panel-2);border:1px solid var(--border);
    border-radius:7px;padding:6px 9px;color:var(--text);font:inherit;outline:none}
  select:focus,input:focus{border-color:var(--accent)}
  .btn{background:var(--panel-2);border:1px solid var(--border);border-radius:7px;color:var(--muted);
    padding:6px 11px;font:inherit;cursor:pointer;transition:color .12s,background .12s}
  .btn:hover{color:var(--text)}
  .btn.on{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
  .seg{display:inline-flex;border:1px solid var(--border);border-radius:8px;overflow:hidden}
  .seg button{border:0;border-right:1px solid var(--border);background:var(--panel-2);color:var(--muted);
    padding:6px 11px;font:inherit;cursor:pointer;transition:color .12s,background .12s}
  .seg button:last-child{border-right:0}
  .seg button:hover:not(.on){color:var(--text)}
  .seg button.on{background:var(--accent);color:var(--accent-ink)}

  .tablewrap{border:1px solid var(--border);border-radius:12px;overflow:auto;max-height:calc(100vh - 250px)}
  table{border-collapse:separate;border-spacing:0;width:100%;font-size:12.5px}
  thead th{position:sticky;top:0;z-index:2;background:var(--panel);color:var(--muted);
    text-align:left;font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;
    padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap;user-select:none}
  thead th:hover{color:var(--text)}
  thead th .ar{margin-left:5px;color:var(--accent);font-size:9px}
  tbody td{padding:9px 12px;border-bottom:1px solid var(--border);vertical-align:top}
  tbody tr:last-child td{border-bottom:0}
  tbody tr:hover{background:var(--panel-2)}
  tr.gone{opacity:.5}
  tr.gone .ttl{text-decoration:line-through}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  .num.t{color:var(--muted)}
  .clip{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .why .clip{color:var(--muted);font-size:11.5px}
  .ttlcell{min-width:16ch}
  a.ttl{color:var(--text);font-weight:500}
  a.ttl:hover{color:var(--accent)}
  .sc{display:inline-block;min-width:40px;text-align:center;padding:2px 7px;border-radius:999px;
    font-family:ui-monospace,monospace;font-size:11px;font-weight:700}
  .sc-g{background:color-mix(in srgb,var(--good) 18%,transparent);color:var(--good)}
  .sc-o{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}
  .sc-w{background:color-mix(in srgb,var(--weak) 16%,transparent);color:var(--weak)}
  .ph{display:inline-block;padding:2px 9px;border-radius:999px;font-size:10.5px;font-weight:600;
    background:var(--chip);color:var(--muted);text-transform:capitalize}
  .ph-candidate{background:color-mix(in srgb,var(--good) 16%,transparent);color:var(--good)}
  .ph-contacted{background:color-mix(in srgb,var(--accent) 16%,transparent);color:var(--accent)}
  .ph-visit_scheduled,.ph-visited{background:color-mix(in srgb,var(--violet) 18%,transparent);color:var(--violet)}
  .ph-accepted{background:color-mix(in srgb,var(--good) 28%,transparent);color:var(--good)}
  .ph-rejected,.ph-declined{color:var(--faint)}
  .bd{display:inline-block;font-size:10px;padding:1px 4px;border-radius:4px;margin-right:5px}
  .bd-chg{background:color-mix(in srgb,var(--accent) 20%,transparent);color:var(--accent)}
  .bd-ext{background:color-mix(in srgb,var(--violet) 20%,transparent);color:var(--violet)}
  .bd-gone{background:color-mix(in srgb,var(--weak) 20%,transparent);color:var(--weak)}
  .fl{color:var(--ok);font-size:11.5px;font-weight:700;white-space:nowrap}
  tbody tr{cursor:pointer}

  .ov{position:fixed;inset:0;z-index:50;display:flex;align-items:flex-start;justify-content:center;
    padding:5vh 16px 16px;overflow:auto;background:color-mix(in srgb,#000 58%,transparent)}
  .ov[hidden]{display:none}
  .modal{background:var(--panel);border:1px solid var(--border);border-radius:16px;width:100%;
    max-width:780px;box-shadow:0 24px 70px rgba(0,0,0,.45);overflow:hidden}
  .mhead{position:sticky;top:0;display:flex;gap:12px;align-items:flex-start;padding:16px 18px;
    background:var(--panel);border-bottom:1px solid var(--border)}
  .mhead h2{margin:0;font-size:15px;line-height:1.35;font-weight:600;flex:1}
  .mhead h2 a{color:var(--text)}.mhead h2 a:hover{color:var(--accent)}
  .mclose{border:1px solid var(--border);background:var(--panel-2);color:var(--muted);border-radius:8px;
    width:30px;height:30px;font-size:15px;cursor:pointer;flex:none}
  .mclose:hover{color:var(--text)}
  .mbody{padding:16px 18px;display:flex;flex-direction:column;gap:16px}
  .mchips{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
  .mchips .pill{background:var(--panel-2);border:1px solid var(--border);border-radius:999px;
    padding:3px 10px;font-size:12px;color:var(--muted)}
  .mchips .pill b{color:var(--text);font-weight:600}
  .sec{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;
    color:var(--muted);margin-bottom:7px}
  .reason{font-size:14px;line-height:1.65;background:var(--panel-2);border:1px solid var(--border);
    border-radius:10px;padding:14px 16px}
  .mlist{margin:0;padding-left:18px;font-size:13px;line-height:1.6}
  .mlist.flags li{color:var(--ok)}
  .kv{display:grid;grid-template-columns:max-content 1fr;gap:5px 16px;font-size:12.5px}
  .kv dt{color:var(--muted)}.kv dd{margin:0}
  .mlinks a{display:block;font-size:12.5px;word-break:break-all;margin-bottom:3px}
  .desc{white-space:pre-wrap;font-size:12.5px;line-height:1.6;color:var(--muted);
    background:var(--panel-2);border:1px solid var(--border);border-radius:10px;
    padding:12px 14px;max-height:320px;overflow:auto}
  .mfoot{display:flex;gap:10px;align-items:center;padding:14px 18px;border-top:1px solid var(--border)}
  .mfoot .id{color:var(--faint);font-size:11px;font-family:ui-monospace,monospace;margin-left:auto}
  .mopen{background:var(--accent);color:var(--accent-ink);border:0;border-radius:8px;
    padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none}
  .mnav{color:var(--muted);font-size:11px}
</style>

<div class="topbar">
  <span class="brand"><span class="dot"></span>famabot</span>
  <input type="text" id="q" placeholder="filter by any text…" autofocus>
  <span class="count"><b id="cnt">${o.count}</b> shown${
    o.live ? ' · <span id="upd">live</span>' : ` · ${esc(new Date().toLocaleString())}`
  }</span>
</div>

<div class="filters">
  <div class="fgroup">
    <span class="flabel">Status</span>
    <div class="frow" id="phaseGrp">${phaseBoxes}</div>
    <div class="frow">
      <button type="button" class="btn" data-preset-phase="all">all</button>
      <button type="button" class="btn" data-preset-phase="active">active pipeline</button>
      <button type="button" class="btn" data-preset-phase="candidate">candidates</button>
      <label class="chk"><input type="checkbox" id="fGone"> show gone</label>
    </div>
  </div>
  <div class="fgroup">
    <span class="flabel">Date</span>
    <div class="frow">
      <select id="dField">
        <option value="posted">listing created</option>
        <option value="updated">listing updated</option>
        <option value="indexed">indexed</option>
      </select>
    </div>
    <div class="frow"><div class="seg" id="dPresets">
      <button type="button" data-days="0" class="on">any</button>
      <button type="button" data-days="1">24h</button>
      <button type="button" data-days="3">3 days</button>
      <button type="button" data-days="7">week</button>
      <button type="button" data-days="30">month</button>
    </div></div>
    <div class="frow"><span class="muted">from</span> <input type="date" id="dFrom">
      <span class="muted">to</span> <input type="date" id="dTo"></div>
  </div>
  <div class="fgroup">
    <span class="flabel">Search</span>
    <div class="frow" id="searchGrp">${searchBoxes}</div>
  </div>
  <div class="fgroup">
    <span class="flabel">Min score</span>
    <div class="frow"><input type="number" id="fScore" min="0" max="1" step="0.05" placeholder="0.00" style="width:5.5rem"></div>
  </div>
</div>

<div class="tablewrap"><table id="t"><thead>${head}</thead>
<tbody>
${o.rows}
</tbody></table></div>

<div class="ov" id="ov" hidden>
  <div class="modal" role="dialog" aria-modal="true">
    <div class="mhead">
      <h2 id="mTitle"></h2>
      <button class="mclose" id="mClose" title="close (Esc)">✕</button>
    </div>
    <div class="mbody" id="mBody"></div>
    <div class="mfoot">
      <a class="mopen" id="mOpen" target="_blank" rel="noopener">Open on Facebook</a>
      <span class="mnav">↑ ↓ to move · Esc to close</span>
      <span class="id" id="mId"></span>
    </div>
  </div>
</div>

<script>
var t=document.getElementById('t');
var q=document.getElementById('q');
var sortIdx=${DEFAULT_SORT},sortDir=-1,presetDays=0;

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

var ACTIVE=['new','candidate','contacted','visit_scheduled','visited','accepted'];
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

  ov.hidden=false; ov.scrollTop=0;
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
${liveJs}
</script>`;
}

export function writeHtml(items: BrowseItem[], path: string): void {
  writeFileSync(
    path,
    pageShell({
      rows: renderRows(items),
      count: items.length,
      searchKeys: distinctSearches(items),
    }),
  );
}
