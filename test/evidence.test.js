import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexEvents } from "../src/codex.js";
import { buildFeedback, buildPrompt, evaluateStop } from "../src/evidence.js";

test("Codex JSONL parser extracts thread and final message", () => {
  const parsed = parseCodexEvents(
    [
      JSON.stringify({ type: "thread.started", thread_id: "thread-42" }),
      "not json",
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Finished" } }),
    ].join("\n"),
  );
  assert.equal(parsed.threadId, "thread-42");
  assert.equal(parsed.finalMessage, "Finished");
  assert.equal(parsed.events.length, 2);
});

test("prompt includes bounded iteration and prior evidence", () => {
  const prompt = buildPrompt({
    task: { goal: "Add rotation", limits: { maxIterations: 4 } },
    iteration: 2,
    feedback: "tests failed",
  });
  assert.match(prompt, /Add rotation/);
  assert.match(prompt, /Iteration: 2 of 4/);
  assert.match(prompt, /tests failed/);
  assert.match(prompt, /Do not merely describe/);
});

test("feedback truncates verification output", () => {
  const feedback = buildFeedback({
    iteration: 1,
    codex: { exitCode: 0, timedOut: false },
    verification: {
      checks: [
        { name: "tests", command: "npm test", passed: false, exitCode: 1, timedOut: false, output: "x".repeat(100) },
      ],
    },
    gitStatus: " M source.js",
    maxOutputChars: 20,
  });
  assert.match(feedback, /truncated 80 characters/);
  assert.match(feedback, /fix these failures/);
});

test("stop conditions have deterministic priority", () => {
  const limits = { maxNoProgress: 2, maxIterations: 5 };
  assert.equal(evaluateStop({ passed: true, timedOut: true, noProgress: 2, iteration: 5, limits }), "success");
  assert.equal(evaluateStop({ passed: false, timedOut: true, noProgress: 2, iteration: 5, limits }), "timeout");
  assert.equal(evaluateStop({ passed: false, timedOut: false, noProgress: 2, iteration: 5, limits }), "no_progress");
  assert.equal(evaluateStop({ passed: false, timedOut: false, noProgress: 0, iteration: 5, limits }), "max_iterations");
  assert.equal(evaluateStop({ passed: false, timedOut: false, noProgress: 0, iteration: 1, limits }), null);
});
