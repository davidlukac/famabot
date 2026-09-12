/**
 * Trim Facebook page furniture off a scraped Marketplace detail-page blob.
 *
 * The scraper often falls back to the whole `<main>` innerText, which appends —
 * after the seller's own text and the item's attribute rows — an ad slot, the
 * seller card, and a "Today's picks" / "More listings" carousel of unrelated
 * items. That tail is pure chrome and only distracts the evaluator.
 *
 * Category-agnostic: works for a rental, a used car, a couch. We keep everything
 * up to the ad / seller card — the seller's prose, the attribute rows (FB labels
 * them "Unit details" / "Product details" / "About this vehicle" / …), and the
 * "Getting around" location widget (Walk / Transit / Bike score + nearby
 * transit), which is useful context for any located listing. We cut from the ad
 * / seller card onward.
 */

/**
 * Line (already trimmed, short) that marks the start of the trailing chrome.
 * Everything from the first match onward is dropped. Deliberately excludes the
 * "Getting around" / Walk Score / "Nearby transport" block so it survives.
 */
const CHROME_BOUNDARY =
  /^(ad|sponsored|seller information|seller details|about (the|this) seller|meet the seller|report this listing|today.?s picks|more listings|more from |more like this|related$|related listings|people also viewed|you might also like|you may also like|suggested for you|similar (listings|items|products)|explore more|marketplace\s*›?$)/i;

/** UI-only lines to drop anywhere in the kept region. */
const UI_NOISE =
  /^(message|send|send seller a message|save|share|see more|see less|buy now|make offer|add to cart|provided by walk score.*|report|·)$/i;

export function cleanListingText(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const original = raw;
  const lines = raw.split("\n");

  // 1. find the chrome boundary — first short line that matches a marker.
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l.length > 0 && l.length <= 40 && CHROME_BOUNDARY.test(l)) {
      cut = i;
      break;
    }
  }

  // 2. keep everything above it, minus UI-only lines and trailing "See more".
  const kept: string[] = [];
  for (let i = 0; i < cut; i++) {
    const l = lines[i]!
      .replace(/\s*See (more|less)\s*$/i, "")
      .replace(/\s+$/, "");
    const t = l.trim();
    if (!t) {
      if (kept.length && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (UI_NOISE.test(t)) continue;
    kept.push(l);
  }
  while (kept.length && kept[kept.length - 1] === "") kept.pop();

  let out = kept.join("\n").trim();

  // 3. safety net: if markers drifted (localised page, layout change) and we
  //    gutted a real description, keep the original rather than starve the model.
  if (
    out.length < 40 ||
    (original.trim().length > 400 && out.length < original.trim().length * 0.08)
  ) {
    out = original.trim();
  }

  // 4. backstop cap for the pathological "no marker matched at all" case.
  return out.length > 3000 ? out.slice(0, 3000) : out;
}
