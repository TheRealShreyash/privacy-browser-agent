/**
 * render-report.ts — Turns BenchmarkResults into a presentable static HTML
 * page (not raw terminal text, and not ML-jargon-first). Leads with plain
 * language and an at-a-glance visual grid; precision/recall/F1 are
 * secondary, each with a one-line plain-English explanation. Same visual
 * language as the demo page (Playfair Display / JetBrains Mono,
 * yellow-black-gold palette) so it reads as part of the same product.
 *
 * Status colors (good/critical) are the validated pair from the dataviz
 * skill's reference palette — not eyeballed.
 */

import { BenchmarkResults, precisionRecallF1 } from "./run-dom-benchmark";

const GOOD = "#0ca30c";
const GOOD_BG = "#f0fdf4";
const GOOD_BORDER = "#bbf7d0";
const CRITICAL = "#d03b3b";
const CRITICAL_BG = "#fef2f2";
const CRITICAL_BORDER = "#fecaca";

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderHtmlReport(results: BenchmarkResults): string {
  const { precision, recall, f1 } = precisionRecallF1(results.overall);
  const generated = new Date(results.generatedAt).toLocaleString();

  const protectedCount = results.overall.TP;
  const sensitiveTotal = results.overall.TP + results.overall.FN;
  const safeCorrect = results.overall.TN;
  const safeTotal = results.overall.TN + results.overall.FP;
  const allCorrect = results.overall.FP === 0 && results.overall.FN === 0;

  const headline = allCorrect
    ? `Every sensitive field was protected, and nothing safe was wrongly flagged.`
    : `${protectedCount} of ${sensitiveTotal} sensitive fields were protected` +
      (results.overall.FN > 0 ? `, ${results.overall.FN} missed` : "") +
      (results.overall.FP > 0 ? `, ${results.overall.FP} safe field(s) wrongly flagged` : "") +
      `.`;

  // One cell per tested element — an instant visual, no math required.
  const gridCells = results.elementResults
    .map((r) => {
      const pass = r.outcome === "TP" || r.outcome === "TN";
      const label = pass
        ? r.wasSensitive
          ? "Protected"
          : "Correctly left alone"
        : r.outcome === "FN"
        ? "MISSED — was sensitive, not flagged"
        : "WRONGLY FLAGGED — was safe";
      const tooltip = `${r.fixture} — #${r.elementId} (${r.category}): ${label}`;
      return `<div class="cell ${pass ? "pass" : "fail"}" title="${esc(tooltip)}"></div>`;
    })
    .join("");

  const categoryRows = results.byCategory
    .map(([category, counts]) => {
      const cr = precisionRecallF1(counts);
      const ok = counts.FP === 0 && counts.FN === 0;
      return `
        <tr>
          <td class="status-cell">${ok ? `<span class="pill pass">✓ Clean</span>` : `<span class="pill fail">⚠ Check below</span>`}</td>
          <td class="cat">${esc(category)}</td>
          <td class="muted">${counts.TP} protected · ${counts.TN} correctly ignored${counts.FP + counts.FN > 0 ? ` · ${counts.FP + counts.FN} wrong` : ""}</td>
          <td class="muted">${pct(cr.precision)} / ${pct(cr.recall)} / ${pct(cr.f1)}</td>
        </tr>`;
    })
    .join("");

  const notableRows = results.notableCases
    .map(
      (c) => `
        <div class="case">
          <div class="case-head">
            <span class="pill ${c.hadFailure ? "fail" : "pass"}">${c.hadFailure ? "✗ Currently failing" : "✓ Passes"}</span>
            <span class="case-title">${esc(c.fixture)}</span>
            <span class="case-cat">${esc(c.category)}</span>
          </div>
          <p class="case-note">${esc(c.note)}</p>
        </div>`
    )
    .join("");

  const failuresBlock =
    results.failures.length === 0
      ? `<p class="all-clear">✓ No open failures — every labeled element in every fixture is classified correctly.</p>`
      : `<div class="failures">${results.failures
          .map(
            (f) => `
        <div class="failure-row">
          <span class="pill fail">${f.outcome === "FN" ? "MISSED" : "WRONGLY FLAGGED"}</span>
          <strong>${esc(f.fixture)}</strong> → #${esc(f.elementId)}
          ${f.note ? `<div class="failure-note">${esc(f.note)}</div>` : ""}
        </div>`
          )
          .join("")}</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Privacy Detection Benchmark — SIH26171</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --font-display: "Playfair Display", Georgia, serif;
    --font-mono: "JetBrains Mono", "Fira Code", Consolas, monospace;
    --font-body: system-ui, -apple-system, "Segoe UI", sans-serif;
    --ink: #0a0a0a;
    --bg: #fdfbf3;
    --surface: #ffffff;
    --border: #e8e1c8;
    --text: #1c1917;
    --text-muted: #6b6558;
    --accent: #eab308;
    --accent-2: #ca8a04;
    --good: ${GOOD};
    --good-bg: ${GOOD_BG};
    --good-border: ${GOOD_BORDER};
    --critical: ${CRITICAL};
    --critical-bg: ${CRITICAL_BG};
    --critical-border: ${CRITICAL_BORDER};
  }

  body {
    font-family: var(--font-body);
    background: var(--bg);
    color: var(--text);
    padding: 40px 32px 60px;
    max-width: 960px;
    margin: 0 auto;
  }

  h1 {
    font-family: var(--font-display);
    font-size: 32px;
    font-weight: 700;
    color: var(--ink);
    margin-bottom: 4px;
  }
  .subtitle { color: var(--text-muted); font-size: 14px; margin-bottom: 8px; }
  .generated { color: var(--text-muted); font-size: 12px; font-family: var(--font-mono); margin-bottom: 32px; }

  /* ---- Plain-language headline — this is what a judge reads first ---- */
  .headline-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 28px 28px 24px;
    margin-bottom: 20px;
  }
  .headline {
    font-family: var(--font-display);
    font-size: 24px;
    font-weight: 700;
    color: var(--ink);
    margin-bottom: 18px;
    line-height: 1.3;
  }
  .headline-stats { display: flex; gap: 18px; flex-wrap: wrap; }
  .headline-stat {
    flex: 1 1 220px;
    background: var(--good-bg);
    border: 1px solid var(--good-border);
    border-radius: 12px;
    padding: 16px 18px;
  }
  .headline-stat .big { font-family: var(--font-display); font-size: 28px; font-weight: 700; color: var(--good); }
  .headline-stat .small { font-size: 13px; color: var(--text-muted); margin-top: 2px; }

  /* ---- Visual grid — every test, at a glance ---- */
  .grid-section { margin-bottom: 32px; }
  .grid-caption { font-size: 13px; color: var(--text-muted); margin-bottom: 12px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(16, 1fr);
    gap: 5px;
    max-width: 480px;
  }
  .cell {
    aspect-ratio: 1;
    border-radius: 4px;
    cursor: default;
  }
  .cell.pass { background: var(--good); }
  .cell.fail { background: var(--critical); }
  .grid-legend { display: flex; gap: 20px; margin-top: 12px; font-size: 12px; color: var(--text-muted); align-items: center; }
  .legend-swatch { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 6px; vertical-align: -1px; }

  h2 {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    margin-bottom: 14px;
    margin-top: 8px;
  }

  /* ---- Secondary: precision/recall/F1, explained ---- */
  .technical-note { font-size: 12px; color: var(--text-muted); margin-bottom: 14px; font-style: italic; }
  .metric-row { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 36px; }
  .metric-tile {
    flex: 1 1 260px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 18px;
  }
  .metric-tile .value { font-family: var(--font-display); font-size: 26px; font-weight: 700; color: var(--accent-2); }
  .metric-tile .label { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-top: 2px; }
  .metric-tile .explain { font-size: 12px; color: var(--text-muted); margin-top: 8px; line-height: 1.5; }

  .pill {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    padding: 3px 9px;
    border-radius: 5px;
  }
  .pill.pass { background: var(--good-bg); color: var(--good); border: 1px solid var(--good-border); }
  .pill.fail { background: var(--critical-bg); color: var(--critical); border: 1px solid var(--critical-border); }

  table {
    width: 100%;
    border-collapse: collapse;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    margin-bottom: 36px;
    font-size: 13px;
  }
  th, td {
    text-align: left;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }
  th {
    background: #faf6e4;
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }
  td.cat { font-weight: 600; color: var(--ink); text-transform: capitalize; }
  td.muted { color: var(--text-muted); font-family: var(--font-mono); font-size: 12px; }
  .status-cell { width: 110px; }
  tr:last-child td { border-bottom: none; }

  .case {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 18px;
    margin-bottom: 10px;
  }
  .case-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  .case-title { font-weight: 600; }
  .case-cat { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); text-transform: uppercase; }
  .case-note { font-size: 13px; color: var(--text-muted); line-height: 1.5; }

  .all-clear {
    background: var(--good-bg);
    border: 1px solid var(--good-border);
    color: var(--good);
    padding: 14px 18px;
    border-radius: 10px;
    font-size: 14px;
    margin-bottom: 36px;
    font-weight: 600;
  }

  .failures { margin-bottom: 36px; }
  .failure-row {
    background: var(--critical-bg);
    border: 1px solid var(--critical-border);
    border-radius: 10px;
    padding: 12px 16px;
    margin-bottom: 8px;
    font-size: 13px;
  }
  .failure-note { color: var(--text-muted); margin-top: 4px; font-size: 12px; }

  .footer {
    margin-top: 40px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
</style>
</head>
<body>
  <h1>Privacy Detection Benchmark</h1>
  <p class="subtitle">SIH26171 — Privacy Browser Agent · DOM / regex / autocomplete PII detection</p>
  <p class="generated">Generated ${esc(generated)} · ${results.fixtureCount} test pages · ${results.elementCount} labeled fields</p>

  <div class="headline-card">
    <div class="headline">${esc(headline)}</div>
    <div class="headline-stats">
      <div class="headline-stat">
        <div class="big">${protectedCount} / ${sensitiveTotal}</div>
        <div class="small">real sensitive fields (passwords, emails, cards, faces...) correctly protected</div>
      </div>
      <div class="headline-stat">
        <div class="big">${safeCorrect} / ${safeTotal}</div>
        <div class="small">safe, non-sensitive fields correctly left untouched (no false alarms)</div>
      </div>
    </div>
  </div>

  <div class="grid-section">
    <p class="grid-caption">Every one of the ${results.elementCount} fields tested, at a glance. Hover any square for details.</p>
    <div class="grid">${gridCells}</div>
    <div class="grid-legend">
      <span><span class="legend-swatch" style="background:${GOOD}"></span>Correct call</span>
      <span><span class="legend-swatch" style="background:${CRITICAL}"></span>Wrong call</span>
    </div>
  </div>

  <h2>The technical numbers (for anyone who wants them)</h2>
  <p class="technical-note">Precision, recall, and F1 are the standard ML metrics for this — same numbers as above, expressed as ratios.</p>
  <div class="metric-row">
    <div class="metric-tile">
      <div class="value">${pct(recall)}</div>
      <div class="label">Recall</div>
      <div class="explain">Of everything that was actually sensitive, what fraction did we catch? 100% = nothing sensitive slipped through.</div>
    </div>
    <div class="metric-tile">
      <div class="value">${pct(precision)}</div>
      <div class="label">Precision</div>
      <div class="explain">Of everything we flagged as sensitive, what fraction actually was? 100% = we never wrongly blocked something safe.</div>
    </div>
    <div class="metric-tile">
      <div class="value">${pct(f1)}</div>
      <div class="label">F1 Score</div>
      <div class="explain">A single combined score balancing the two above. Only high when both are high.</div>
    </div>
  </div>

  <h2>Tested against the actual production code</h2>
  <p class="technical-note">Not a reimplementation being graded — these call extractPIIRegionsFromDOM / extractImageRegionsFromDOM directly from src/redaction.ts, the exact functions the extension ships. Card numbers are checked with a real Luhn checksum and Aadhaar numbers with the real Verhoeff checksum UIDAI uses — not just shape-matching regex.</p>

  <h2>By category</h2>
  <table>
    <thead><tr><th></th><th>Category</th><th>Detail</th><th>Precision / Recall / F1</th></tr></thead>
    <tbody>${categoryRows}</tbody>
  </table>

  <h2>Adversarial / deliberately hard cases</h2>
  ${notableRows}

  <h2>Failures</h2>
  ${failuresBlock}

  <div class="footer">
    Regenerate this report any time with <code>npm run benchmark:dom</code> — it always reflects the
    current code and fixtures, not a stale snapshot.
  </div>
</body>
</html>
`;
}
