/**
 * run-dom-benchmark.ts — Precision/recall/F1 benchmark for the DOM-based
 * PII/face-image detection used before any screenshot leaves the device.
 *
 * Imports and calls the ACTUAL production functions from
 * extension/src/redaction.ts (extractPIIRegionsFromDOM,
 * extractImageRegionsFromDOM) — this is not a reimplementation being
 * graded, it's the exact shipped detection logic.
 *
 * Prints a console report AND writes benchmark/report.html — a
 * presentable page (not raw terminal text) meant to be shown live via the
 * server's /benchmark route, or screenshotted straight into slides.
 *
 * Run with: npm run benchmark:dom
 */

import * as fs from "fs";
import * as path from "path";
import { extractPIIRegionsFromDOM, extractImageRegionsFromDOM } from "../src/redaction";
import { BoundingBox } from "../src/types/contracts";
import { fixtures, Fixture } from "./fixtures";
import { renderHtmlReport } from "./render-report";

const PII_PADDING = 4; // must match extractPIIRegionsFromDOM's internal padding

function computeExpectedPiiBox(box: BoundingBox): BoundingBox {
  return {
    x: Math.max(0, box.x - PII_PADDING),
    y: Math.max(0, box.y - PII_PADDING),
    width: box.width + PII_PADDING * 2,
    height: box.height + PII_PADDING * 2,
  };
}

function boxEquals(a: BoundingBox, b: BoundingBox): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function containsBox(boxes: BoundingBox[], target: BoundingBox): boolean {
  return boxes.some((b) => boxEquals(b, target));
}

export type Outcome = "TP" | "FP" | "FN" | "TN";

export interface Counts {
  TP: number;
  FP: number;
  FN: number;
  TN: number;
}

function emptyCounts(): Counts {
  return { TP: 0, FP: 0, FN: 0, TN: 0 };
}

export function precisionRecallF1(c: Counts): { precision: number; recall: number; f1: number } {
  const precision = c.TP + c.FP === 0 ? 1 : c.TP / (c.TP + c.FP);
  const recall = c.TP + c.FN === 0 ? 1 : c.TP / (c.TP + c.FN);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

export interface FailureDetail {
  fixture: string;
  elementId: string;
  outcome: "FP" | "FN";
  note?: string;
}

export interface NotableCase {
  fixture: string;
  category: string;
  note: string;
  hadFailure: boolean;
}

export interface ElementResult {
  fixture: string;
  elementId: string;
  category: string;
  outcome: Outcome;
  /** true if this element was a real sensitive field/image (ground truth positive) */
  wasSensitive: boolean;
}

export interface BenchmarkResults {
  fixtureCount: number;
  elementCount: number;
  byCategory: [string, Counts][];
  overall: Counts;
  failures: FailureDetail[];
  notableCases: NotableCase[];
  elementResults: ElementResult[];
  generatedAt: string;
}

export function runBenchmark(): BenchmarkResults {
  const byCategory = new Map<string, Counts>();
  const overall = emptyCounts();
  const failures: FailureDetail[] = [];
  const notableCases: NotableCase[] = [];
  const elementResults: ElementResult[] = [];

  for (const fixture of fixtures as Fixture[]) {
    const actualPiiBoxes = extractPIIRegionsFromDOM(fixture.elements);
    const actualImageBoxes = extractImageRegionsFromDOM(fixture.elements);

    if (!byCategory.has(fixture.category)) byCategory.set(fixture.category, emptyCounts());
    const catCounts = byCategory.get(fixture.category)!;

    let fixtureHadFailure = false;

    for (const elmt of fixture.elements) {
      const id = elmt.id!;
      const isPiiPositive = fixture.piiPositiveIds.includes(id);
      const isImagePositive = fixture.imagePositiveIds.includes(id);

      let outcome: Outcome;

      if (isPiiPositive) {
        const flagged = containsBox(actualPiiBoxes, computeExpectedPiiBox(elmt.boundingBox));
        outcome = flagged ? "TP" : "FN";
      } else if (isImagePositive) {
        const flagged = containsBox(actualImageBoxes, elmt.boundingBox);
        outcome = flagged ? "TP" : "FN";
      } else {
        const piiFlagged = containsBox(actualPiiBoxes, computeExpectedPiiBox(elmt.boundingBox));
        const imageFlagged = containsBox(actualImageBoxes, elmt.boundingBox);
        outcome = piiFlagged || imageFlagged ? "FP" : "TN";
      }

      catCounts[outcome]++;
      overall[outcome]++;
      elementResults.push({
        fixture: fixture.name,
        elementId: id,
        category: fixture.category,
        outcome,
        wasSensitive: isPiiPositive || isImagePositive,
      });

      if (outcome === "FP" || outcome === "FN") {
        fixtureHadFailure = true;
        failures.push({ fixture: fixture.name, elementId: id, outcome, note: fixture.note });
      }
    }

    if (fixture.note) {
      notableCases.push({
        fixture: fixture.name,
        category: fixture.category,
        note: fixture.note,
        hadFailure: fixtureHadFailure,
      });
    }
  }

  return {
    fixtureCount: fixtures.length,
    elementCount: fixtures.reduce((n, f) => n + f.elements.length, 0),
    byCategory: [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b)),
    overall,
    failures,
    notableCases,
    elementResults,
    generatedAt: new Date().toISOString(),
  };
}

function printConsoleReport(results: BenchmarkResults): void {
  console.log("\n=== DOM/Regex/Autocomplete PII Detection Benchmark ===");
  console.log(`${results.fixtureCount} fixtures, ${results.elementCount} labeled elements\n`);

  console.log("-- By category --");
  for (const [category, counts] of results.byCategory) {
    const { precision, recall, f1 } = precisionRecallF1(counts);
    console.log(
      `${category.padEnd(16)} TP=${counts.TP} FP=${counts.FP} FN=${counts.FN} TN=${counts.TN}  ` +
      `P=${(precision * 100).toFixed(0)}% R=${(recall * 100).toFixed(0)}% F1=${(f1 * 100).toFixed(0)}%`
    );
  }

  const { precision, recall, f1 } = precisionRecallF1(results.overall);
  console.log("\n-- Overall --");
  console.log(`TP=${results.overall.TP} FP=${results.overall.FP} FN=${results.overall.FN} TN=${results.overall.TN}`);
  console.log(`Precision: ${(precision * 100).toFixed(1)}%`);
  console.log(`Recall:    ${(recall * 100).toFixed(1)}%`);
  console.log(`F1:        ${(f1 * 100).toFixed(1)}%`);

  if (results.failures.length > 0) {
    console.log("\n-- Failures (for transparency, not hidden) --");
    for (const f of results.failures) {
      const label = f.outcome === "FN" ? "LEAKED (missed a real PII field)" : "OVER-REDACTED (flagged a non-PII field)";
      console.log(`  [${f.outcome}] ${f.fixture} → #${f.elementId} — ${label}`);
      if (f.note) console.log(`      note: ${f.note}`);
    }
  }

  console.log(
    `\nSummary sentence for slides: "Across ${results.fixtureCount} test pages covering passwords, emails, ` +
    `phones, cards, Aadhaar, PAN, and addresses, the redaction layer achieved ` +
    `${(precision * 100).toFixed(0)}% precision and ${(recall * 100).toFixed(0)}% recall ` +
    `(F1 ${(f1 * 100).toFixed(0)}%), with ${results.overall.FN} known miss(es) and ${results.overall.FP} known ` +
    `over-redaction(s) — both explained above, not hidden."\n`
  );
}

function main(): void {
  const results = runBenchmark();
  printConsoleReport(results);

  const html = renderHtmlReport(results);
  const outPath = path.join(__dirname, "report.html");
  fs.writeFileSync(outPath, html, "utf-8");
  console.log(`Presentable report written to: ${outPath}`);
  console.log(`View it live via: http://localhost:3000/benchmark/report.html (with the server running)\n`);
}

main();
