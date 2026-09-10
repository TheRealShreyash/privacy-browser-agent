/**
 * run-face-benchmark.ts — Precision/recall for real-photo face/person
 * detection, using the ACTUAL production model (Xenova/yolos-tiny, same
 * model as background.ts) and the ACTUAL production filtering logic
 * (extractFaceRegionsFromDetections from src/redaction.ts) — not a
 * reimplementation.
 *
 * This intentionally does NOT ship with any test photos. Sourcing photos
 * of real people isn't something to fake or default to — drop your own /
 * teammates' consented photos into:
 *
 *   images/positive/*.jpg   — photos that DO contain a person/face
 *   images/negative/*.jpg   — images that should NOT trigger detection
 *                             (objects, empty scenes, illustrations/avatars)
 *
 * then run: npm run benchmark:faces
 */

import * as fs from "fs";
import * as path from "path";
import { pipeline, RawImage } from "@huggingface/transformers";
import { extractFaceRegionsFromDetections } from "../../src/redaction";
import type { Detection } from "../../src/background";

const IMAGES_DIR = path.join(__dirname, "images");
const POSITIVE_DIR = path.join(IMAGES_DIR, "positive");
const NEGATIVE_DIR = path.join(IMAGES_DIR, "negative");

function listImages(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => path.join(dir, f));
}

async function detectsPerson(detector: any, imagePath: string): Promise<boolean> {
  const image = await RawImage.read(imagePath);
  const output = await detector(image, { threshold: 0.25 });

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

  const faceBoxes = extractFaceRegionsFromDetections(detections, image.width, image.height);
  return faceBoxes.length > 0;
}

async function main(): Promise<void> {
  const positives = listImages(POSITIVE_DIR);
  const negatives = listImages(NEGATIVE_DIR);

  console.log("\n=== Face/Person Detection Benchmark (Xenova/yolos-tiny) ===");

  if (positives.length === 0 && negatives.length === 0) {
    console.log("No test images found.\n");
    console.log("Drop photos into:");
    console.log(`  ${POSITIVE_DIR}   (photos that DO contain a person)`);
    console.log(`  ${NEGATIVE_DIR}   (images that should NOT trigger detection)`);
    console.log(
      "\nUse your own / teammates' consented photos — this harness intentionally " +
      "does not ship with any, so nothing here claims a real number without real input.\n"
    );
    return;
  }

  console.log("Loading model (first run downloads it — subsequent runs use the cache)...");
  const detector = await pipeline("object-detection", "Xenova/yolos-tiny");

  let TP = 0, FN = 0, FP = 0, TN = 0;
  const failures: string[] = [];

  for (const imgPath of positives) {
    const detected = await detectsPerson(detector, imgPath);
    if (detected) TP++;
    else {
      FN++;
      failures.push(`[FN] ${path.basename(imgPath)} — expected a person, none detected`);
    }
  }

  for (const imgPath of negatives) {
    const detected = await detectsPerson(detector, imgPath);
    if (!detected) TN++;
    else {
      FP++;
      failures.push(`[FP] ${path.basename(imgPath)} — expected no person, one was detected`);
    }
  }

  const precision = TP + FP === 0 ? 1 : TP / (TP + FP);
  const recall = TP + FN === 0 ? 1 : TP / (TP + FN);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  console.log(`\n${positives.length} positive image(s), ${negatives.length} negative image(s)`);
  console.log(`TP=${TP} FP=${FP} FN=${FN} TN=${TN}`);
  console.log(`Precision: ${(precision * 100).toFixed(1)}%`);
  console.log(`Recall:    ${(recall * 100).toFixed(1)}%`);
  console.log(`F1:        ${(f1 * 100).toFixed(1)}%`);

  if (failures.length > 0) {
    console.log("\n-- Failures --");
    failures.forEach((f) => console.log(`  ${f}`));
  }
  console.log("");
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
