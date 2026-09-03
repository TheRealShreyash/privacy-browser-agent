/**
 * logger.ts — Performance and observability logger for D7.
 *
 * Captures timing at each pipeline stage and persists to chrome.storage.local.
 * Displayed in the popup for live reporting.
 */

import { PerformanceLog } from "./types/contracts";

const STORAGE_KEY = "lastPerformanceLog";
const HISTORY_KEY = "performanceHistory";
const MAX_HISTORY = 50;

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/** Persist a completed performance log entry. */
export async function saveLog(log: PerformanceLog): Promise<void> {
  // Save latest
  await chrome.storage.local.set({ [STORAGE_KEY]: log });

  // Append to rolling history (capped at MAX_HISTORY entries)
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const history: PerformanceLog[] = stored[HISTORY_KEY] ?? [];
  history.push(log);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  await chrome.storage.local.set({ [HISTORY_KEY]: history });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Retrieve the most recent log entry. */
export async function getLastLog(): Promise<PerformanceLog | null> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] ?? null;
}

/** Retrieve the full history (newest first). */
export async function getHistory(): Promise<PerformanceLog[]> {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const history: PerformanceLog[] = stored[HISTORY_KEY] ?? [];
  return [...history].reverse();
}

// ---------------------------------------------------------------------------
// Formatting helpers (used by popup.ts)
// ---------------------------------------------------------------------------

export function formatLog(log: PerformanceLog): string {
  return [
    `🕐 Total:          ${log.totalMs.toFixed(1)} ms`,
    `🔋 Model load:     ${log.modelLoadMs.toFixed(1)} ms`,
    `🔍 Inference:      ${log.inferenceMs.toFixed(1)} ms (${log.detectionCount} detections)`,
    `🛡  Redaction:      ${log.redactionMs.toFixed(1)} ms (${log.redactedRegions} regions)`,
    `🧩 DOM elements:   ${log.domElementCount}`,
    `📦 Payload:        ${(log.payloadSizeBytes / 1024).toFixed(1)} KB`,
    `🌐 Server RTT:     ${log.serverRoundtripMs.toFixed(1)} ms`,
    `⚙️  Backend:        ${log.deviceBackend.toUpperCase()}`,
    `🕓 At:             ${new Date(log.timestamp).toLocaleTimeString()}`,
  ].join("\n");
}

/** Compute summary statistics over a history array. */
export function summarizeHistory(history: PerformanceLog[]): {
  avgTotalMs: number;
  avgInferenceMs: number;
  avgServerMs: number;
  avgPayloadKB: number;
  piiRecall: number; // placeholder — needs ground truth
} {
  if (history.length === 0) {
    return { avgTotalMs: 0, avgInferenceMs: 0, avgServerMs: 0, avgPayloadKB: 0, piiRecall: 0 };
  }
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  return {
    avgTotalMs: avg(history.map((l) => l.totalMs)),
    avgInferenceMs: avg(history.map((l) => l.inferenceMs)),
    avgServerMs: avg(history.map((l) => l.serverRoundtripMs)),
    avgPayloadKB: avg(history.map((l) => l.payloadSizeBytes / 1024)),
    piiRecall: 0, // TODO: wire up evaluation ground truth in D7
  };
}
