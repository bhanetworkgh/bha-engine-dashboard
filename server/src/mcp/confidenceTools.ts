/**
 * VFARM_CONFIDENCE_SCORING_V0 over MCP (28 Nov 2026, Destiny — LOOP-1795071778245-XHRR).
 *
 *   check_confidence_gate — read only, both connections: one commercial card's score,
 *                           band, every part with its points, and whether it passes the
 *                           pilot gate and the actuation gate, naming what is missing.
 *                           The same functions the write path enforces (confidenceScore.ts).
 */
import * as cs from '../confidenceScore';
import { query } from '../pg';
import type { ToolDefinition } from './tools';

export const checkConfidenceGateTool: ToolDefinition = {
  name: 'check_confidence_gate',
  description:
    `One commercial card's confidence under ${cs.RULE.version} (SOP ${cs.RULE.sop}): a 0 to 100 score counted only from what is recorded on the card (citations across research passes up to ${cs.RULE.citation_max}, research passes up to ${cs.RULE.pass_max}, a recorded experiment result ${cs.RULE.experiment_points}, builder logs up to ${cs.RULE.log_max}, minus ${cs.RULE.open_question_penalty} per open research question), its band (Low under ${cs.RULE.medium_from}, Medium, High from ${cs.RULE.high_from}), every part with its points, and two gates: pilot (High and no open questions) and actuation (High and a recorded experiment result), each with what is missing. The model-written confidence label is shown as model_label and is never an input. Any path that would start a pilot or drive actuation from a card asks this first; a pilot start is also refused on the write itself. Read only.`,
  inputSchema: {
    type: 'object',
    properties: { card_id: { type: 'string', description: 'The card id, CARD-...' } },
    required: ['card_id'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false, title: "Check a commercial card's confidence gate" },
  handler: async (args) => {
    const cardId = typeof args.card_id === 'string' ? args.card_id.trim() : '';
    if (!cardId) return { ok: false, reason: 'card_id_required', message: 'Name the card by its card_id (CARD-...).' };
    const r = await query<{ fields: Record<string, unknown> }>('SELECT fields FROM engine_commercial_cards WHERE natural_id = $1 ORDER BY updated_at DESC LIMIT 1', [cardId]);
    const fields = r.rows[0]?.fields;
    if (!fields) return { ok: false, reason: 'card_not_found', message: `No commercial card is held under ${cardId}.` };
    const c = cs.score(fields);
    return { ok: true, card_id: cardId, title: fields.opportunity_title ?? null, ...c, gates: { pilot: cs.gate(fields, 'pilot'), actuation: cs.gate(fields, 'actuation') }, rule: cs.RULE };
  },
};

export const CONFIDENCE_READ_TOOLS: ToolDefinition[] = [checkConfidenceGateTool];
