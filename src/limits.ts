/**
 * Limits shared by the web client and the worker. The worker imports across
 * the boundary (same pattern as src/puzzle.ts) so the two can never drift.
 */

/** Max feedback message length: client textarea maxLength + worker reject threshold. */
export const FEEDBACK_MAX_CHARS = 1000;
