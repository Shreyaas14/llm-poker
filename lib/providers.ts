import type { Action, Observation } from "./poker.ts";

// IDs verified against the live AI Gateway catalog on 2026-10-13.
export const DEFAULT_MODELS = [
  "openai/gpt-6-luna", "anthropic/claude-haiku-5.5",
  "google/gemini-3.8-flash", "spacexai/grok-4.1-fast-non-reasoning",
] as const;

export class ProviderError extends Error {
  constructor(message: string) { super(message); this.name = "ProviderError"; }
}

export function parseDecision(value: unknown): Action {
  if (!value || typeof value !== "object") throw new ProviderError("The model returned an invalid decision.");
  const v = value as Record<string, unknown>;
  if (!["fold", "check", "call", "raise"].includes(String(v.action))) throw new ProviderError("The model returned an invalid action.");
  if (v.action === "raise") {
    if (!Number.isSafeInteger(v.raiseTo) || Number(v.raiseTo) < 0) throw new ProviderError("The model returned an invalid raise.");
    return { type: "raise", amount: Number(v.raiseTo) };
  }
  if (v.raiseTo !== null) throw new ProviderError("The model attached a bet to a non-raise action.");
  return { type: v.action as "fold" | "check" | "call" };
}

export async function requestDecision(
  observation: Observation, model: string, apiKey: string, feedback?: string,
): Promise<Action> {
  const response = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(18000),
    body: JSON.stringify({
      model,
      max_tokens: 1000,
      messages: [
        { role: "system", content: "You are one seat in a four-player no-limit Texas Hold'em game. Maximize your poker chips" + (observation.style ? " while following your assigned playing style." : ".") + " You know ONLY the observation supplied. Opponent hole cards and future cards are unknown. No tools or game-state changes are available. Choose exactly one legal action. A raiseTo value is the TOTAL street contribution, not a raise increment. Use null for raiseTo unless raising. Never infer that you know hidden cards. Return only the required JSON decision." },
        { role: "user", content: JSON.stringify(observation) },
        ...(feedback ? [{ role: "user", content: `Your previous decision was rejected by the rules engine: ${feedback}. The observation has not changed. Choose a legal action.` }] : []),
      ],
      response_format: { type: "json_schema", json_schema: {
        name: "poker_action", strict: true,
        schema: { type: "object", properties: {
          action: { type: "string", enum: ["fold", "check", "call", "raise"] },
          raiseTo: { type: ["integer", "null"] },
        }, required: ["action", "raiseTo"], additionalProperties: false },
      } },
    }),
  }).catch(() => { throw new ProviderError("The model connection timed out or was interrupted. Retry to continue the same hand."); });
  if (!response.ok) {
    const reason = response.status === 401 ? "The model connection needs a valid API key."
      : response.status === 402 ? "The model connection has no available credit or has reached its budget."
      : response.status === 429 ? "The model provider is busy. Retry this decision shortly."
      : `The model provider could not complete this decision (HTTP ${response.status}).`;
    // Provider error bodies can include account information; never return them to a viewer.
    throw new ProviderError(reason);
  }
  const result = await response.json() as { choices?: { finish_reason?: string; message?: { content?: string; refusal?: string } }[] };
  const choice = result.choices?.[0];
  if (!choice?.message?.content || choice.message.refusal || choice.finish_reason === "length") {
    throw new ProviderError("The model did not return a complete decision. Retry to continue the same hand.");
  }
  try { return parseDecision(JSON.parse(choice.message.content)); }
  catch { throw new ProviderError("The model did not return a valid decision. Retry to continue the same hand."); }
}
