/**
 * content.ts — Content script for SIH26171 browser agent.
 *
 * Responsibilities:
 *  - Listen for RUN_AGENT triggers from the popup or from a page-level
 *    SIH_RUN_AGENT CustomEvent (e.g. the demo page's "Run Full Agent
 *    Pipeline" button)
 *  - Relay the task to the background service worker, which does the
 *    DOM scan, vision inference, redaction, server call, AND executes
 *    the resulting ActionPlan directly on the tab (see background.ts).
 *    Content script does NOT re-execute actions itself — that would
 *    run every action twice.
 *  - Bridge progress back to the triggering page via SIH_AGENT_ACK /
 *    SIH_AGENT_RESULT / SIH_AGENT_ERROR CustomEvents so a page-level
 *    trigger (which has no other way to observe the extension) can
 *    show real status instead of firing blind.
 */

import { RunAgentMessage, ContentMessage } from "./types/contracts";

console.log("[BrowserAgent:content] Content script loaded on", location.href);

// ---------------------------------------------------------------------------
// Message handling — receive from popup, background, or the page itself
// ---------------------------------------------------------------------------

/**
 * Kick off the agent pipeline in the background service worker. Background
 * owns the DOM scan, inference, redaction, server call, AND executes the
 * resulting ActionPlan on this tab (see background.ts `runAgentPipeline`) —
 * this function must not execute actions itself, or every action would run
 * twice.
 *
 * Also re-broadcasts progress as CustomEvents on `window` so a page-level
 * trigger (which has no other way to see into the extension) gets visible
 * feedback instead of firing blind.
 */
async function triggerAgent(task: string): Promise<void> {
  console.log("[BrowserAgent:content] Triggering agent with task:", task);
  window.dispatchEvent(new CustomEvent("SIH_AGENT_ACK", { detail: { task } }));

  try {
    const message: RunAgentMessage = { type: "RUN_AGENT", task };
    const response = await chrome.runtime.sendMessage<RunAgentMessage, ContentMessage>(message);

    if (response.type === "AGENT_ERROR") {
      console.error("[BrowserAgent:content] Agent error:", response.error);
      window.dispatchEvent(
        new CustomEvent("SIH_AGENT_ERROR", { detail: { error: response.error } })
      );
      return;
    }

    console.log("[BrowserAgent:content] Action plan received:", response.actionPlan);
    console.log("[BrowserAgent:content] Performance log:", response.log);
    window.dispatchEvent(
      new CustomEvent("SIH_AGENT_RESULT", {
        detail: {
          actionCount: response.actionPlan.actions.length,
          log: response.log,
          // The exact image bytes that were sent to the VLM — lets the
          // triggering page show real proof of what left the device.
          redactedImageDataUrl: `data:image/png;base64,${response.redactedImageBase64}`,
        },
      })
    );
  } catch (err) {
    let error = (err as Error).message;
    if (error.includes("Extension context invalidated")) {
      error =
        "Extension context invalidated — the extension was reloaded/rebuilt after this " +
        "tab was opened. Refresh this tab (F5) and try again.";
    }
    console.error("[BrowserAgent:content] Failed to reach background service worker:", error);
    window.dispatchEvent(new CustomEvent("SIH_AGENT_ERROR", { detail: { error } }));
  }
}

// Listen for CustomEvent dispatched from web pages (e.g. demo page button)
window.addEventListener("SIH_RUN_AGENT", (event: Event) => {
  const customEvent = event as CustomEvent<{ task: string }>;
  const task = customEvent.detail?.task || "Fill out the form";
  console.log("[BrowserAgent:content] Received SIH_RUN_AGENT CustomEvent:", task);
  triggerAgent(task).catch(console.error);
});

// Also listen for direct messages from background (alternative trigger path)
chrome.runtime.onMessage.addListener(
  (message: { type: string; task?: string }) => {
    if (message.type === "TRIGGER_AGENT" && message.task) {
      triggerAgent(message.task).catch(console.error);
    }
  }
);
