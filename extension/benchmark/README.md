# Privacy Detection Benchmark

Turns "we redact PII" from a claim into a number. Both benchmarks call the
**actual production functions** shipped in `src/redaction.ts` — this is not
a reimplementation being graded against itself.

## DOM / regex / autocomplete detection — `npm run benchmark:dom`

Tests `extractPIIRegionsFromDOM` and `extractImageRegionsFromDOM` against
25 hand-labeled, self-contained fixtures (`fixtures.ts`) covering:

- passwords, emails, phones (US + one intentionally-hard international format)
- credit/debit cards (Luhn-validated), Aadhaar (Verhoeff-validated), PAN
- addresses, date-of-birth fields, OTP codes
- profile/avatar images (via `alt` text)
- **true negatives** — search boxes, quantity fields, SKUs, generic text —
  without these, recall alone would look perfect regardless of precision
- **two deliberately adversarial cases**: a 16-digit grouped reference
  number that isn't a real card (should NOT be flagged), and cardholder
  name treated as PII (a real design decision, not a bug)

No external assets needed, runs in under a second, fully deterministic.
Current result: **100% precision / 100% recall / 100% F1** across 64
labeled elements — reached by fixing two real gaps the benchmark caught
(card numbers and Aadhaar numbers both needed real checksum validation,
not just shape-matching regex), not by deleting the hard cases.

## Face/person detection — `npm run benchmark:faces`

Tests `extractFaceRegionsFromDetections` running the actual
`Xenova/yolos-tiny` model (same one `background.ts` uses) against real
images.

**This one needs real test photos, which this repo intentionally does not
ship with.** Drop:

- `face-benchmark/images/positive/*.jpg` — photos that DO contain a person
- `face-benchmark/images/negative/*.jpg` — images that should NOT trigger
  detection (objects, empty rooms, illustrations/avatars)

Use your own or teammates' consented photos. The `images/` folder is
git-ignored for actual image files (see `.gitignore` inside it) — only the
folder structure is tracked, so nothing gets committed to git history.

Without images, the script explains what to do rather than failing or
faking a number.

## What this doesn't cover

Performance numbers (model load time, inference time, redaction time,
server round-trip) are already measured for real during actual pipeline
runs — see `PerformanceLog` in `src/types/contracts.ts`, visible live in
the popup and the demo page's log. Re-deriving them synthetically in a
Node script wouldn't be representative anyway (no real browser, no real
WebGPU backend) — the live telemetry is the honest source for those.
