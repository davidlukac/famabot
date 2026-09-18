import type { DB } from "../db/index.js";
import { getByFbId, getByTelegramMessageId } from "../db/listings.js";
import {
  CANDIDATE_ACTIONS,
  helpText,
  isCandidateAction,
} from "../domain/candidate-actions.js";
import { classifyReply } from "../evaluate/action-classifier.js";
import { getEvalProvider, type EvalProvider } from "../evaluate/provider/index.js";
import { applyCandidateAction } from "../services/candidate-workflow-service.js";
import { idFromHref } from "../scrape/parse.js";
import { log } from "../log.js";
import { sleep } from "../commands/shared.js";

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    text?: string;
    reply_to_message?: { message_id: number };
  };
}

interface ProcessResult {
  reply: string;
}

const CLARIFY_CONFIDENCE = 0.6;

/**
 * `/action fbId comment...` — the explicit, no-AI-needed path. `fbId` accepts
 * either the bare id or a full marketplace listing URL (e.g. pasted straight
 * from the Facebook app's share sheet) — same `idFromHref` the scraper itself
 * uses to pull an id out of an `/marketplace/item/<id>/` link.
 */
function parseSlashCommand(
  text: string,
): { action: string; fbId: string; comment: string | null } | null {
  const m = text.trim().match(/^\/(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/);
  if (!m) return null;
  return {
    action: m[1]!.replace(/-/g, "_"),
    fbId: idFromHref(m[2]!) ?? m[2]!,
    comment: m[3]?.trim() || null,
  };
}

function describe(fbId: string, fromPhase: string, toPhase: string | null): string {
  return toPhase
    ? `${fbId}: ${fromPhase} → ${toPhase}`
    : `${fbId}: noted (still ${fromPhase})`;
}

/**
 * Turn one inbound Telegram update into a reply + (usually) a candidate
 * action, factored out of the getUpdates loop so it's testable without a
 * network round-trip. A slash command (`/accept <fbId> <comment>`) applies
 * directly; free text is resolved to a listing via `reply_to_message` (the
 * candidate notification it's replying to) and classified with the same
 * AI-provider pattern the evaluator itself uses.
 */
export async function processUpdate(
  db: DB,
  update: TelegramUpdate,
  provider: EvalProvider,
): Promise<ProcessResult> {
  const msg = update.message;
  const text = msg?.text?.trim();
  if (!msg || !text) return { reply: "Nothing to do with that." };

  if (/^\/(help|start)\b/i.test(text)) {
    return { reply: helpText() };
  }

  const slash = parseSlashCommand(text);
  if (slash) {
    if (!isCandidateAction(slash.action)) {
      return {
        reply: `Unknown action "${slash.action}". Available commands:\n${helpText()}`,
      };
    }
    const row = getByFbId(db, slash.fbId);
    if (!row) return { reply: `No listing found for "${slash.fbId}".` };
    try {
      const result = applyCandidateAction(db, slash.fbId, slash.action, slash.comment);
      return { reply: describe(slash.fbId, result.fromPhase, result.toPhase) };
    } catch (err) {
      return { reply: (err as Error).message };
    }
  }

  const repliedId = msg.reply_to_message?.message_id;
  const row = repliedId != null ? getByTelegramMessageId(db, repliedId) : undefined;
  if (!row) {
    return {
      reply:
        "Reply to a candidate notification to act on it, or send one of these " +
        `(fbId can be the bare id or a listing URL):\n${helpText()}`,
    };
  }

  const classification = await classifyReply(text, provider);
  if (!classification || classification.action == null) {
    return {
      reply:
        "I didn't understand that as an action — could you clarify (e.g. accept / reject / hold)?",
    };
  }
  if (classification.confidence < CLARIFY_CONFIDENCE) {
    return {
      reply: `Not sure I read that right (confidence ${classification.confidence.toFixed(2)}) — could you clarify?`,
    };
  }
  // The schema already restricts `action` to isCandidateAction's key set, but
  // narrow explicitly so it indexes CANDIDATE_ACTIONS/applyCandidateAction
  // with a proper CandidateAction type rather than a bare string.
  if (!isCandidateAction(classification.action)) {
    return { reply: `Unknown action "${classification.action}".` };
  }
  const def = CANDIDATE_ACTIONS[classification.action];
  const comment = classification.comment?.trim() || (def.commentRequired ? text : null);
  try {
    const result = applyCandidateAction(db, row.fb_id, classification.action, comment);
    return { reply: describe(row.fb_id, result.fromPhase, result.toPhase) };
  } catch (err) {
    return { reply: (err as Error).message };
  }
}

async function sendReply(token: string, chatId: number, text: string): Promise<void> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) log.warn(`telegram-bot: reply failed HTTP ${res.status}`);
  } catch (err) {
    log.warn(`telegram-bot: reply failed: ${(err as Error).message}`);
  }
}

/**
 * Long-poll Telegram's getUpdates for inbound replies, same shape as `watch`'s
 * poll loop — no public HTTPS endpoint needed. Only messages from
 * FAMABOT_TELEGRAM_CHAT_ID are honored (same trust boundary as outbound).
 */
export async function runTelegramBot(
  db: DB,
  opts: { pollTimeoutS?: number } = {},
): Promise<never> {
  const token = process.env.FAMABOT_TELEGRAM_BOT_TOKEN;
  const chatId = process.env.FAMABOT_TELEGRAM_CHAT_ID;
  if (!token) throw new Error("FAMABOT_TELEGRAM_BOT_TOKEN not set");
  if (!chatId) throw new Error("FAMABOT_TELEGRAM_CHAT_ID not set");
  const provider = getEvalProvider();
  const timeoutS = opts.pollTimeoutS ?? 30;

  let offset = 0;
  log.info("telegram-bot: listening for replies (long-polling)…");
  for (;;) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?timeout=${timeoutS}&offset=${offset}`,
        { signal: AbortSignal.timeout((timeoutS + 10) * 1000) },
      );
      if (!res.ok) {
        log.warn(`telegram-bot: getUpdates HTTP ${res.status}`);
        await sleep(5000);
        continue;
      }
      const payload = (await res.json()) as { result: TelegramUpdate[] };
      for (const update of payload.result) {
        offset = update.update_id + 1;
        const fromChat = update.message?.chat.id;
        if (fromChat == null || String(fromChat) !== String(chatId)) {
          log.warn(`telegram-bot: ignored message from unauthorized chat ${fromChat}`);
          continue;
        }
        const text = update.message?.text ?? "";
        const replyTo = update.message?.reply_to_message?.message_id;
        log.info(
          `telegram-bot: received "${text}"${replyTo ? ` (reply to msg ${replyTo})` : ""}`,
        );
        const { reply } = await processUpdate(db, update, provider);
        log.info(`telegram-bot: replying "${reply}"`);
        await sendReply(token, fromChat, reply);
      }
    } catch (err) {
      log.warn(`telegram-bot: poll failed: ${(err as Error).message}`);
      await sleep(5000);
    }
  }
}
