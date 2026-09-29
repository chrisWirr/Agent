import assert from "node:assert/strict";
import { test } from "node:test";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { createChatWorkersAI } from "./chat-model";

test("Cloudflare chat uses complete tool arguments once, then returns text", async () => {
  let calls = 0;
  let executions = 0;
  const binding = {
    run: async (_model: string, input: { stream?: boolean }) => {
      assert.notEqual(input.stream, true, "must bypass upstream tool SSE");
      calls++;
      if (calls === 1) {
        const call = {
          id: "schedule-1",
          type: "function",
          function: {
            name: "scheduleTask",
            arguments: JSON.stringify({ description: "Review song", delay: 60 })
          }
        };
        return {
          tool_calls: [call],
          choices: [
            { message: { tool_calls: [call] }, finish_reason: "tool_calls" }
          ]
        };
      }
      return { response: "Die Erinnerung ist geplant." };
    }
  } as unknown as Ai;
  const result = streamText({
    model: createChatWorkersAI(binding)(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
    ),
    prompt: "Remind me in a minute",
    tools: {
      scheduleTask: tool({
        inputSchema: z.object({ description: z.string(), delay: z.number() }),
        execute: async (input) => {
          assert.deepEqual(input, { description: "Review song", delay: 60 });
          executions++;
          return "Scheduled";
        }
      })
    },
    stopWhen: stepCountIs(2)
  });
  await result.consumeStream();
  assert.equal(await result.text, "Die Erinnerung ist geplant.");
  assert.equal(executions, 1);
  assert.equal(calls, 2);
});
