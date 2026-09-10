/**
 * index.ts — Express server for SIH26171.
 *
 * Endpoints:
 *   POST /analyze  — accepts SanitizedContext, calls VLM, returns ActionPlan
 *   GET  /health   — liveness check
 */

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { ZodError } from "zod";
import { SanitizedContextSchema } from "./schemas";
import { callVLM } from "./vlm";
import { sanitizeDomSummary } from "./sanitize";

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Parse CORS_ORIGINS env (e.g. "chrome-extension://,http://localhost:5173")
const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (curl, Postman, same-origin)
      if (!origin) return callback(null, true);
      // Allow any chrome-extension:// or moz-extension:// origin
      const allowed =
        allowedOrigins.some((o) => origin.startsWith(o)) ||
        origin.startsWith("chrome-extension://") ||
        origin.startsWith("moz-extension://");
      callback(null, allowed);
    },
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// Limit body size — base64 screenshots can be large (~2–4 MB for 1080p)
app.use(express.json({ limit: "10mb" }));

// Serve demo static files over HTTP to avoid file:// origin restrictions
app.use("/demo", express.static(path.join(__dirname, "../../demo")));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Health / liveness endpoint. */
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    model: process.env.VLM_MODEL ?? "gemini-2.0-flash",
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /analyze
 *
 * Body: SanitizedContext
 *   { redactedImage: base64, domSummary: [...], task: string }
 *
 * Response: ActionPlan
 *   { actions: [{ type, selector, value? }] }
 */
app.post("/analyze", async (req: Request, res: Response, next: NextFunction) => {
  const requestStart = Date.now();

  // 1. Validate incoming payload
  const parseResult = SanitizedContextSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: "Invalid request body",
      details: parseResult.error.flatten(),
    });
    return;
  }

  let context = parseResult.data;
  const payloadKB = (JSON.stringify(context).length / 1024).toFixed(1);

  console.log(
    `[Server] /analyze — task="${context.task.slice(0, 60)}…"` +
    ` | dom=${context.domSummary.length} elements` +
    ` | payload=${payloadKB} KB`
  );

  // 2. Defense-in-depth: independently re-scan domSummary for PII the
  // client-side redaction should already have removed, before it ever
  // reaches the VLM prompt. Never assume the client did this correctly.
  const { domSummary: sanitizedDomSummary, leaksCaught } = sanitizeDomSummary(context.domSummary);
  if (leaksCaught > 0) {
    console.warn(
      `[Server] ⚠️  Server-side redaction caught ${leaksCaught} PII match(es) that the client should have already removed.`
    );
    context = { ...context, domSummary: sanitizedDomSummary };
  }

  try {
    // 3. Call VLM
    const actionPlan = await callVLM(context);

    const elapsedMs = Date.now() - requestStart;
    console.log(
      `[Server] /analyze — ✓ ${actionPlan.actions.length} actions returned in ${elapsedMs}ms`
    );

    // 3. Return validated action plan
    res.json(actionPlan);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Validation error", details: err.flatten() });
    return;
  }
  console.error("[Server] Unhandled error:", err);
  res.status(500).json({ error: err.message ?? "Internal server error" });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[Server] SIH26171 agent server running on http://localhost:${PORT}`);
  console.log(`[Server] VLM model: ${process.env.VLM_MODEL ?? "gemini-2.0-flash"}`);
  if (!process.env.VLM_API_KEY) {
    console.warn("[Server] ⚠️  VLM_API_KEY not set — /analyze will fail until configured.");
  }
});

export default app;
