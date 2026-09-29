import { simulateStreamingMiddleware, wrapLanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export function createChatWorkersAI(binding: Ai) {
  const workersai = createWorkersAI({ binding });
  return (modelId: string) =>
    wrapLanguageModel({
      model: workersai(modelId),
      // Avoid duplicated native/OpenAI tool deltas in the upstream SSE stream.
      // Complete tool arguments are validated before the UI stream is emitted.
      middleware: simulateStreamingMiddleware()
    });
}
