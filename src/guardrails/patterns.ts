export interface GuardrailPattern {
  label: string;
  pattern: RegExp;
}

/**
 * Same shapes and the same "bounded quantifiers, no chains of adjacent
 * optional groups" discipline as the gateway's own PII_PATTERNS
 * (services/observation-worker/src/evaluators.ts) - these are coarse
 * heuristics, not a compliance-grade classifier. False positives are
 * expected and acceptable; the job is to flag, not to be a perfect filter.
 * Shipped as data so it's easy to extend without touching check.ts.
 */
export const BUILT_IN_PATTERNS: GuardrailPattern[] = [
  { label: "email", pattern: /[^\s@]{1,64}@[^\s@.]{1,255}\.[^\s@]{2,24}/ },
  { label: "ssn", pattern: /\b\d{3}-\d{2}-\d{4}\b/ },
  { label: "credit_card", pattern: /\b\d{13,16}\b/ },
  { label: "credit_card_grouped", pattern: /\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}\b/ },
  { label: "phone", pattern: /\b\d{3}[ .-]\d{3}[ .-]\d{4}\b/ },
  { label: "phone_parens", pattern: /\b\(\d{3}\)[ .-]?\d{3}[ .-]?\d{4}\b/ },
  { label: "api_key_token", pattern: /\b(?:sk|pk|gsk|fw|obs)_[A-Za-z0-9_-]{16,}\b/ },
];
