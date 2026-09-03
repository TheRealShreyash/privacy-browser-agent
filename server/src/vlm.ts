/**
 * vlm.ts — VLM (Vision-Language Model) integration for SIH26171.
 *
 * Calls the configured Gemini Flash model with:
 *   - The redacted screenshot (base64 PNG)
 *   - The domSummary (JSON)
 *   - The user task
 *
 * Returns a validated ActionPlan.
 *
 * D4: Full implementation below.
 */

import {
  GoogleGenerativeAI,
  HarmBlockThreshold,
  HarmCategory,
  Part,
  SchemaType,
} from "@google/generative-ai";
import { SanitizedContextInput, ActionPlanOutput, ActionPlanSchema } from "./schemas";

// ---------------------------------------------------------------------------
// Prompt engineering
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a browser automation agent.
You receive:
1. A sanitized screenshot of a webpage (PII has been blurred or blacked out).
2. A JSON array of visible interactive DOM elements with their bounding boxes.
3. A natural-language task from the user.

Your job is to return a JSON action plan to complete the task.

RULES:
- Output ONLY valid JSON matching this schema exactly:
  {"actions": [{"type": "click"|"scroll"|"type", "selector": "<CSS selector>", "value": "<string, required for 'type' and 'scroll'>" }]}
- Use the domSummary to identify the correct CSS selector for each action.
- For "scroll", value is the pixel delta as a string (e.g., "300").
- For "type", value is the text to enter.
- Maximum 20 actions per plan.
- If the task cannot be completed from the visible content, return {"actions": []}.
- Do NOT include any explanation — JSON only.`;

// ---------------------------------------------------------------------------
// VLM client
// ---------------------------------------------------------------------------

let _genAI: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!_genAI) {
    const apiKey = process.env.VLM_API_KEY;
    if (!apiKey) throw new Error("VLM_API_KEY is not set in environment.");
    _genAI = new GoogleGenerativeAI(apiKey);
  }
  return _genAI;
}

/**
 * Call the VLM with a sanitized context and return a validated ActionPlan.
 * D4: implemented.
 */
export async function callVLM(
  context: SanitizedContextInput
): Promise<ActionPlanOutput> {
  const modelName = process.env.VLM_MODEL ?? "gemini-2.0-flash";
  const client = getClient();
  const model = client.getGenerativeModel({
    model: modelName,
    safetySettings: [
      { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
    ],
    systemInstruction: SYSTEM_PROMPT,
  });

  // Build multimodal parts: image + text
  const imagePart: Part = {
    inlineData: {
      mimeType: "image/png",
      data: context.redactedImage,
    },
  };

  const textPart: Part = {
    text: `TASK: ${context.task}

DOM ELEMENTS (interactive, visible on screen):
${JSON.stringify(context.domSummary)}

Return the action plan JSON now matching {"actions": [{"type": "click"|"scroll"|"type", "selector": string, "value"?: string}]}`,
  };

  const result = await model.generateContent({
    contents: [{ role: "user", parts: [imagePart, textPart] }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
      // Force schema-conformant output — without this, the model can emit
      // truncated/malformed JSON (e.g. cut off mid-string) that fails to parse.
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          actions: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                type: {
                  type: SchemaType.STRING,
                  format: "enum",
                  enum: ["click", "scroll", "type"],
                },
                selector: { type: SchemaType.STRING },
                value: { type: SchemaType.STRING },
              },
              required: ["type", "selector"],
            },
          },
        },
        required: ["actions"],
      },
    },
  });

  const candidate = result.response.candidates?.[0];
  let rawText = result.response.text().trim();

  // Strip markdown code fences if present (shouldn't happen with responseSchema, but be safe)
  if (rawText.startsWith("```json")) {
    rawText = rawText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (rawText.startsWith("```")) {
    rawText = rawText.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }

  // Parse and validate with Zod
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const reason = candidate?.finishReason ? ` (finishReason=${candidate.finishReason})` : "";
    console.error(`[VLM] Failed to parse response${reason}. Full raw text:\n${rawText}`);
    throw new Error(
      `VLM returned non-JSON response${reason}: ${rawText.slice(0, 300)}`
    );
  }

  const validated = ActionPlanSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `VLM response failed schema validation: ${validated.error.message}\nRaw: ${rawText.slice(0, 300)}`
    );
  }

  if (validated.data.actions.length === 0) {
    console.warn(
      `[VLM] Empty action plan returned. domSummary had ${context.domSummary.length} element(s). ` +
      `Raw response: ${rawText.slice(0, 500)}`
    );
  }

  return validated.data;
}
