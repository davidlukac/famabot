import { clientScript } from "./client-script.js";
import { COLUMNS, DEFAULT_SORT, esc, PHASE_ORDER } from "./helpers.js";
import { pageStyles } from "./styles.js";

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
<style>${pageStyles(!!o.live)}</style>

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

<script>${clientScript(DEFAULT_SORT)}
${liveJs}
</script>`;
}
