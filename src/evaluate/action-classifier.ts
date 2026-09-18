import { z } from "zod";
import { CANDIDATE_ACTIONS } from "../domain/candidate-actions.js";
import type { EvalProvider } from "./provider/index.js";
import { extractJson } from "./runner.js";

const ACTION_KEYS = Object.keys(CANDIDATE_ACTIONS) as [string, ...string[]];

export const ActionClassificationSchema = z.object({
  /** null when the reply doesn't clearly map to a workflow action. */
  action: z.enum(ACTION_KEYS).nullable(),
  comment: z.string().nullable().catch(null),
  confidence: z.coerce.number().min(0).max(1).catch(0),
});
export type ActionClassification = z.infer<typeof ActionClassificationSchema>;

const ACTION_LIST = Object.entries(CANDIDATE_ACTIONS)
  .map(([key, def]) => `  - "${key}"${def.commentRequired ? " (needs a comment)" : ""}`)
  .join("\n");

function buildPrompt(text: string): string {
  return [
    "You are turning a short human reply about a marketplace listing into one",
    "structured workflow action. The known actions are:",
    ACTION_LIST,
    "",
    "If the reply doesn't clearly map to one of these (small talk, a question,",
    'ambiguous), set "action" to null rather than guessing.',
    "",
    `Reply to classify:\n"""\n${text}\n"""`,
    "",
    "Respond with ONLY a single JSON object (no markdown, no prose) of exactly this shape:",
    '{ "action": one of the action names above, or null, "comment": string extracted from the reply (or null), "confidence": number 0..1 }',
  ].join("\n");
}

/**
 * Classify a free-text reply (Telegram, or any future inbound channel) into a
 * candidate workflow action. Mirrors `evaluator.ts`'s own pattern exactly —
 * zod-validated structured output over the same swappable `EvalProvider` —
 * rather than inventing a second AI-classification approach for the bot.
 * Returns null (not a thrown error) when the model's reply itself can't be
 * parsed as JSON; a genuine provider failure (missing key, network) still
 * throws, same as `evaluateListing`.
 */
export async function classifyReply(
  text: string,
  provider: EvalProvider,
): Promise<ActionClassification | null> {
  const reply = await provider.complete(buildPrompt(text));
  try {
    return ActionClassificationSchema.parse(extractJson(reply.text));
  } catch {
    return null;
  }
}
