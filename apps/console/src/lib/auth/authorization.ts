/**
 * Shared server-side authorization boundary for financial write operations in Kanakku Console.
 * Strictly restricts confirmation and ledger mutations to 'owner' and 'accountant' roles,
 * and validates unambiguous human confirmation and cancellation intent.
 */

export class AuthorizationError extends Error {
  readonly statusCode: number = 403;
  readonly role?: string;

  constructor(message: string, role?: string) {
    super(message);
    this.name = 'AuthorizationError';
    this.role = role;
  }
}

/**
 * Returns true if the provided role has permissions to execute ledger writes / confirm financial drafts.
 * Only 'owner' and 'accountant' roles are authorized; 'member' or undefined roles are rejected.
 */
export function isAuthorizedForLedgerWrite(role?: string): boolean {
  return role === 'owner' || role === 'accountant';
}

/**
 * Asserts that the caller has sufficient role permissions to confirm financial actions or mutate the ledger.
 * Throws AuthorizationError (HTTP 403) if unauthorized.
 */
export function assertAuthorizedForLedgerWrite(role?: string): void {
  if (!isAuthorizedForLedgerWrite(role)) {
    throw new AuthorizationError(
      `FORBIDDEN: User role '${role ?? 'unknown'}' is not authorized to execute ledger writes`,
      role,
    );
  }
}

/**
 * Contradictory, conditional, qualifying, or hesitation words that negate or qualify confirmation.
 * Any presence of these words immediately invalidates an utterance from being an unambiguous confirmation.
 */
export const CONTRADICTORY_OR_CONDITIONAL_REGEX =
  /\b(but|except|unless|however|although|if|wait|hold|pause|don't|dont|do not|not|never|cancel|stop|abort|reject|discard|later|instead|maybe)\b/i;

/**
 * Terms that negate, condition, or question cancellation, or express hesitation.
 * Any presence of these disqualifies an utterance from being an unambiguous cancellation.
 */
export const CANCELLATION_CONTRADICTORY_OR_CONDITIONAL_REGEX =
  /\b(yet|wait|hold|pause|keep|save|confirm|if|unless|except|however|although|maybe|later|not yet)\b/i;

/**
 * Phrases that explicitly tell the system NOT to cancel/discard.
 */
export const DO_NOT_CANCEL_REGEX =
  /\b(don't|dont|do not|never)\s+(cancel|discard|abort|delete|reject|stop)\b/i;

/**
 * Closed vocabulary of allowed words in an affirmative confirmation utterance.
 * Words outside this list signal queries, conditions, or unrelated statements.
 */
const ALLOWED_CONFIRMATION_WORDS = new Set([
  'confirm',
  'confirmed',
  'yes',
  'yeah',
  'yep',
  'proceed',
  'approve',
  'approved',
  'save',
  'sure',
  'ok',
  'okay',
  'it',
  'this',
  'that',
  'the',
  'transaction',
  'draft',
  'books',
  'record',
  'please',
  'now',
  'ahead',
  'go',
  'do',
  'looks',
  'good',
  'and',
  'post',
  'lock',
  'locked',
  'close',
  'closed',
  'month',
]);

/**
 * Primary anchor tokens required for an affirmative confirmation.
 */
const PRIMARY_AFFIRMATIVE_TOKENS = new Set([
  'confirm',
  'confirmed',
  'yes',
  'yeah',
  'yep',
  'proceed',
  'approve',
  'approved',
  'sure',
  'ok',
  'okay',
]);

/**
 * Closed vocabulary of allowed words in an unambiguous cancellation utterance.
 */
const ALLOWED_CANCELLATION_WORDS = new Set([
  'cancel',
  'cancelled',
  'discard',
  'discarded',
  'abort',
  'aborted',
  'reject',
  'rejected',
  'no',
  'nope',
  'nah',
  'stop',
  'nevermind',
  'it',
  'this',
  'that',
  'the',
  'draft',
  'transaction',
  'action',
  'please',
  'now',
  'do',
  'dont',
  "don't",
]);

/**
 * Primary anchor tokens required for an affirmative cancellation.
 */
const PRIMARY_CANCELLATION_TOKENS = new Set([
  'cancel',
  'cancelled',
  'discard',
  'discarded',
  'abort',
  'aborted',
  'reject',
  'rejected',
  'nevermind',
  'no',
  'nope',
]);

/**
 * Asserts whether a voice transcript expresses an unambiguous confirmation intent.
 */
export function isConfirmationIntent(transcript: string): boolean {
  if (!transcript || typeof transcript !== 'string') {
    return false;
  }

  const trimmed = transcript.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }

  // 1. Disqualify if contradictory, conditional, or negating expressions are present
  if (CONTRADICTORY_OR_CONDITIONAL_REGEX.test(trimmed)) {
    return false;
  }

  // 2. Tokenize alphanumeric words
  const words = trimmed
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return false;
  }

  // 3. Must contain at least one primary affirmative token
  const hasPrimaryAffirmation = words.some((w) => PRIMARY_AFFIRMATIVE_TOKENS.has(w));
  if (!hasPrimaryAffirmation) {
    const hasIdiom = /\b(looks good|go ahead|post it|do it|save it)\b/i.test(trimmed);
    if (!hasIdiom) {
      return false;
    }
  }

  // 4. Every token must belong to the permitted confirmation vocabulary
  const allWordsAllowed = words.every((w) => ALLOWED_CONFIRMATION_WORDS.has(w));
  if (!allWordsAllowed) {
    return false;
  }

  return true;
}

/**
 * Asserts whether a voice transcript expresses an unambiguous cancellation intent.
 *
 * Strict safety rules:
 * 1. Must NOT contain negation of cancellation (e.g. "don't cancel", "do not discard").
 * 2. Must NOT contain contradictory, conditional, or hesitation terms (e.g. "yet", "wait", "hold", "keep", "if", "unless").
 * 3. Must contain at least one primary cancellation token (e.g. "cancel", "discard", "abort", "reject", "no").
 * 4. Every token must belong to the permitted cancellation vocabulary.
 *
 * Rejects:
 * - "No, don't cancel yet" (contains "don't cancel", "yet")
 * - "No, wait a minute" (contains "wait")
 * - "No, keep it" (contains "keep")
 * - "Cancel if total is wrong" (contains "if")
 * - "No, I want to confirm" (contains "confirm")
 *
 * Accepts:
 * - "Cancel"
 * - "Cancel it"
 * - "No, cancel this draft"
 * - "Discard"
 * - "Abort"
 * - "Reject"
 * - "Nevermind"
 * - "No, don't do that"
 */
export function isCancellationIntent(transcript: string): boolean {
  if (!transcript || typeof transcript !== 'string') {
    return false;
  }

  const trimmed = transcript.trim().toLowerCase();
  if (!trimmed) {
    return false;
  }

  // 1. Immediately reject phrases that tell the system NOT to cancel
  if (DO_NOT_CANCEL_REGEX.test(trimmed)) {
    return false;
  }

  // 2. Immediately reject contradictory, conditional, or hesitation terms
  if (CANCELLATION_CONTRADICTORY_OR_CONDITIONAL_REGEX.test(trimmed)) {
    return false;
  }

  // Special-case allowed cancellation phrase "don't do that" / "dont do that"
  if (/^(\s*no\s*,?\s*)?(don't|dont|do not)\s+do\s+that\s*$/i.test(trimmed)) {
    return true;
  }

  // 3. Tokenize alphanumeric words
  const words = trimmed
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) {
    return false;
  }

  // 4. Must contain at least one primary cancellation token
  const hasPrimaryCancellation = words.some((w) => PRIMARY_CANCELLATION_TOKENS.has(w));
  if (!hasPrimaryCancellation) {
    return false;
  }

  // 5. Every token must belong to the permitted cancellation vocabulary
  const allWordsAllowed = words.every((w) => ALLOWED_CANCELLATION_WORDS.has(w));
  if (!allWordsAllowed) {
    return false;
  }

  return true;
}
