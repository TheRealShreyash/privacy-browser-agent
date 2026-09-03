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

export type BackgroundMessage = RunAgentMessage;
export type ContentMessage = AgentResultMessage | AgentErrorMessage;

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
  redactedRegions: number;    // number of regions blurred/blacked out
  domElementCount: number;    // number of DOM elements sent to the VLM — 0 here explains an empty ActionPlan
  inferenceError?: string;    // set if the ONNX vision model threw — explains detectionCount being 0 despite a real subject in frame
  timestamp: string;          // ISO 8601
}
