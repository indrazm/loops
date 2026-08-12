import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { formatDuration, formatStatus, LiveStatus } from "../src/status.js";

test("duration formatting remains compact", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(65_000), "01:05");
  assert.equal(formatDuration(3_665_000), "01:01:05");
});

test("status dashboard shows phase and verification progress without output", () => {
  const lines = formatStatus(
    {
      id: "run-1",
      startedAt: "2026-08-11T00:00:00.000Z",
      activity: {
        phase: "verifying",
        message: "Verifying: tests",
        provider: "opencode",
        iteration: 2,
        maxIterations: 5,
        startedAt: "2026-08-11T00:01:00.000Z",
        checks: [
          { name: "tests", type: "command", status: "running", startedAt: "2026-08-11T00:01:05.000Z" },
          { name: "review", type: "agent", provider: "claude", status: "waiting" },
        ],
      },
    },
    { at: Date.parse("2026-08-11T00:01:10.000Z"), spinner: "◐" },
  );
  const output = lines.join("\n");
  assert.match(output, /Loops • run-1/);
  assert.match(output, /Agent: opencode/);
  assert.match(output, /Iteration: 2 \/ 5/);
  assert.match(output, /◐ tests — 00:05/);
  assert.match(output, /○ review \(claude\)/);
  assert.doesNotMatch(output, /secret agent response/);
});

test("non-TTY status emits only changed transitions", () => {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  const status = new LiveStatus({ stream, tty: false });
  const activity = {
    phase: "implementing",
    message: "codex is working",
    provider: "codex",
    iteration: 1,
    maxIterations: 5,
    startedAt: new Date().toISOString(),
  };
  status.start({ id: "run-1", startedAt: new Date().toISOString(), activity });
  status.update({ type: "activity.updated", runId: "run-1", activity });
  status.update({
    type: "activity.updated",
    runId: "run-1",
    activity: { ...activity, phase: "verifying", message: "Running verification gates" },
  });
  assert.equal(output.trim().split("\n").length, 2);
  assert.match(output, /Implementing/);
  assert.match(output, /Verifying/);
});

test("status shows concise provider retry activity without raw logs", () => {
  const lines = formatStatus(
    {
      id: "run-2",
      startedAt: "2026-08-11T00:00:00.000Z",
      activity: {
        phase: "implementing",
        message: "Gateway request failed; OpenCode is retrying (2/3)",
        provider: "opencode",
        iteration: 1,
        maxIterations: 5,
        startedAt: "2026-08-11T00:00:00.000Z",
        lastProviderActivityAt: "2026-08-11T00:00:08.000Z",
      },
    },
    { at: Date.parse("2026-08-11T00:00:10.000Z"), spinner: "◐" },
  );
  const output = lines.join("\n");
  assert.match(output, /retrying \(2\/3\)/);
  assert.match(output, /Provider activity: 00:02 ago/);
  assert.doesNotMatch(output, /AI_APICallError/);
});
