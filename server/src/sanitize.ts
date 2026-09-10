/**
 * sanitize.ts — Server-side defense-in-depth PII scan.
 *
 * The extension already redacts PII on-device before sending anything here.
 * This module does NOT rely on that being correct. It independently
 * re-scans the (already supposedly sanitized) `domSummary` text fields for
 * PII-shaped content and masks anything that slipped through before the
 * payload is ever handed to the VLM prompt builder — belt and suspenders,
 * not "trust the client."
 */

import { SanitizedContextInput } from "./schemas";

const PII_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: "phone", pattern: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  { name: "aadhaar", pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/g },
  { name: "pan", pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g },
  { name: "card", pattern: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/g },
];

export interface SanitizeResult {
  domSummary: SanitizedContextInput["domSummary"];
  /** Count of fields where server-side scanning masked something the
   *  client-side redaction should already have removed. Non-zero here
   *  means the client's redaction has a gap worth investigating. */
  leaksCaught: number;
}

/** Re-scans domSummary text for PII patterns and masks any matches found. */
export function sanitizeDomSummary(
  domSummary: SanitizedContextInput["domSummary"]
): SanitizeResult {
  let leaksCaught = 0;

  const sanitized = domSummary.map((el) => {
    if (!el.text) return el;

    let text = el.text;
    for (const { pattern } of PII_PATTERNS) {
      if (pattern.test(text)) {
        leaksCaught++;
        text = text.replace(pattern, "[REDACTED]");
      }
      pattern.lastIndex = 0; // reset stateful global regex between elements
    }

    return text === el.text ? el : { ...el, text };
  });

  return { domSummary: sanitized, leaksCaught };
}
