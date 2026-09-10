/**
 * popup.ts — Popup action script for SIH26171 browser agent.
 *
 * Sends the user's task to the active tab's content script (via background),
 * and displays the latest performance log.
 */

import { getLastLog, formatLog } from "./logger";

document.addEventListener("DOMContentLoaded", () => {
  const taskInput = document.getElementById("taskInput") as HTMLTextAreaElement;
  const runBtn = document.getElementById("runBtn") as HTMLButtonElement;
  const statusEl = document.getElementById("status") as HTMLDivElement;
  const logEl = document.getElementById("logOutput") as HTMLPreElement;
  const refreshLogBtn = document.getElementById("refreshLog") as HTMLButtonElement;
  const resultSection = document.getElementById("resultSection") as HTMLDivElement;
  const resultImg = document.getElementById("resultImg") as HTMLImageElement;
  const resultDownload = document.getElementById("resultDownload") as HTMLAnchorElement;

  // Load last performance log on popup open
  refreshPerfLog();

  // Run Agent button
  runBtn.addEventListener("click", async () => {
    const task = taskInput.value.trim();
    if (!task) {
      setStatus("⚠️ Please enter a task.", "warn");
      return;
    }

    setStatus("⏳ Running agent pipeline…", "info");
    runBtn.disabled = true;

    try {
      // Send message to background service worker
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab found.");

      const response = await chrome.runtime.sendMessage({ type: "RUN_AGENT", task });

      if (response?.type === "AGENT_ERROR") {
        setStatus(`❌ Error: ${response.error}`, "error");
      } else if (response?.type === "AGENT_RESULT") {
        const actionCount = response.actionPlan?.actions?.length ?? 0;
        setStatus(`✅ Done — ${actionCount} action(s) executed.`, "success");
        if (response.redactedImageBase64) {
          showRedactedImage(response.redactedImageBase64);
        }
        await refreshPerfLog();
      } else {
        setStatus("⚠️ Unexpected response from background.", "warn");
      }
    } catch (err) {
      setStatus(`❌ ${(err as Error).message}`, "error");
    } finally {
      runBtn.disabled = false;
    }
  });

  // Refresh log button
  refreshLogBtn.addEventListener("click", () => {
    refreshPerfLog();
  });

  /** Show the exact redacted image bytes that were sent to the VLM — same
   *  proof the demo page's download panel gives, but for any real site. */
  function showRedactedImage(base64: string): void {
    const dataUrl = `data:image/png;base64,${base64}`;
    resultImg.src = dataUrl;
    resultDownload.href = dataUrl;
    resultDownload.download = `redacted-screenshot-${Date.now()}.png`;
    resultSection.hidden = false;
  }

  async function refreshPerfLog() {
    const log = await getLastLog();
    if (log) {
      logEl.textContent = formatLog(log);
    } else {
      logEl.textContent = "No runs yet.";
    }
  }

  function setStatus(msg: string, level: "info" | "success" | "warn" | "error") {
    statusEl.textContent = msg;
    statusEl.className = `status status-${level}`;
  }
});
