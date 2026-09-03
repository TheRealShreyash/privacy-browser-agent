/**
 * schemas.test.ts — Jest tests for Zod contract schemas.
 * Covers: valid payloads, missing fields, out-of-range values.
 */

import {
  SanitizedContextSchema,
  ActionPlanSchema,
  BoundingBoxSchema,
  DomElementSchema,
} from "../src/schemas";

// ---------------------------------------------------------------------------
// BoundingBox
// ---------------------------------------------------------------------------

describe("BoundingBoxSchema", () => {
  test("valid bounding box", () => {
    expect(() =>
      BoundingBoxSchema.parse({ x: 10, y: 20, width: 100, height: 50 })
    ).not.toThrow();
  });

  test("rejects zero width", () => {
    expect(() =>
      BoundingBoxSchema.parse({ x: 0, y: 0, width: 0, height: 50 })
    ).toThrow();
  });

  test("rejects missing field", () => {
    expect(() =>
      BoundingBoxSchema.parse({ x: 0, y: 0, width: 100 })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// DomElement
// ---------------------------------------------------------------------------

describe("DomElementSchema", () => {
  const validEl = {
    tag: "button",
    id: "submitBtn",
    selector: "#submitBtn",
    boundingBox: { x: 10, y: 10, width: 80, height: 32 },
    text: "Submit",
  };

  test("valid element without role", () => {
    expect(() => DomElementSchema.parse(validEl)).not.toThrow();
  });

  test("valid element with role", () => {
    expect(() =>
      DomElementSchema.parse({ ...validEl, role: "button" })
    ).not.toThrow();
  });

  test("text truncated to 120 chars is accepted", () => {
    expect(() =>
      DomElementSchema.parse({ ...validEl, text: "a".repeat(120) })
    ).not.toThrow();
  });

  test("rejects text over 120 chars", () => {
    expect(() =>
      DomElementSchema.parse({ ...validEl, text: "a".repeat(121) })
    ).toThrow();
  });

  test("rejects empty tag", () => {
    expect(() =>
      DomElementSchema.parse({ ...validEl, tag: "" })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// SanitizedContext
// ---------------------------------------------------------------------------

const VALID_BASE64_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("SanitizedContextSchema", () => {
  const valid = {
    redactedImage: VALID_BASE64_PNG,
    domSummary: [
      {
        tag: "input",
        boundingBox: { x: 0, y: 0, width: 200, height: 40 },
      },
    ],
    task: "Fill in the email field",
  };

  test("accepts valid payload", () => {
    expect(() => SanitizedContextSchema.parse(valid)).not.toThrow();
  });

  test("accepts empty domSummary", () => {
    expect(() =>
      SanitizedContextSchema.parse({ ...valid, domSummary: [] })
    ).not.toThrow();
  });

  test("rejects empty task", () => {
    expect(() =>
      SanitizedContextSchema.parse({ ...valid, task: "" })
    ).toThrow();
  });

  test("rejects missing redactedImage", () => {
    const { redactedImage: _, ...rest } = valid;
    expect(() => SanitizedContextSchema.parse(rest)).toThrow();
  });

  test("rejects task over 2000 chars", () => {
    expect(() =>
      SanitizedContextSchema.parse({ ...valid, task: "x".repeat(2001) })
    ).toThrow();
  });

  test("rejects empty redactedImage string", () => {
    expect(() =>
      SanitizedContextSchema.parse({ ...valid, redactedImage: "" })
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ActionPlan
// ---------------------------------------------------------------------------

describe("ActionPlanSchema", () => {
  test("valid click action", () => {
    expect(() =>
      ActionPlanSchema.parse({
        actions: [{ type: "click", selector: "#submit-btn" }],
      })
    ).not.toThrow();
  });

  test("valid type action", () => {
    expect(() =>
      ActionPlanSchema.parse({
        actions: [{ type: "type", selector: "#email", value: "test@example.com" }],
      })
    ).not.toThrow();
  });

  test("valid scroll action", () => {
    expect(() =>
      ActionPlanSchema.parse({
        actions: [{ type: "scroll", selector: "body", value: "300" }],
      })
    ).not.toThrow();
  });

  test("valid empty actions array", () => {
    expect(() => ActionPlanSchema.parse({ actions: [] })).not.toThrow();
  });

  test("rejects invalid action type", () => {
    expect(() =>
      ActionPlanSchema.parse({
        actions: [{ type: "hover", selector: "#btn" }],
      })
    ).toThrow();
  });

  test("rejects empty selector", () => {
    expect(() =>
      ActionPlanSchema.parse({
        actions: [{ type: "click", selector: "" }],
      })
    ).toThrow();
  });

  test("rejects over 50 actions", () => {
    const actions = Array.from({ length: 51 }, (_, i) => ({
      type: "click" as const,
      selector: `#btn-${i}`,
    }));
    expect(() => ActionPlanSchema.parse({ actions })).toThrow();
  });
});
