/**
 * contracts.ts — Locked JSON contracts for SIH26171
 *
 * These interfaces define the wire format between:
 *   - Extension (client) → Server:  SanitizedContext
 *   - Server → Extension (client):  ActionPlan
 *
 * Do NOT modify field names without updating both the Zod schemas
 * in /server/src/schemas.ts and this file simultaneously.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export interface BoundingBox {
  x: number;      // pixels from left of viewport
  y: number;      // pixels from top of viewport
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Sanitized context payload  (Extension → Server)
// ---------------------------------------------------------------------------

/** One interactive / visible element extracted from the live DOM. */
export interface DomElement {
  tag: string;           // e.g. "input", "button", "a"
  id?: string;           // element ID if present (e.g. "emailField")
  name?: string;         // name attribute if present
  selector?: string;     // suggested unique CSS selector (e.g. "#emailField")
  role?: string;         // ARIA role if present
  /** input/button "type" attribute (e.g. "password", "email", "tel", "submit").
   *  Never the field's value — used as a reliable PII signal since password
   *  field *text* is intentionally omitted below. */
  type?: string;
  /** autocomplete attribute (e.g. "cc-number", "one-time-code", "bday") —
   *  a strong PII-category signal the browser itself already exposes. */
  autocomplete?: string;
  boundingBox: BoundingBox;
  text?: string;         // visible label / inner text (truncated to 120 chars) — omitted for password fields
}

/**
 * The full sanitized context sent to the server after local PII redaction.
 * redactedImage is a base64-encoded PNG data URL (no "data:image/png;base64,"
 * prefix — raw base64 only, to keep payload compact).
 */
export interface SanitizedContext {
  redactedImage: string;       // raw base64 PNG (PII already blurred/blacked out)
  domSummary: DomElement[];
  task: string;                // natural-language instruction from the user
}

// ---------------------------------------------------------------------------
// Action plan response  (Server → Extension)
// ---------------------------------------------------------------------------

export type ActionType = "click" | "scroll" | "type";

export interface Action {
  type: ActionType;
  selector: string;   // CSS selector targeting the element
  value?: string;     // required for "type"; scroll delta (px) as string for "scroll"
}

export interface ActionPlan {
  actions: Action[];
}

// ---------------------------------------------------------------------------
// Extension-internal message protocol (content ↔ background)
// ---------------------------------------------------------------------------

export interface RunAgentMessage {
  type: "RUN_AGENT";
  task: string;
}

export interface AgentResultMessage {
  type: "AGENT_RESULT";
  actionPlan: ActionPlan;
  log: PerformanceLog;
  /** Raw base64 PNG (no data URL prefix) — the exact redacted image that was
   *  sent to the VLM. Included so a triggering page can display real proof
   *  of what left the device, instead of the redaction being invisible. */
  redactedImageBase64: string;
}

export interface AgentErrorMessage {
  type: "AGENT_ERROR";
  error: string;
}

/**
 * Privacy leakage comparison: one screenshot capture, sent to the VLM two
 * ways — raw (what a naive "just screenshot the tab" agent would send) and
 * redacted (what this extension actually sends) — so the difference is a
 * real, side-by-side, non-simulated result rather than a mockup. Only the
 * redacted plan's actions are executed on the page, to avoid filling the
 * form twice; the naive plan's action count still comes back for real,
 * proving the cloud model handles the redacted image just as well.
 */
export interface RunComparisonMessage {
  type: "RUN_COMPARISON";
  task: string;
}

export interface ComparisonResultMessage {
  type: "COMPARISON_RESULT";
  naive: { actionPlan: ActionPlan; imageBase64: string };
  redacted: { actionPlan: ActionPlan; imageBase64: string };
  log: PerformanceLog;
}

export interface ComparisonErrorMessage {
  type: "COMPARISON_ERROR";
  error: string;
}

export type BackgroundMessage = RunAgentMessage | RunComparisonMessage;
export type ContentMessage = AgentResultMessage | AgentErrorMessage;
export type ComparisonContentMessage = ComparisonResultMessage | ComparisonErrorMessage;

// ---------------------------------------------------------------------------
// Performance / observability
// ---------------------------------------------------------------------------

/**
 * Captured at each stage of the pipeline for D7 reporting.
 * All durations in milliseconds.
 */
export interface PerformanceLog {
  modelLoadMs: number;        // time to load + warm up ONNX model (0 if cached)
  inferenceMs: number;        // time to run object-detection inference
  redactionMs: number;        // time to apply canvas redaction
  payloadSizeBytes: number;   // byte length of SanitizedContext JSON
  serverRoundtripMs: number;  // fetch start → response received
  totalMs: number;            // wall-clock start → executor first action
  deviceBackend: "webgpu" | "wasm";   // which ONNX backend was used
  detectionCount: number;     // number of objects detected before redaction
  redactedRegions: number;    // number of regions blurred/blacked out (faceRegions + piiRegions)
  faceRegions: number;        // of redactedRegions, how many were faces (ML-detected or DOM-flagged)
  piiRegions: number;         // of redactedRegions, how many were PII fields (password/email/phone/card/etc.)
  domElementCount: number;    // number of DOM elements sent to the VLM — 0 here explains an empty ActionPlan
  inferenceError?: string;    // set if the ONNX vision model threw — explains detectionCount being 0 despite a real subject in frame
  timestamp: string;          // ISO 8601
}
