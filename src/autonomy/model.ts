import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, type LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { ModelRunner } from "./runtime";
import type { Route } from "./schemas";

const DEFAULT_CF_MODEL = "@cf/zai-org/glm-4.7-flash";

function requestedModel(env: Env, role: Parameters<ModelRunner>[0]): string {
  if (role === "STRATEGIST") return env.STRATEGIST_MODEL || DEFAULT_CF_MODEL;
  if (role === "ROOT") return env.ROOT_MODEL || "openclaw/default";
  if (role === "AUDITOR")
    return env.AUDITOR_MODEL || env.DEFAULT_WORKER_MODEL || DEFAULT_CF_MODEL;
  return env.DEFAULT_WORKER_MODEL || DEFAULT_CF_MODEL;
}

export function createModelRunner(env: Env): ModelRunner {
  return async (role, prompt, signal) => {
    const requested = requestedModel(env, role);
    if (!requested.startsWith("@cf/") && !requested.startsWith("openclaw/")) {
      throw new Error("Unsupported model route configuration");
    }
    const workersai = createWorkersAI({ binding: env.AI });
    const cfModel = requested.startsWith("@cf/") ? requested : DEFAULT_CF_MODEL;
    const fallback = (
      reason: string | null
    ): { model: LanguageModel; route: Route } => ({
      model: workersai(cfModel),
      route: {
        requestedModel: requested,
        actualModel: cfModel,
        provider: "workers-ai",
        route: "cloudflare-binding",
        fallbackUsed: reason !== null,
        fallbackReason: reason
      } satisfies Route
    });

    let choice = fallback(null);
    if (
      requested.startsWith("openclaw/") &&
      env.OPENCLAW_BASE_URL &&
      env.OPENCLAW_GATEWAY_TOKEN
    ) {
      try {
        const health = await fetch(`${env.OPENCLAW_BASE_URL}/v1/models`, {
          headers: { authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}` },
          signal: AbortSignal.timeout(2500)
        });
        if (!health.ok) throw new Error(`Health HTTP ${health.status}`);
        const provider = createOpenAICompatible({
          name: "openclaw",
          baseURL: `${env.OPENCLAW_BASE_URL}/v1`,
          apiKey: env.OPENCLAW_GATEWAY_TOKEN
        });
        choice = {
          model: provider(requested),
          route: {
            requestedModel: requested,
            actualModel: "UNKNOWN",
            provider: "openclaw",
            route: "linux-openclaw-bridge",
            fallbackUsed: false,
            fallbackReason: null
          }
        };
      } catch {
        choice = fallback("OPENCLAW_UNAVAILABLE");
      }
    } else if (requested.startsWith("openclaw/")) {
      choice = fallback("OPENCLAW_UNCONFIGURED");
    }

    try {
      const result = await generateText({
        model: choice.model,
        prompt,
        maxOutputTokens: 1500,
        maxRetries: 0,
        abortSignal: signal
      });
      return { text: result.text, route: choice.route };
    } catch {
      if (choice.route.provider !== "openclaw")
        throw new Error("MODEL_REQUEST_FAILED");
      const cf = fallback("OPENCLAW_REQUEST_FAILED");
      const result = await generateText({
        model: cf.model,
        prompt,
        maxOutputTokens: 1500,
        maxRetries: 0,
        abortSignal: signal
      });
      return { text: result.text, route: cf.route };
    }
  };
}
