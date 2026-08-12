import assert from "node:assert/strict";
import test from "node:test";
import { validateTask } from "../src/task.js";

test("task validation applies safe defaults", () => {
  const task = validateTask({
    name: "example",
    goal: "Make it work",
    verification: [{ name: "tests", command: "npm test" }],
  });
  assert.equal(task.limits.maxIterations, 5);
  assert.equal(task.limits.maxNoProgress, 2);
  assert.equal(task.limits.maxOutputChars, 12000);
  assert.equal(task.agent.provider, "codex");
  assert.equal(task.agent.sandbox, "workspace-write");
  assert.equal(task.sessionStrategy, "fresh");
  assert.equal(task.worktree.enabled, true);
  assert.equal(task.delivery.mode, "none");
});

test("pull-request delivery is normalized with deterministic defaults", () => {
  const task = validateTask({
    name: "Ship Feature",
    goal: "Build it",
    verification: [{ name: "tests", command: "npm test" }],
    delivery: { mode: "pr", base: "develop" },
  });
  assert.deepEqual(task.delivery, {
    mode: "pr",
    commitMessage: "loops: Ship Feature",
    remote: "origin",
    base: "develop",
    branchPrefix: "loops",
    title: "Ship Feature",
  });
});

test("automatic delivery requires an isolated worktree", () => {
  assert.throws(
    () =>
      validateTask({
        name: "unsafe-delivery",
        goal: "Build it",
        verification: [{ name: "tests", command: "npm test" }],
        worktree: { enabled: false },
        delivery: { mode: "commit" },
      }),
    /automatic delivery requires worktree.enabled to be true/,
  );
});

test("task validation reports all actionable errors", () => {
  assert.throws(
    () =>
      validateTask({
        name: "",
        goal: 3,
        verification: [],
        limits: { maxIterations: 0, maxNoProgress: 1.5, timeoutSeconds: -1 },
        sessionStrategy: "continuous",
        codex: { sandbox: "everything", extraArgs: "--flag" },
      }),
    (error) => {
      assert.match(error.message, /name must be a non-empty string/);
      assert.match(error.message, /verification must contain at least one command/);
      assert.match(error.message, /limits.maxIterations/);
      assert.match(error.message, /sessionStrategy must be fresh or resume/);
      assert.match(error.message, /codex.extraArgs must be an array/);
      return true;
    },
  );
});

test("task validation rejects non-string verification commands", () => {
  assert.throws(
    () =>
      validateTask({
        name: "example",
        goal: "goal",
        verification: [{ name: "tests", command: ["npm", "test"] }],
      }),
    /verification\[0\]\.command/,
  );
});

test("legacy codex tasks normalize to the generic agent schema", () => {
  const task = validateTask({
    name: "legacy",
    goal: "Keep old files working",
    verification: [{ name: "tests", command: "npm test" }],
    codex: { sandbox: "read-only", model: "gpt-test", extraArgs: [] },
  });
  assert.deepEqual(task.agent, {
    provider: "codex",
    sandbox: "read-only",
    model: "gpt-test",
    extraArgs: [],
  });
  assert.deepEqual(task.verification[0], { type: "command", name: "tests", command: "npm test" });
});

test("Pi is accepted for implementation and verification", () => {
  const task = validateTask({
    name: "pi-task",
    goal: "Build it with Pi",
    agent: { provider: "pi", model: "openai/gpt-test" },
    verification: [{ type: "agent", name: "review", provider: "pi", prompt: "Check the implementation" }],
  });
  assert.equal(task.agent.provider, "pi");
  assert.equal(task.agent.model, "openai/gpt-test");
  assert.equal(task.verification[0].provider, "pi");
});

test("agent verification gates are normalized read-only", () => {
  const task = validateTask({
    name: "reviewed",
    goal: "Build it",
    agent: { provider: "opencode" },
    verification: [{ type: "agent", name: "review", provider: "claude", prompt: "Check the implementation" }],
  });
  assert.deepEqual(task.verification[0], {
    type: "agent",
    name: "review",
    provider: "claude",
    prompt: "Check the implementation",
    model: null,
    extraArgs: [],
  });
});
