/**
 * schemas.ts — Zod schemas for SIH26171 server.
 *
 * These mirror the TypeScript contracts in /extension/src/types/contracts.ts.
 * Any change to the JSON contract must be reflected here AND in contracts.ts.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const BoundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

// ---------------------------------------------------------------------------
// Incoming payload: SanitizedContext (Extension → Server)
// ---------------------------------------------------------------------------

export const DomElementSchema = z.object({
  tag: z.string().min(1).max(32),
  id: z.string().max(100).optional(),
  name: z.string().max(100).optional(),
  selector: z.string().max(200).optional(),
  role: z.string().optional(),
  type: z.string().max(32).optional(),
  autocomplete: z.string().max(50).optional(),
  boundingBox: BoundingBoxSchema,
  text: z.string().max(120).optional(),
});

export const SanitizedContextSchema = z.object({
  /** Raw base64 PNG (no data URL prefix). Must decode to a valid image. */
  redactedImage: z
    .string()
    .min(1)
    .refine(
      (s) => {
        // Quick sanity check: base64 PNG starts with iVBOR after decoding
        // (PNG magic bytes: 89 50 4E 47 → base64 → iVBOR)
        return s.startsWith("iVBOR") || s.startsWith("/9j/") || s.length > 100;
      },
      { message: "redactedImage does not appear to be a valid base64 image" }
    ),
  domSummary: z.array(DomElementSchema).max(500),
  task: z.string().min(1).max(2000),
});

// ---------------------------------------------------------------------------
// Outgoing response: ActionPlan (Server → Extension)
// ---------------------------------------------------------------------------

export const ActionTypeSchema = z.enum(["click", "scroll", "type"]);

export const ActionSchema = z.object({
  type: ActionTypeSchema,
  selector: z.string().min(1).max(500),
  value: z.string().max(10000).optional(),
});

export const ActionPlanSchema = z.object({
  actions: z.array(ActionSchema).min(0).max(50),
});

// ---------------------------------------------------------------------------
// Inferred TypeScript types (aligned with contracts.ts)
// ---------------------------------------------------------------------------

export type SanitizedContextInput = z.infer<typeof SanitizedContextSchema>;
export type ActionPlanOutput = z.infer<typeof ActionPlanSchema>;
