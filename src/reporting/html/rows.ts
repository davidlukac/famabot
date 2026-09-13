import type { BrowseItem } from "../query.js";
import { attrJson, dateCell, esc, PHASE_ORDER, scoreCell } from "./helpers.js";

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
