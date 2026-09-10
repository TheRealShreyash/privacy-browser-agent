/**
 * background.ts — Service worker for SIH26171 browser agent.
 *
 * Implements:
 *  1. Transformers.js ONNX vision model (`Xenova/yolos-tiny`) (D2)
 *  2. WebGPU with automatic WASM fallback (D2)
 *  3. OffscreenCanvas PII Redaction (D3)
 *  4. Express + VLM endpoint integration (D4)
 *  5. Performance telemetry logging (D7)
 */

import { pipeline, env, RawImage } from "@huggingface/transformers";
import {
  BackgroundMessage,
  ActionPlan,
  Action,
  PerformanceLog,
  SanitizedContext,
} from "./types/contracts";
import { redactScreenshot } from "./redaction";

// Configure Transformers.js for browser service worker environment
env.allowLocalModels = false;
env.useBrowserCache = true;

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  console.log("[BrowserAgent:bg] Extension installed. Vision pipeline ready.");
});

// ---------------------------------------------------------------------------
// Message handler — entry point from content script / popup
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (
    message: BackgroundMessage,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    if (message.type === "RUN_AGENT") {
      const wallStart = performance.now();

      runAgentPipeline(message.task, _sender.tab?.id)
        .then(({ actionPlan, log, redactedImageBase64 }) => {
          log.totalMs = performance.now() - wallStart;
          chrome.storage.local.set({ lastPerformanceLog: log });
          sendResponse({ type: "AGENT_RESULT", actionPlan, log, redactedImageBase64 });
        })
        .catch((err: Error) => {
          console.error("[BrowserAgent:bg] Pipeline error:", err);
          sendResponse({ type: "AGENT_ERROR", error: err.message });
        });

      return true; // keep message channel open for async sendResponse
    }

    if (message.type === "RUN_COMPARISON") {
      const wallStart = performance.now();

      runComparisonPipeline(message.task, _sender.tab?.id)
        .then(({ naive, redacted, log }) => {
          log.totalMs = performance.now() - wallStart;
          sendResponse({ type: "COMPARISON_RESULT", naive, redacted, log });
        })
        .catch((err: Error) => {
          console.error("[BrowserAgent:bg] Comparison pipeline error:", err);
          sendResponse({ type: "COMPARISON_ERROR", error: err.message });
        });

      return true;
    }

    return false;
  }
);

// ---------------------------------------------------------------------------
// Pipeline orchestrator
// ---------------------------------------------------------------------------

/** Resolve a tabId, falling back to the active window tab (e.g. when triggered from the popup). */
async function resolveTabId(tabId?: number): Promise<number | undefined> {
  if (tabId) return tabId;
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab?.id;
}

/**
 * Shared steps 0–4: wait for layout to settle, capture the screenshot, scan
 * the DOM, run on-device vision inference, and redact. Used by both the
 * normal single-plan pipeline and the naive-vs-redacted comparison pipeline
 * — both need the exact same capture, just sent to the server differently.
 */
async function captureAndRedact(tabId: number): Promise<{
  screenshotDataUrl: string;
  domSummary: SanitizedContext["domSummary"];
  redactionResult: Awaited<ReturnType<typeof redactScreenshot>>;
  log: Partial<PerformanceLog>;
}> {
  const log: Partial<PerformanceLog> = {
    timestamp: new Date().toISOString(),
  };

  // -- Step 0: Wait for web fonts to finish loading ---------------------------
  // A page using web fonts (e.g. our own demo page's Google Fonts) reflows
  // once they swap in for the fallback font. If that reflow happens between
  // the screenshot capture and the DOM scan below, the two measurements are
  // taken against two different layouts — redaction boxes then get drawn at
  // positions that don't match where anything actually is anymore. Forcing
  // both measurements to happen only after fonts have settled eliminates
  // the race entirely, regardless of font download speed.
  await waitForFontsReady(tabId);

  // Reset scroll to the top before capturing — see scrollTabToTop's doc
  // comment. Must happen here (background), not in a triggering page's own
  // JS, so it applies no matter what triggered the run: the demo page's
  // button, the popup on an arbitrary real site, or anything else.
  await scrollTabToTop(tabId);

  // -- Step 1: Capture tab screenshot ----------------------------------------
  const captureStart = performance.now();
  const screenshotDataUrl = await captureTab(tabId);
  const captureMs = performance.now() - captureStart;
  console.log(`[BrowserAgent:bg] Screenshot captured in ${captureMs.toFixed(1)}ms`);

  // -- Step 2: Fetch DOM summary from active tab ------------------------------
  const { domSummary, viewportWidth, viewportHeight } = await getDomSummaryFromTab(tabId);
  log.domElementCount = domSummary.length;
  console.log(`[BrowserAgent:bg] DOM Summary: ${domSummary.length} elements fetched (viewport ${viewportWidth}x${viewportHeight})`);

  // -- Step 3: Run ONNX object detection (D2) --------------------------------
  const inferStart = performance.now();
  const { detections, backend, loadMs, error: inferenceError } = await runInference(screenshotDataUrl);
  log.inferenceMs = performance.now() - inferStart;
  log.modelLoadMs = loadMs;
  log.deviceBackend = backend;
  log.detectionCount = detections.length;
  log.inferenceError = inferenceError;
  console.log(
    `[BrowserAgent:bg] Inference: ${detections.length} detections in ${log.inferenceMs.toFixed(1)}ms via ${backend.toUpperCase()}` +
    (inferenceError ? ` — FAILED: ${inferenceError}` : "")
  );

  // -- Step 4: Redact PII on canvas (D3) -------------------------------------
  const redactStart = performance.now();
  const redactionResult = await redactScreenshot({
    screenshotDataUrl,
    detections,
    domSummary,
    viewportWidth,
    viewportHeight,
  });
  log.redactionMs = performance.now() - redactStart;
  log.redactedRegions = redactionResult.redactedRegions;
  log.faceRegions = redactionResult.faceRegions;
  log.piiRegions = redactionResult.piiRegions;
  console.log(
    `[BrowserAgent:bg] Redaction: ${redactionResult.redactedRegions} regions (${redactionResult.faceRegions} faces, ${redactionResult.piiRegions} PII) in ${log.redactionMs.toFixed(1)}ms`
  );

  return { screenshotDataUrl, domSummary, redactionResult, log };
}

function finalizeLog(log: Partial<PerformanceLog>): PerformanceLog {
  return {
    modelLoadMs: log.modelLoadMs ?? 0,
    inferenceMs: log.inferenceMs ?? 0,
    redactionMs: log.redactionMs ?? 0,
    payloadSizeBytes: log.payloadSizeBytes ?? 0,
    serverRoundtripMs: log.serverRoundtripMs ?? 0,
    totalMs: log.totalMs ?? 0,
    deviceBackend: log.deviceBackend ?? "wasm",
    detectionCount: log.detectionCount ?? 0,
    redactedRegions: log.redactedRegions ?? 0,
    faceRegions: log.faceRegions ?? 0,
    piiRegions: log.piiRegions ?? 0,
    domElementCount: log.domElementCount ?? 0,
    inferenceError: log.inferenceError,
    timestamp: log.timestamp ?? new Date().toISOString(),
  };
}

async function runAgentPipeline(
  task: string,
  tabIdArg?: number
): Promise<{ actionPlan: ActionPlan; log: PerformanceLog; redactedImageBase64: string }> {
  const tabId = await resolveTabId(tabIdArg);
  if (!tabId) throw new Error("No active tab to run the agent on.");

  const { domSummary, redactionResult, log } = await captureAndRedact(tabId);

  // -- Step 5: Build sanitized payload and send to server (D4) ---------------
  const payload: SanitizedContext = {
    redactedImage: redactionResult.redactedImage,
    domSummary,
    task,
  };
  const payloadJson = JSON.stringify(payload);
  log.payloadSizeBytes = new TextEncoder().encode(payloadJson).length;

  const serverStart = performance.now();
  const actionPlan = await callServer(payload);
  log.serverRoundtripMs = performance.now() - serverStart;

  // -- Step 6: Execute actions directly on active tab DOM (D5) ---------------
  if (actionPlan.actions.length > 0) {
    console.log(`[BrowserAgent:bg] Executing ${actionPlan.actions.length} action(s) on tab ${tabId}...`);
    await executeActionsOnTab(tabId, actionPlan.actions, domSummary);
  } else {
    console.warn(`[BrowserAgent:bg] No actions returned (actions=${actionPlan.actions.length})`);
  }

  return { actionPlan, log: finalizeLog(log), redactedImageBase64: redactionResult.redactedImage };
}

/**
 * Privacy leakage comparison: same single capture sent to Gemini two ways —
 * raw (what a naive screenshot-the-tab agent would send) and redacted (what
 * this extension actually sends). Both are real /analyze calls, run
 * concurrently. Only the redacted plan executes on the page, so the form
 * doesn't get filled twice — but the naive plan's action count is real,
 * proving task completion doesn't depend on the cloud seeing the raw image.
 */
async function runComparisonPipeline(
  task: string,
  tabIdArg?: number
): Promise<{
  naive: { actionPlan: ActionPlan; imageBase64: string };
  redacted: { actionPlan: ActionPlan; imageBase64: string };
  log: PerformanceLog;
}> {
  const tabId = await resolveTabId(tabIdArg);
  if (!tabId) throw new Error("No active tab to run the comparison on.");

  const { screenshotDataUrl, domSummary, redactionResult, log } = await captureAndRedact(tabId);

  const rawImageBase64 = screenshotDataUrl.replace(/^data:image\/\w+;base64,/, "");

  const naivePayload: SanitizedContext = { redactedImage: rawImageBase64, domSummary, task };
  const redactedPayload: SanitizedContext = { redactedImage: redactionResult.redactedImage, domSummary, task };

  const serverStart = performance.now();
  const [naiveActionPlan, redactedActionPlan] = await Promise.all([
    callServer(naivePayload),
    callServer(redactedPayload),
  ]);
  log.serverRoundtripMs = performance.now() - serverStart;
  log.payloadSizeBytes = new TextEncoder().encode(JSON.stringify(redactedPayload)).length;

  console.log(
    `[BrowserAgent:bg] Comparison: naive=${naiveActionPlan.actions.length} actions, ` +
    `redacted=${redactedActionPlan.actions.length} actions`
  );

  if (redactedActionPlan.actions.length > 0) {
    console.log(`[BrowserAgent:bg] Executing redacted-mode plan (${redactedActionPlan.actions.length} action(s)) on tab ${tabId}...`);
    await executeActionsOnTab(tabId, redactedActionPlan.actions, domSummary);
  }

  return {
    naive: { actionPlan: naiveActionPlan, imageBase64: rawImageBase64 },
    redacted: { actionPlan: redactedActionPlan, imageBase64: redactionResult.redactedImage },
    log: finalizeLog(log),
  };
}

// ---------------------------------------------------------------------------
// Model Loading & Inference Engine (D2)
// ---------------------------------------------------------------------------

let detector: any = null;
let activeBackend: "webgpu" | "wasm" = "wasm";
let cachedLoadMs = 0;

async function getDetector(): Promise<{
  detector: any;
  backend: "webgpu" | "wasm";
  loadMs: number;
}> {
  if (detector) {
    return { detector, backend: activeBackend, loadMs: 0 };
  }

  const start = performance.now();

  // yolov10 is NOT a supported architecture in @huggingface/transformers'
  // object-detection pipeline (only detr/rt_detr/rf_detr/d_fine/yolos are
  // registered — see MODEL_FOR_OBJECT_DETECTION_MAPPING_NAMES in the
  // library). yolos-tiny is the library's own reference object-detection
  // model (used in Xenova's official WebGPU object-detection demo) — a
  // ViT-based detector, which also fits the problem statement's framing of
  // a local "Vision Transformer (ViT) or equivalent" better than a
  // CNN-based YOLOv10 would have anyway.
  const MODEL_ID = "Xenova/yolos-tiny";

  try {
    console.log("[BrowserAgent:bg] Loading ONNX vision model with WebGPU backend...");
    detector = await (pipeline as any)("object-detection", MODEL_ID, {
      device: "webgpu",
    });
    activeBackend = "webgpu";
  } catch (webgpuErr) {
    console.warn(
      "[BrowserAgent:bg] WebGPU unavailable/failed. Falling back to WASM:",
      webgpuErr
    );
    detector = await (pipeline as any)("object-detection", MODEL_ID, {
      device: "wasm",
    });
    activeBackend = "wasm";
  }

  cachedLoadMs = performance.now() - start;
  console.log(
    `[BrowserAgent:bg] Vision model loaded via ${activeBackend.toUpperCase()} in ${cachedLoadMs.toFixed(1)}ms`
  );

  return { detector, backend: activeBackend, loadMs: cachedLoadMs };
}

// Caps the resolution fed to the on-device model. The problem statement's
// core constraint is that local hardware has far less compute than a
// server — full-resolution (1080p+) inference on every run ignores that.
// Detection boxes are normalized 0..1 regardless of input size, so
// downscaling here is a pure speed/memory win with no downstream changes.
const MAX_INFERENCE_DIMENSION = 640;

async function runInference(screenshotDataUrl: string): Promise<{
  detections: Detection[];
  backend: "webgpu" | "wasm";
  loadMs: number;
  error?: string;
}> {
  try {
    const { detector: model, backend, loadMs } = await getDetector();
    let image = await RawImage.fromURL(screenshotDataUrl);

    const longestSide = Math.max(image.width, image.height);
    if (longestSide > MAX_INFERENCE_DIMENSION) {
      const scale = MAX_INFERENCE_DIMENSION / longestSide;
      image = await image.resize(
        Math.round(image.width * scale),
        Math.round(image.height * scale)
      );
    }

    const output = await model(image, { threshold: 0.25 });

    const rawDetections = output as Array<{
      label: string;
      score: number;
      box: { xmin: number; ymin: number; xmax: number; ymax: number };
    }>;

    const detections: Detection[] = rawDetections.map((d) => ({
      label: d.label,
      score: d.score,
      box: {
        xmin: d.box.xmin / image.width,
        ymin: d.box.ymin / image.height,
        xmax: d.box.xmax / image.width,
        ymax: d.box.ymax / image.height,
      },
    }));

    return { detections, backend, loadMs };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    console.error("[BrowserAgent:bg] Inference error:", err);
    return { detections: [], backend: activeBackend, loadMs: 0, error: message };
  }
}

// ---------------------------------------------------------------------------
// Screen Capture & Tab Messaging
// ---------------------------------------------------------------------------

/** Blocks until the tab's web fonts have finished loading (or 1.5s elapses,
 *  as a safety cap against a font request that hangs/fails to resolve). */
async function waitForFontsReady(tabId?: number): Promise<void> {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        Promise.race([
          document.fonts.ready.then(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 1500)),
        ]),
    });
  } catch (err) {
    console.warn("[BrowserAgent:bg] Failed to wait for document.fonts.ready:", err);
  }
}

/**
 * Scroll the target tab to the top and wait for an actual paint before
 * returning. chrome.tabs.captureVisibleTab only grabs what's currently
 * scrolled into view, but the DOM scan (getBoundingClientRect) reports
 * every element's position regardless of scroll — including elements
 * above the viewport, whose Y coordinate goes negative and gets clamped
 * to 0 by extractPIIRegionsFromDOM's padding math. Without resetting
 * scroll first, that produces a redaction box drawn at the top of the
 * screenshot for a field that isn't anywhere near there.
 *
 * This must live here, in the background worker, not in page-level JS —
 * a plain `window.scrollTo(0,0)` in a triggering page (like the demo
 * page's own button) only fixes that one page. Triggering via the popup,
 * or from any other real site, has no such page-level script at all, so
 * the fix has to apply universally at the point where the tab is
 * actually captured.
 */
async function scrollTabToTop(tabId?: number): Promise<void> {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        new Promise<void>((resolve) => {
          window.scrollTo(0, 0);
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    });
  } catch (err) {
    console.warn("[BrowserAgent:bg] Failed to scroll tab to top before capture:", err);
  }
}

async function captureTab(_tabId?: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab({ format: "png", quality: 100 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(dataUrl);
      }
    });
  });
}

interface DomScanResult {
  domSummary: SanitizedContext["domSummary"];
  /** CSS-pixel viewport size at scan time — needed to scale DOM bounding
   *  boxes onto the captured screenshot, which is in device pixels. */
  viewportWidth: number;
  viewportHeight: number;
}

async function getDomSummaryFromTab(tabId?: number): Promise<DomScanResult> {
  if (!tabId) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = activeTab?.id;
  }

  if (!tabId) return { domSummary: [], viewportWidth: 0, viewportHeight: 0 };

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Execute DOM scan function defined in content script context
        const INTERACTIVE_SELECTORS = [
          "a[href]",
          "button",
          "input:not([type=hidden])",
          "select",
          "textarea",
          "[role=button]",
          "[role=link]",
          "[role=textbox]",
          "label",
          "img",
          "iframe",
        ].join(", ");

        // Recursively collect matching elements, descending into any OPEN
        // shadow roots along the way. Plain querySelectorAll cannot see
        // into shadow DOM at all, and shadow DOM is common in modern
        // component libraries (Material, Shoelace, many design systems) —
        // without this, every input inside one is invisible to us, both
        // for redaction and for the agent's action targeting. Shadow roots
        // live in the SAME document/coordinate system as the light DOM
        // (unlike iframes), so no coordinate translation is needed here.
        function collectElements(root: ParentNode): HTMLElement[] {
          const found = Array.from(root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTORS));
          root.querySelectorAll<HTMLElement>("*").forEach((el) => {
            if (el.shadowRoot) {
              found.push(...collectElements(el.shadowRoot));
            }
          });
          return found;
        }

        const elements = collectElements(document);
        const summary: Array<{
          tag: string;
          id?: string;
          name?: string;
          selector?: string;
          role?: string;
          type?: string;
          autocomplete?: string;
          boundingBox: { x: number; y: number; width: number; height: number };
          text?: string;
        }> = [];

        elements.forEach((el) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return;

          let selector = el.tagName.toLowerCase();
          if (el.id) {
            selector = `#${el.id}`;
          } else if (el.getAttribute("data-testid")) {
            // Prefer test-automation attributes when present — real sites
            // built with Cypress/Playwright/Testing Library coverage
            // already tag elements with these specifically because
            // framework-managed DOMs (React/Vue/Angular) often have no
            // stable id/name at all. Far more reliable than guessing.
            selector = `[data-testid="${el.getAttribute("data-testid")}"]`;
          } else if (el.getAttribute("data-cy")) {
            selector = `[data-cy="${el.getAttribute("data-cy")}"]`;
          } else if (el.getAttribute("data-qa")) {
            selector = `[data-qa="${el.getAttribute("data-qa")}"]`;
          } else if (el.getAttribute("name")) {
            selector = `[name="${el.getAttribute("name")}"]`;
          } else if (el.getAttribute("placeholder")) {
            selector = `[placeholder="${el.getAttribute("placeholder")}"]`;
          } else if (el.innerText && el.innerText.length < 30) {
            selector = `${el.tagName.toLowerCase()}`;
          }

          let text: string | undefined;
          const inputEl = el as HTMLInputElement;
          if (inputEl.type === "password") {
            text = undefined;
          } else {
            const raw =
              el.getAttribute("aria-label") ||
              el.getAttribute("placeholder") ||
              el.getAttribute("title") ||
              el.getAttribute("alt") ||
              el.innerText ||
              "";
            text = raw.trim().slice(0, 120) || undefined;
          }

          summary.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            name: el.getAttribute("name") || undefined,
            selector,
            role: el.getAttribute("role") ?? undefined,
            type: (el as HTMLInputElement).type || undefined,
            autocomplete: el.getAttribute("autocomplete") || undefined,
            boundingBox: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            text,
          });
        });

        return { summary, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
      },
    });

    const result = results[0]?.result as
      | { summary: SanitizedContext["domSummary"]; viewportWidth: number; viewportHeight: number }
      | undefined;

    return {
      domSummary: result?.summary ?? [],
      viewportWidth: result?.viewportWidth ?? 0,
      viewportHeight: result?.viewportHeight ?? 0,
    };
  } catch (err) {
    console.warn("[BrowserAgent:bg] Failed to fetch DOM summary via scripting:", err);
    return { domSummary: [], viewportWidth: 0, viewportHeight: 0 };
  }
}

/**
 * Executes the ActionPlan on the real tab. `fallbackBoxes` maps each
 * action's selector to the on-screen position it was recorded at during
 * the DOM scan — used only when `document.querySelector` comes back empty
 * (unstable/generated selectors on framework-heavy sites, or an element
 * living inside a shadow root, which querySelector cannot reach at all).
 * `elementFromPoint` hit-tests the actual rendered tree, so it finds the
 * real element regardless of shadow boundaries — the same reason
 * screenshot-based computer-use agents click by coordinate in the first
 * place. Coordinates are only trustworthy if the page hasn't scrolled
 * since the scan; that holds for the first action in a plan, but an
 * earlier action's own scrollIntoView can invalidate it for later ones —
 * an accepted limit for a last-resort fallback, not the primary path.
 */
async function executeActionsOnTab(
  tabId: number,
  actions: Action[],
  domSummary: SanitizedContext["domSummary"] = []
): Promise<void> {
  const fallbackBoxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
  for (const el of domSummary) {
    if (el.selector && !fallbackBoxes[el.selector]) {
      fallbackBoxes[el.selector] = el.boundingBox;
    }
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: async (
        actionsToRun: Action[],
        fallbackBoxesArg: Record<string, { x: number; y: number; width: number; height: number }>
      ) => {
        function delay(ms: number) {
          return new Promise((r) => setTimeout(r, ms));
        }

        for (const action of actionsToRun) {
          try {
            console.log("[BrowserAgent:executor] Executing action:", action);
            let el = document.querySelector(action.selector) as HTMLElement | null;

            if (!el) {
              const box = fallbackBoxesArg[action.selector];
              if (box) {
                const cx = box.x + box.width / 2;
                const cy = box.y + box.height / 2;
                el = document.elementFromPoint(cx, cy) as HTMLElement | null;
                if (el) {
                  console.log(
                    `[BrowserAgent:executor] Selector "${action.selector}" didn't resolve — used its recorded position (${cx}, ${cy}) instead, found`,
                    el
                  );
                }
              }
            }

            if (!el) {
              console.warn(`[BrowserAgent:executor] Element not found for selector "${action.selector}" (no fallback position available)`);
              continue;
            }

            el.scrollIntoView({ block: "center", behavior: "smooth" });
            await delay(150);

            if (action.type === "click") {
              el.focus();
              el.click();
              console.log(`[BrowserAgent:executor] Clicked "${action.selector}"`);
            } else if (action.type === "type" && action.value !== undefined) {
              el.focus();
              const inputEl = el as HTMLInputElement;
              inputEl.value = action.value;

              // Fire native input setter for controlled components (React, Vue, Angular)
              const nativeSetter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                "value"
              )?.set;
              nativeSetter?.call(el, action.value);

              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
              console.log(`[BrowserAgent:executor] Typed "${action.value}" into "${action.selector}"`);
            } else if (action.type === "scroll") {
              const delta = parseInt(action.value ?? "300", 10);
              window.scrollBy({ top: delta, behavior: "smooth" });
              console.log(`[BrowserAgent:executor] Scrolled ${delta}px`);
            }

            await delay(200);
          } catch (err) {
            console.error("[BrowserAgent:executor] Action execution failed:", action, err);
          }
        }
      },
      args: [actions, fallbackBoxes],
    });
  } catch (err) {
    console.error("[BrowserAgent:bg] Failed to execute script on tab:", err);
  }
}

async function callServer(payload: SanitizedContext): Promise<ActionPlan> {
  const SERVER_URL = "http://localhost:3000/analyze";

  const response = await fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Server returned ${response.status}: ${await response.text()}`);
  }

  const data = (await response.json()) as ActionPlan;
  return data;
}

export interface Detection {
  label: string;
  score: number;
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
}

