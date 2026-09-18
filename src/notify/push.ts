import { execFile } from "node:child_process";
import type { BrowserContext } from "playwright";
import { log } from "../log.js";
import type { ListingRow } from "../types.js";

export interface CandidateMsg {
  fbId: string;
  title: string;
  price: string;
  location: string;
  score: number;
  reason: string;
  url: string;
  search: string;
}

/**
 * Canonical listing URL. On a phone with the Facebook app installed this opens
 * the app straight on the listing via universal / app links; otherwise it opens
 * mobile web. (The `fb://` custom scheme was unreliable — it landed on the
 * generic Marketplace feed on some app versions — so we don't use it.)
 */
export function fbListingLink(fbId: string): string {
  return `https://www.facebook.com/marketplace/item/${fbId}/`;
}

/** Mobile web variant, for the notification body text. */
export function fbMobileLink(fbId: string): string {
  return `https://m.facebook.com/marketplace/item/${fbId}/`;
}

/** Which backends are enabled, from FAMABOT_NOTIFY (comma-separated). */
function backends(): string[] {
  return (process.env.FAMABOT_NOTIFY ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function notifyEnabled(): boolean {
  return backends().length > 0;
}

/** Build a notification payload from a listing row. */
export function candidateMsg(c: ListingRow, prefix = ""): CandidateMsg {
  return {
    fbId: c.fb_id,
    title: `${prefix}${c.title ?? "(untitled)"}`,
    price: c.price != null ? `${c.currency ?? ""}${c.price}` : "price?",
    location: c.location ?? "",
    score: c.eval_score ?? 0,
    reason: (c.eval_reasoning ?? "").slice(0, 400),
    url: c.url,
    search: c.search_key,
  };
}

const ascii = (s: string) => s.replace(/[^\x20-\x7E]/g, "").trim();

export interface NotifyResult {
  /** Whether at least one backend actually succeeded — callers should only
   *  record the listing as notified when this is true, so a transient
   *  failure (network blip, rate limit) can be retried later
   *  (`famabot notify`) instead of being silently and permanently dropped. */
  sent: boolean;
  /** The Telegram message id, if the `telegram` backend sent one — lets a
   *  caller remember which message a future reply might be about. */
  telegramMessageId: number | null;
}

/** Fire all configured notification backends for one candidate. Never throws. */
export async function notifyCandidate(
  msg: CandidateMsg,
  ctx?: BrowserContext,
): Promise<NotifyResult> {
  let sent = false;
  let telegramMessageId: number | null = null;
  for (const b of backends()) {
    try {
      if (b === "ntfy") await sendNtfy(msg);
      else if (b === "telegram") telegramMessageId = await sendTelegram(msg);
      else if (b === "command") await sendCommand(msg);
      else if (b === "messenger") await sendMessenger(msg, ctx);
      else {
        log.warn(`notify: unknown backend "${b}"`);
        continue;
      }
      sent = true;
    } catch (err) {
      log.warn(`notify(${b}) failed: ${(err as Error).message}`);
    }
  }
  return { sent, telegramMessageId };
}

const htmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Send via a Telegram bot. Needs FAMABOT_TELEGRAM_BOT_TOKEN (from @BotFather) and
 * FAMABOT_TELEGRAM_CHAT_ID (your user id, or a group/channel id — the bot must be
 * a member). Get the chat id by messaging the bot once then reading
 * https://api.telegram.org/bot<token>/getUpdates.
 *
 * Returns the sent message's id, so a caller (`services/notifications.ts`) can
 * remember which candidate it was about — `telegram-bot.ts` resolves a reply
 * back to the right listing via that id (`listings.telegram_message_id`).
 */
async function sendTelegram(m: CandidateMsg): Promise<number | null> {
  const token = process.env.FAMABOT_TELEGRAM_BOT_TOKEN;
  const chatId = process.env.FAMABOT_TELEGRAM_CHAT_ID;
  if (!token) throw new Error("FAMABOT_TELEGRAM_BOT_TOKEN not set");
  if (!chatId) throw new Error("FAMABOT_TELEGRAM_CHAT_ID not set");
  const listing = fbListingLink(m.fbId);
  const text =
    `\u{1F3E0} <b>${htmlEsc(`${m.score.toFixed(2)} · ${m.price} · ${m.title}`)}</b>\n` +
    (m.location ? `\u{1F4CD} ${htmlEsc(m.location)}\n` : "") +
    `\n${htmlEsc(m.reason)}\n\n` +
    `<a href="${listing}">${listing}</a>\n` +
    `<i>${htmlEsc(m.search)}</i>`;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { url: listing },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  log.info(`notify: sent Telegram message (${m.title})`);
  const payload = (await res.json().catch(() => null)) as {
    result?: { message_id?: number };
  } | null;
  return payload?.result?.message_id ?? null;
}

async function sendNtfy(m: CandidateMsg): Promise<void> {
  const url = process.env.FAMABOT_NTFY_URL;
  if (!url) throw new Error("FAMABOT_NTFY_URL not set");
  const listing = fbListingLink(m.fbId);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Title: ascii(`${m.score.toFixed(2)} · ${m.price} · ${m.title}`).slice(0, 200),
      // This https URL opens the FB app straight on the listing (universal link).
      Click: listing,
      Priority: "high",
      Tags: "house",
    },
    body: `${m.location}\n\n${m.reason}\n\n${listing}`,
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
  log.info(`notify: pushed to ntfy (${m.title})`);
}

async function sendCommand(m: CandidateMsg): Promise<void> {
  const cmd = process.env.FAMABOT_NOTIFY_CMD;
  if (!cmd) throw new Error("FAMABOT_NOTIFY_CMD not set");
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.env.SHELL || "/bin/sh",
      ["-c", cmd],
      {
        env: {
          ...process.env,
          FAMABOT_TITLE: m.title,
          FAMABOT_PRICE: m.price,
          FAMABOT_LOCATION: m.location,
          FAMABOT_SCORE: String(m.score),
          FAMABOT_REASON: m.reason,
          FAMABOT_URL: m.url,
          FAMABOT_LISTING_URL: fbListingLink(m.fbId),
          FAMABOT_MOBILE_URL: fbMobileLink(m.fbId),
          FAMABOT_SEARCH: m.search,
        },
        timeout: 30_000,
      },
      (err) => (err ? reject(err) : resolve()),
    );
  });
  log.info(`notify: ran FAMABOT_NOTIFY_CMD (${m.title})`);
}

/**
 * Post into a Messenger thread using the already-logged-in browser session.
 * Needs FAMABOT_MESSENGER_THREAD (e.g. https://www.facebook.com/messages/t/<id>).
 * Best-effort and fragile — Messenger's DOM is unstable.
 */
// Drives a real Playwright BrowserContext (getByRole/locator/keyboard against
// a live Messenger DOM) — not economical to unit test; see the same note on
// scrape/marketplace.ts's scrapeSearch/scrapeDetail.
/* node:coverage disable */
async function sendMessenger(m: CandidateMsg, ctx?: BrowserContext): Promise<void> {
  const thread = process.env.FAMABOT_MESSENGER_THREAD;
  if (!thread) throw new Error("FAMABOT_MESSENGER_THREAD not set");
  if (!ctx) throw new Error("no browser context available");
  const page = await ctx.newPage();
  try {
    await page.goto(thread, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);
    const box = page
      .getByRole("textbox", { name: /message|aa/i })
      .last()
      .or(page.locator('div[contenteditable="true"][role="textbox"]').last());
    await box.click({ timeout: 15_000 });
    await box.fill(
      `🏠 ${m.score.toFixed(2)} · ${m.price} · ${m.title} — ${m.location}\n${m.reason}\n${m.url}`,
    );
    await page.keyboard.press("Enter");
    await page.waitForTimeout(2000);
    log.info(`notify: sent Messenger message (${m.title})`);
  } finally {
    await page.close().catch(() => {});
  }
}
/* node:coverage enable */
