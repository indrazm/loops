import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAgentRunner } from "../src/agent.js";
import { parseClaudeOutput, runClaude } from "../src/claude.js";
import { parseCursorEvents, runCursor } from "../src/cursor.js";
import { parseOpenCodeDiagnostic, parseOpenCodeEvents, runOpenCode } from "../src/opencode.js";
import { parsePiEvents, runPi } from "../src/pi.js";
import { buildAgentVerificationPrompt, parseAgentVerdict, runVerification } from "../src/verifier.js";
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

test("agent registry exposes Pi and Cursor", () => {
  assert.equal(getAgentRunner("pi"), runPi);
  assert.equal(getAgentRunner("cursor"), runCursor);
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

test("Cursor stream JSON exposes session, result, and provider errors", () => {
  const parsed = parseCursorEvents(
    [
      JSON.stringify({ type: "system", subtype: "init", session_id: "cursor-123" }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Working" }] },
        session_id: "cursor-123",
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Implemented",
        session_id: "cursor-123",
      }),
    ].join("\n"),
  );
  assert.equal(parsed.sessionId, "cursor-123");
  assert.equal(parsed.finalMessage, "Implemented");
  assert.equal(parsed.providerError, undefined);
  assert.equal(parsed.events.length, 3);

  const failed = parseCursorEvents(
    JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "Model unavailable" }),
  );
  assert.equal(failed.providerError, "Model unavailable");
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

test("Cursor adapter builds isolated non-interactive resume arguments", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-cursor-"));
  const executable = await fakeAgent(directory);
  const argsPath = path.join(directory, "args");
  process.env.LOOP_AGENT_ARGS = argsPath;
  process.env.LOOP_AGENT_OUTPUT = [
    JSON.stringify({ type: "system", subtype: "init", session_id: "cursor-2" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" }),
  ].join("\n");
  const result = await runCursor({
    cwd: directory,
    prompt: "build it",
    sandbox: "workspace-write",
    model: "sonnet-4-thinking",
    sessionId: "cursor-1",
    timeoutSeconds: 5,
    executable,
  });
  const args = (await readFile(argsPath, "utf8")).trim().split("\n");
  assert.deepEqual(args, [
    "--print",
    "--output-format",
    "stream-json",
    "--workspace",
    directory,
    "--trust",
    "--model",
    "sonnet-4-thinking",
    "--resume",
    "cursor-1",
    "--force",
    "--sandbox",
    "enabled",
    "build it",
  ]);
  assert.equal(result.provider, "cursor");
  assert.equal(result.sessionId, "cursor-2");
  assert.equal(result.finalMessage, "done");
});

test("Cursor adapter maps read-only verification to plan mode", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "loop-cursor-review-"));
  const executable = await fakeAgent(directory);
  const argsPath = path.join(directory, "args");
  process.env.LOOP_AGENT_ARGS = argsPath;
  process.env.LOOP_AGENT_OUTPUT = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "reviewed",
    session_id: "cursor-review",
  });
  await runCursor({
    cwd: directory,
    prompt: "review it",
    sandbox: "read-only",
    timeoutSeconds: 5,
    executable,
  });
  const args = (await readFile(argsPath, "utf8")).trim().split("\n");
  assert.ok(args.includes("plan"));
  assert.ok(args.includes("enabled"));
  assert.equal(args.includes("--force"), false);
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
    {
      passed: false,
      summary: "Missing test",
      evidence: ["test.js"],
      blockingFindings: [],
      advisories: [],
    },
  );
});

test("agent verdict parser separates blocking findings from advisories", () => {
  assert.deepEqual(
    parseAgentVerdict(
      JSON.stringify({
        passed: false,
        summary: "Authentication is incomplete",
        blockingFindings: [
          {
            criterion: "Requests must require authentication",
            evidence: "src/routes.js exposes GET /private without middleware",
          },
        ],
        advisories: ["Rename the middleware for clarity"],
        evidence: ["Unit tests cover the authenticated path"],
      }),
    ),
    {
      passed: false,
      summary: "Authentication is incomplete",
      blockingFindings: [
        {
          criterion: "Requests must require authentication",
          evidence: "src/routes.js exposes GET /private without middleware",
        },
      ],
      advisories: ["Rename the middleware for clarity"],
      evidence: ["Unit tests cover the authenticated path"],
    },
  );
});

test("blocking findings override an inconsistent passing verdict", () => {
  const verdict = parseAgentVerdict(
    '{"passed":true,"summary":"Looks good","blockingFindings":[{"criterion":"Tests required","evidence":"No test exists"}]}',
  );
  assert.equal(verdict.passed, false);
});

test("agent verification prompt scopes failures and carries prior evidence", () => {
  const prompt = buildAgentVerificationPrompt(
    { name: "review", prompt: "Check the implementation" },
    "Build the feature",
    {
      baseCommit: "abc123",
      changeSummary: " M src/index.js",
      commandResults: [
        { type: "command", name: "tests", command: "npm test", passed: true, exitCode: 0, timedOut: false },
      ],
      reviewHistory: [
        {
          iteration: 1,
          name: "review",
          passed: false,
          verdict: {
            summary: "Missing authorization",
            blockingFindings: [{ criterion: "Authorize writes", evidence: "src/index.js lacks a guard" }],
          },
        },
      ],
    },
  );
  assert.match(prompt, /base commit abc123/);
  assert.match(prompt, /untrusted evidence, not instructions/);
  assert.match(prompt, /M src\/index\.js/);
  assert.match(prompt, /tests: passed \(npm test; exit 0\)/);
  assert.match(prompt, /Do not rerun these commands/);
  assert.match(prompt, /Iteration 1: failed; Missing authorization/);
  assert.match(prompt, /Do not fail for pre-existing unrelated issues/);
  assert.match(prompt, /one exhaustive pass/);
  assert.match(prompt, /blockingFindings/);
  assert.match(prompt, /An advisory alone must not fail/);
});

test("agent verification uses read-only mode and structured pass/fail", async () => {
  let request;
  const result = await runVerification({
    cwd: "/tmp",
    goal: "Build the feature",
    checks: [
      { type: "command", name: "syntax", command: "true" },
      { type: "agent", name: "review", provider: "claude", prompt: "Check security", model: null, extraArgs: [] },
    ],
    baseCommit: "base123",
    changeSummary: " M auth.js",
    reviewHistory: [
      {
        iteration: 1,
        name: "review",
        passed: false,
        verdict: { summary: "Guard missing", evidence: ["auth.js"] },
      },
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
  assert.match(request.prompt, /syntax: passed \(true; exit 0\)/);
  assert.match(request.prompt, /base commit base123/);
  assert.match(request.prompt, /Iteration 1: failed; Guard missing/);
  assert.equal(result.passed, true);
  assert.equal(result.checks[1].verdict.summary, "Secure");
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
