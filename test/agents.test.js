import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAgentRunner } from "../src/agent.js";
import { parseClaudeOutput, runClaude } from "../src/claude.js";
import { parseOpenCodeDiagnostic, parseOpenCodeEvents, runOpenCode } from "../src/opencode.js";
import { parsePiEvents, runPi } from "../src/pi.js";
import { parseAgentVerdict, runVerification } from "../src/verifier.js";
import { createTaskInteractively } from "../src/wizard.js";

async function fakeAgent(directory) {
  const executable = path.join(directory, "fake-agent");
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' "$@" > "$LOOP_AGENT_ARGS"
printf '%s\\n' "$LOOP_AGENT_OUTPUT"
`,
    { mode: 0o755 },
  );
  return executable;
}

test("OpenCode JSON events expose session and final text", () => {
  const parsed = parseOpenCodeEvents(
    [
      JSON.stringify({ type: "step_start", sessionID: "ses-123" }),
      JSON.stringify({ type: "text", sessionID: "ses-123", part: { type: "text", text: "Implemented" } }),
    ].join("\n"),
  );
  assert.equal(parsed.sessionId, "ses-123");
  assert.equal(parsed.finalMessage, "Implemented");
  assert.equal(parsed.events.length, 2);
});

test("Claude JSON output exposes session and result", () => {
  const parsed = parseClaudeOutput(
    JSON.stringify({
      type: "result",
      session_id: "claude-123",
      result: "Implemented",
    }),
  );
  assert.equal(parsed.sessionId, "claude-123");
  assert.equal(parsed.finalMessage, "Implemented");
});

test("agent registry exposes Pi", () => {
  assert.equal(getAgentRunner("pi"), runPi);
});

test("Pi JSON events expose session and final text", () => {
  const parsed = parsePiEvents(
    [
      JSON.stringify({ type: "session", version: 3, id: "pi-123", cwd: "/tmp" }),
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "Implemented" }] },
      }),
    ].join("\n"),
  );
  assert.equal(parsed.sessionId, "pi-123");
  assert.equal(parsed.finalMessage, "Implemented");
  assert.equal(parsed.events.length, 2);
});

test("Pi JSON events keep the authoritative message_end text", () => {
  const parsed = parsePiEvents(
    [
      JSON.stringify({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: '{"title":"Ready","body":"Done"}' }] },
      }),
      JSON.stringify({
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Let me inspect one more file." }],
          },
        ],
      }),
    ].join("\n"),
  );

  assert.equal(parsed.finalMessage, '{"title":"Ready","body":"Done"}');
});

test("Pi JSON events fall back to agent_end text without message_end", () => {
  const parsed = parsePiEvents(
    JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Fallback" }] }],
    }),
  );

  assert.equal(parsed.finalMessage, "Fallback");
});

test("OpenCode adapter builds non-interactive resume arguments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-opencode-"));
  const executable = await fakeAgent(directory);
  const argsPath = path.join(directory, "args");
  process.env.LOOP_AGENT_ARGS = argsPath;
  process.env.LOOP_AGENT_OUTPUT = JSON.stringify({ type: "text", sessionID: "ses-2", part: { text: "done" } });
  const result = await runOpenCode({
    cwd: directory,
    prompt: "build it",
    sandbox: "workspace-write",
    model: "provider/model",
    sessionId: "ses-1",
    timeoutSeconds: 5,
    executable,
  });
  const args = (await readFile(argsPath, "utf8")).trim().split("\n");
  assert.deepEqual(args.slice(0, 12), [
    "run",
    "--dir",
    directory,
    "--format",
    "json",
    "--print-logs",
    "--log-level",
    "WARN",
    "--model",
    "provider/model",
    "--session",
    "ses-1",
  ]);
  assert.ok(args.includes("--auto"));
  assert.equal(result.sessionId, "ses-2");
});

test("OpenCode diagnostics identify primary provider failures", () => {
  const diagnostic = parseOpenCodeDiagnostic(
    'timestamp=now level=ERROR message="stream error" providerID=gateway modelID=test-model small=false error.error="AI_APICallError: unavailable"',
  );
  assert.deepEqual(diagnostic, {
    type: "provider.error",
    provider: "gateway",
    model: "test-model",
    primary: true,
    error: "unavailable",
  });
});

test("OpenCode adapter stops after repeated primary provider failures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-opencode-errors-"));
  const executable = path.join(directory, "fake-opencode-errors");
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\n' 'timestamp=now level=ERROR message="stream error" providerID=gateway modelID=broken small=false error.error="AI_APICallError: unavailable"' >&2
printf '%s\n' 'timestamp=now level=ERROR message="stream error" providerID=gateway modelID=broken small=false error.error="AI_APICallError: unavailable"' >&2
while :; do sleep 1; done
`,
    { mode: 0o755 },
  );
  const diagnostics = [];
  const result = await runOpenCode({
    cwd: directory,
    prompt: "build it",
    sandbox: "workspace-write",
    timeoutSeconds: 5,
    maxProviderErrors: 2,
    onActivity: (diagnostic) => diagnostics.push(diagnostic),
    executable,
  });
  assert.equal(result.providerErrors, 2);
  assert.match(result.providerError, /gateway\/broken failed 2 times/);
  assert.equal(result.timedOut, false);
  assert.equal(diagnostics.at(-1).retrying, false);
});

test("Claude adapter maps read-only verification to plan mode", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-claude-"));
  const executable = await fakeAgent(directory);
  const argsPath = path.join(directory, "args");
  process.env.LOOP_AGENT_ARGS = argsPath;
  process.env.LOOP_AGENT_OUTPUT = JSON.stringify({ type: "result", session_id: "claude-2", result: "done" });
  const result = await runClaude({
    cwd: directory,
    prompt: "review it",
    sandbox: "read-only",
    model: null,
    sessionId: "claude-1",
    timeoutSeconds: 5,
    executable,
  });
  const args = (await readFile(argsPath, "utf8")).trim().split("\n");
  assert.deepEqual(args.slice(0, 5), ["-p", "--output-format", "json", "--permission-mode", "plan"]);
  assert.ok(args.includes("--resume"));
  assert.equal(result.sessionId, "claude-2");
});

test("Pi adapter builds non-interactive read-only resume arguments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-pi-"));
  const executable = await fakeAgent(directory);
  const argsPath = path.join(directory, "args");
  process.env.LOOP_AGENT_ARGS = argsPath;
  process.env.LOOP_AGENT_OUTPUT = [
    JSON.stringify({ type: "session", version: 3, id: "pi-2", cwd: directory }),
    JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    }),
  ].join("\n");
  const result = await runPi({
    cwd: directory,
    prompt: "review it",
    sandbox: "read-only",
    model: "openai/gpt-test",
    sessionId: "pi-1",
    timeoutSeconds: 5,
    executable,
  });
  const args = (await readFile(argsPath, "utf8")).trim().split("\n");
  assert.deepEqual(args, [
    "--mode",
    "json",
    "--model",
    "openai/gpt-test",
    "--session",
    "pi-1",
    "--tools",
    "read,grep,find,ls",
    "review it",
  ]);
  assert.equal(result.provider, "pi");
  assert.equal(result.sessionId, "pi-2");
  assert.equal(result.finalMessage, "done");
});

test("agent verdict parser accepts fenced structured output", () => {
  assert.deepEqual(
    parseAgentVerdict(
      'Review complete.\n```json\n{"passed":false,"summary":"Missing test","evidence":["test.js"]}\n```',
    ),
    { passed: false, summary: "Missing test", evidence: ["test.js"] },
  );
});

test("agent verification uses read-only mode and structured pass/fail", async () => {
  let request;
  const result = await runVerification({
    cwd: "/tmp",
    goal: "Build the feature",
    checks: [
      { type: "agent", name: "review", provider: "claude", prompt: "Check security", model: null, extraArgs: [] },
    ],
    timeoutSeconds: 5,
    maxOutputChars: 2000,
    agentRunner: async (input) => {
      request = input;
      return {
        exitCode: 0,
        timedOut: false,
        finalMessage: '{"passed":true,"summary":"Secure","evidence":["auth.js"]}',
        stdout: "",
        stderr: "",
        durationMs: 1,
      };
    },
  });
  assert.equal(request.sandbox, "read-only");
  assert.match(request.prompt, /Do not edit/);
  assert.equal(result.passed, true);
  assert.equal(result.checks[0].verdict.summary, "Secure");
});

test("interactive wizard can add command and agent verification gates", async () => {
  const queues = {
    input: ["interactive-task", "Build a secure API", "", "tests", "npm test", "review", "Check security", "HEAD"],
    select: ["codex", "workspace-write", "resume", "command", "agent", "claude", "none"],
    confirm: [true, false, true],
    number: [4, 2, 600],
  };
  const prompts = Object.fromEntries(Object.entries(queues).map(([key, values]) => [key, async () => values.shift()]));
  const task = await createTaskInteractively(prompts);
  assert.equal(task.agent.provider, "codex");
  assert.equal(task.verification.length, 2);
  assert.deepEqual(
    task.verification.map((check) => check.type),
    ["command", "agent"],
  );
  assert.equal(task.verification[1].provider, "claude");
  assert.equal(task.delivery.mode, "none");
});

test("interactive wizard configures deterministic pull-request delivery", async () => {
  const queues = {
    input: [
      "ship-feature",
      "Build it",
      "",
      "tests",
      "npm test",
      "HEAD",
      "Ship verified feature",
      "origin",
      "main",
      "loops",
      "Ship feature",
    ],
    select: ["codex", "workspace-write", "fresh", "command", "pr"],
    confirm: [false, true],
    number: [3, 2, 600],
  };
  const prompts = Object.fromEntries(Object.entries(queues).map(([key, values]) => [key, async () => values.shift()]));
  const task = await createTaskInteractively(prompts);
  assert.deepEqual(task.delivery, {
    mode: "pr",
    commitMessage: "Ship verified feature",
    remote: "origin",
    base: "main",
    branchPrefix: "loops",
    title: "Ship feature",
  });
});
