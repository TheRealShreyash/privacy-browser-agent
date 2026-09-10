/**
 * redaction.ts — Canvas-based PII redaction module for SIH26171.
 *
 * Implements:
 *   1. Vision detections (faces / person objects) → Gaussian box blur / pixelate
 *   2. DOM signals (input[type=password], email/phone/address autocomplete, regex matches) → solid blackout
 *   3. OffscreenCanvas processing in Chrome service worker
 */

import { DomElement, BoundingBox } from "./types/contracts";
import type { Detection } from "./background";

export interface RedactionResult {
  /** Raw base64 PNG (no data URL prefix) of the redacted screenshot. */
  redactedImage: string;
  /** Total number of regions that were blurred or blacked out. */
  redactedRegions: number;
  faceRegions: number;
  piiRegions: number;
}

export interface RedactionInput {
  screenshotDataUrl: string;
  detections: Detection[];
  domSummary: DomElement[];
  viewportWidth?: number;
  viewportHeight?: number;
}

/**
 * Main redaction function. Takes screenshot data URL, vision detections, and DOM summary,
 * returns a redacted base64 PNG with sensitive areas obscured.
 */
export async function redactScreenshot(
  input: RedactionInput
): Promise<RedactionResult> {
  const { screenshotDataUrl, detections, domSummary, viewportWidth, viewportHeight } = input;

  // Convert base64 data URL to ImageBitmap via fetch blob
  const response = await fetch(screenshotDataUrl);
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);

  const canvasWidth = imageBitmap.width;
  const canvasHeight = imageBitmap.height;

  // The screenshot is captured at device pixels, but DOM bounding boxes
  // (getBoundingClientRect) are in CSS pixels. These differ whenever
  // devicePixelRatio != 1 (e.g. Windows display scaling at 125%/150%,
  // which is the common default) — without correcting for it, PII boxes
  // land increasingly off-target the further they are from the origin.
  const scaleX = viewportWidth ? canvasWidth / viewportWidth : 1;
  const scaleY = viewportHeight ? canvasHeight / viewportHeight : 1;

  // Create OffscreenCanvas for service worker compatibility
  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("[Redaction] Failed to obtain 2D context from OffscreenCanvas.");
  }

  // 1. Draw original screenshot
  ctx.drawImage(imageBitmap, 0, 0);

  let faceRegionsCount = 0;
  let piiRegionsCount = 0;

  // 2. Redact faces/photos: ML-detected (real photos) + DOM-flagged via alt
  //    text (catches illustrations/avatars the vision model won't recognize)
  const mlFaceBoxes = extractFaceRegionsFromDetections(
    detections,
    canvasWidth,
    canvasHeight
  );
  const domImageBoxes = extractImageRegionsFromDOM(domSummary).map((box) => ({
    x: Math.round(box.x * scaleX),
    y: Math.round(box.y * scaleY),
    width: Math.round(box.width * scaleX),
    height: Math.round(box.height * scaleY),
  }));
  const faceBoxes = [...mlFaceBoxes, ...domImageBoxes];

  for (const box of faceBoxes) {
    blurRegion(ctx, box, 16);
    faceRegionsCount++;
  }

  // 3. Redact DOM PII signals with solid blackout
  const piiBoxes = extractPIIRegionsFromDOM(domSummary).map((box) => ({
    x: Math.round(box.x * scaleX),
    y: Math.round(box.y * scaleY),
    width: Math.round(box.width * scaleX),
    height: Math.round(box.height * scaleY),
  }));

  for (const box of piiBoxes) {
    blackoutRegion(ctx, box, "#000000");
    piiRegionsCount++;
  }

  // 4. Export redacted image as PNG Blob → Base64
  const redactedBlob = await canvas.convertToBlob({ type: "image/png" });
  const arrayBuffer = await redactedBlob.arrayBuffer();
  const base64 = bufferToBase64(arrayBuffer);

  return {
    redactedImage: base64,
    redactedRegions: faceRegionsCount + piiRegionsCount,
    faceRegions: faceRegionsCount,
    piiRegions: piiRegionsCount,
  };
}

// ---------------------------------------------------------------------------
// Region Extractors
// ---------------------------------------------------------------------------

/** Extracts face/person bounding boxes from ONNX detections normalized to canvas pixels. */
export function extractFaceRegionsFromDetections(
  detections: Detection[],
  canvasWidth: number,
  canvasHeight: number
): BoundingBox[] {
  const FACE_TARGET_LABELS = new Set(["person", "face", "head"]);

  return detections
    .filter((d) => FACE_TARGET_LABELS.has(d.label.toLowerCase()) && d.score >= 0.3)
    .map((d) => {
      const x = Math.max(0, Math.round(d.box.xmin * canvasWidth));
      const y = Math.max(0, Math.round(d.box.ymin * canvasHeight));
      const w = Math.min(canvasWidth - x, Math.round((d.box.xmax - d.box.xmin) * canvasWidth));
      const h = Math.min(canvasHeight - y, Math.round((d.box.ymax - d.box.ymin) * canvasHeight));
      return { x, y, width: w, height: h };
    });
}

/**
 * Extracts image regions flagged as face/photo/PII by DOM signals (alt text,
 * aria-label) — a deterministic backup to ML detection. Vision detection
 * (above) only recognizes photographic humans, matching its COCO training
 * distribution; it will not fire on illustrations, avatars, or game
 * characters even when a page explicitly labels them as a user photo. A
 * page telling us "this is a face" via alt text is a reliable signal on its
 * own and shouldn't depend on the vision model agreeing.
 */
export function extractImageRegionsFromDOM(domSummary: DomElement[]): BoundingBox[] {
  const IMAGE_PII_KEYWORDS = ["face", "photo", "avatar", "headshot", "selfie", "profile pic", "picture"];

  return domSummary
    .filter((el) => {
      if (el.tag !== "img") return false;
      const textLower = (el.text ?? "").toLowerCase();
      return IMAGE_PII_KEYWORDS.some((kw) => textLower.includes(kw));
    })
    .filter((el) => el.boundingBox.width > 0 && el.boundingBox.height > 0)
    .map((el) => el.boundingBox);
}

/** Luhn checksum — distinguishes a real card number from any other 13-19 digit grouped string. */
export function isValidLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

// Verhoeff checksum — the algorithm UIDAI actually validates Aadhaar numbers
// against. Without it, "any 12 digits grouped in 4s" is indistinguishable
// from a real Aadhaar number — and that shape is common (it's also a
// prefix-substring of any 16-digit card-shaped number).
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

export function isValidVerhoeff(digits: string): boolean {
  if (!/^\d{12}$/.test(digits)) return false;

  let c = 0;
  const reversed = digits.split("").reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][parseInt(reversed[i], 10)]];
  }
  return c === 0;
}

/** Extracts PII bounding boxes from DOM summary (password fields, email fields, etc.) */
export function extractPIIRegionsFromDOM(domSummary: DomElement[]): BoundingBox[] {
  const piiBoxes: BoundingBox[] = [];

  // Definitive signal: the input's own `type` attribute. This MUST be checked
  // independently of `text`/`role` keyword matching below — password fields
  // intentionally have `text: undefined` (never sent, even redacted) so they
  // have no other signal to redact by.
  const PII_INPUT_TYPES = new Set(["password", "email", "tel"]);

  // The `autocomplete` attribute is a browser-standardized PII taxonomy —
  // https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill-detail-tokens
  // Cheaper and more reliable than guessing from field labels.
  const PII_AUTOCOMPLETE_TOKENS = new Set([
    "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-name",
    "current-password", "new-password", "one-time-code",
    "email", "tel", "tel-national", "tel-country-code",
    "bday", "bday-day", "bday-month", "bday-year",
    "street-address", "address-line1", "address-line2", "postal-code",
  ]);

  const PII_ROLE_KEYWORDS = [
    "password", "email", "tel", "credit-card", "secret",
    "aadhaar", "aadhar", "pan", "ssn", "otp", "cvv", "card", "passport",
  ];

  // Any 13-19 digit grouped number superficially looks like a card number —
  // order references, tracking numbers, invoice IDs, etc. all match the
  // shape. A Luhn checksum is what actually distinguishes a real card
  // number from an arbitrary digit string, so it's a required validator
  // here, not optional — without it this pattern over-redacts constantly.
  const PII_TEXT_PATTERNS: Array<{ pattern: RegExp; validate?: (matchedText: string) => boolean }> = [
    { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },  // email
    { pattern: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/ },                   // phone (10-digit)
    {
      pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/,                             // Aadhaar (12-digit, grouped)
      validate: (matchedText) => isValidVerhoeff(matchedText.replace(/\D/g, "")),
    },
    { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/ },                              // PAN (India)
    {
      pattern: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{1,4}\b/,             // card-shaped number
      validate: (matchedText) => isValidLuhn(matchedText.replace(/\D/g, "")),
    },
  ];

  for (const el of domSummary) {
    let isPII = false;

    if (el.tag === "input") {
      if (el.type && PII_INPUT_TYPES.has(el.type.toLowerCase())) {
        isPII = true;
      }

      if (el.autocomplete && PII_AUTOCOMPLETE_TOKENS.has(el.autocomplete.toLowerCase())) {
        isPII = true;
      }

      const textLower = (el.text ?? "").toLowerCase();
      const roleLower = (el.role ?? "").toLowerCase();

      if (
        PII_ROLE_KEYWORDS.some(
          (kw) => textLower.includes(kw) || roleLower.includes(kw)
        )
      ) {
        isPII = true;
      }
    }

    if (!isPII && el.text) {
      for (const { pattern, validate } of PII_TEXT_PATTERNS) {
        const match = el.text.match(pattern);
        if (match && (!validate || validate(match[0]))) {
          isPII = true;
          break;
        }
      }
    }

    if (isPII && el.boundingBox.width > 0 && el.boundingBox.height > 0) {
      const padding = 4;
      piiBoxes.push({
        x: Math.max(0, el.boundingBox.x - padding),
        y: Math.max(0, el.boundingBox.y - padding),
        width: el.boundingBox.width + padding * 2,
        height: el.boundingBox.height + padding * 2,
      });
    }
  }

  return piiBoxes;
}

// ---------------------------------------------------------------------------
// Canvas Drawing Utilities
// ---------------------------------------------------------------------------

/** Applies pixelation / box blur to a region of OffscreenCanvas */
export function blurRegion(
  ctx: OffscreenCanvasRenderingContext2D,
  box: BoundingBox,
  pixelSize = 16
): void {
  if (box.width <= 0 || box.height <= 0) return;

  const imgData = ctx.getImageData(box.x, box.y, box.width, box.height);
  const data = imgData.data;
  const w = box.width;
  const h = box.height;

  for (let y = 0; y < h; y += pixelSize) {
    for (let x = 0; x < w; x += pixelSize) {
      let r = 0, g = 0, b = 0, count = 0;

      for (let dy = 0; dy < pixelSize && y + dy < h; dy++) {
        for (let dx = 0; dx < pixelSize && x + dx < w; dx++) {
          const idx = ((y + dy) * w + (x + dx)) * 4;
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          count++;
        }
      }

      r = Math.round(r / count);
      g = Math.round(g / count);
      b = Math.round(b / count);

      for (let dy = 0; dy < pixelSize && y + dy < h; dy++) {
        for (let dx = 0; dx < pixelSize && x + dx < w; dx++) {
          const idx = ((y + dy) * w + (x + dx)) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
        }
      }
    }
  }

  ctx.putImageData(imgData, box.x, box.y);
}

/** Draws a solid blackout rectangle over PII fields */
export function blackoutRegion(
  ctx: OffscreenCanvasRenderingContext2D,
  box: BoundingBox,
  color = "#000000"
): void {
  if (box.width <= 0 || box.height <= 0) return;
  ctx.fillStyle = color;
  ctx.fillRect(box.x, box.y, box.width, box.height);
}

function bufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunkSize = 0x8000;

  for (let i = 0; i < len; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunkSize) as unknown as number[]
    );
  }
  return btoa(binary);
}
