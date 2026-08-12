import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRun, executeRun, planRun, resumeRun } from "../src/controller.js";
import { pathExists, removeWorktree } from "../src/git.js";
import { acquireRunLock, listStates, loadState, saveFeedback, saveState } from "../src/storage.js";
import { loadTask } from "../src/task.js";

const exec = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function execCli(args, options = {}) {
  const env = { ...process.env, ...options.env };
  delete env.NODE_TEST_CONTEXT;
  return exec(process.execPath, [cliPath, ...args], { ...options, env });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

async function makeRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), "loops-test-"));
  await exec("git", ["init", "-q"], { cwd: root });
  await exec("git", ["config", "user.name", "Loop Test"], { cwd: root });
  await exec("git", ["config", "user.email", "loop@example.test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "fixture\n");
  await exec("git", ["add", "README.md"], { cwd: root });
  await exec("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

async function makeFakeCodex(directory) {
  const executable = path.join(directory, "fake-codex");
  await writeFile(
    executable,
    `#!/bin/sh
count=0
if [ -f "$FAKE_CODEX_COUNT" ]; then count=$(sed -n '1p' "$FAKE_CODEX_COUNT"); fi
count=$((count + 1))
printf '%s' "$count" > "$FAKE_CODEX_COUNT"
if [ -n "$FAKE_CODEX_ARGS" ]; then printf '%s\\n' "$@" >> "$FAKE_CODEX_ARGS"; fi
printf '%s\\n' '{"type":"thread.started","thread_id":"thread-test"}'
if [ "$FAKE_CODEX_MODE" = "hang" ]; then while :; do sleep 1; done; fi
if [ "$FAKE_CODEX_MODE" = "pass" ] || [ "$FAKE_CODEX_MODE" = "pr-fix" ] || [ "$FAKE_CODEX_MODE" = "resume" ] || { [ "$FAKE_CODEX_MODE" = "second-pass" ] && [ "$count" -ge 2 ]; }; then
  printf 'ok\\n' > result.txt
fi
prompt=
for argument in "$@"; do prompt=$argument; done
case "$prompt" in
  *"pull-request author"*) final='{"title":"Fixture pull request","body":"Creates and verifies result.txt."}' ;;
  *"merge-readiness agent"*)
    if [ "$FAKE_CODEX_MODE" = "pr-fix" ] && [ ! -f review-fix.txt ]; then
      printf 'review fix\\n' > review-fix.txt
      final='{"ready":false,"summary":"A review fix was prepared","evidence":["review-fix.txt"]}'
    else
      final='{"ready":true,"summary":"The PR is merge-ready","evidence":["CI passed"]}'
    fi
    ;;
  *) final="attempt $count" ;;
esac
escaped=$(printf '%s' "$final" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$escaped"
`,
    { mode: 0o755 },
  );
  return executable;
}

async function makeFakeClaude(directory) {
  const executable = path.join(directory, "fake-claude");
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' '{"type":"result","session_id":"review-session","result":"{\\"passed\\":true,\\"summary\\":\\"Implementation meets the criterion\\",\\"evidence\\":[\\"result.txt\\"]}"}'
`,
    { mode: 0o755 },
  );
  return executable;
}

async function writeTask(root, overrides = {}) {
  const task = {
    name: "fixture-task",
    goal: "Create result.txt containing ok",
    verification: [{ name: "result", command: 'test "$(cat result.txt 2>/dev/null)" = ok' }],
    limits: { maxIterations: 4, maxNoProgress: 2, timeoutSeconds: 5, maxOutputChars: 2000 },
    codex: { sandbox: "workspace-write", model: null, extraArgs: [] },
    sessionStrategy: "fresh",
    worktree: { enabled: true, base: "HEAD", keep: true },
    ...overrides,
  };
  const taskPath = path.join(root, "loop.task.json");
  await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`);
  return taskPath;
}

async function withFakeEnvironment(root, mode, callback) {
  const fake = await makeFakeCodex(root);
  const previous = {
    executable: process.env.LOOPS_CODEX_PATH,
    mode: process.env.FAKE_CODEX_MODE,
    count: process.env.FAKE_CODEX_COUNT,
    args: process.env.FAKE_CODEX_ARGS,
  };
  process.env.LOOPS_CODEX_PATH = fake;
  process.env.FAKE_CODEX_MODE = mode;
  process.env.FAKE_CODEX_COUNT = path.join(root, "codex-count");
  process.env.FAKE_CODEX_ARGS = path.join(root, "codex-args.jsonl");
  try {
    return await callback();
  } finally {
    for (const [key, value] of Object.entries({
      LOOPS_CODEX_PATH: previous.executable,
      FAKE_CODEX_MODE: previous.mode,
      FAKE_CODEX_COUNT: previous.count,
      FAKE_CODEX_ARGS: previous.args,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("CLI help explains the non-interactive agent contract", async () => {
  const outputs = await Promise.all(["help", "--help", "-h"].map((argument) => execCli([argument])));
  for (const output of outputs) {
    assert.match(output.stdout, /Agent workflow \(non-interactive\):/);
    assert.match(output.stdout, /loops run tasks\/change\.task\.json --quiet/);
    assert.match(output.stdout, /Minimal task:/);
    assert.match(output.stdout, /Only status "success"/);
    assert.match(output.stdout, /Inspect before cleanup/);
    assert.equal(output.stderr, "");
  }
  assert.equal(outputs[0].stdout, outputs[1].stdout);
  assert.equal(outputs[1].stdout, outputs[2].stdout);
});

test("dry run validates and plans without creating .loop", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root);
  const planned = await planRun(taskPath, { cwd: root });
  assert.equal(planned.repoRoot, root);
  assert.equal(planned.worktree.enabled, true);
  assert.equal(await pathExists(path.join(root, ".loop")), false);
});

test("dry run rejects an unborn worktree base before creating .loop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "loops-empty-"));
  await exec("git", ["init", "-q"], { cwd: root });
  const taskPath = await writeTask(root);
  await assert.rejects(planRun(taskPath, { cwd: root }), /Worktree base is not a valid commit: HEAD/);
  assert.equal(await pathExists(path.join(root, ".loop")), false);
});

test("no-worktree override refuses automatic delivery", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root, {
    delivery: { mode: "commit", commitMessage: "Unsafe commit" },
  });
  await assert.rejects(planRun(taskPath, { cwd: root, noWorktree: true }), /requires an isolated worktree/);
  assert.equal(await pathExists(path.join(root, ".loop")), false);
});

test("CLI init creates a valid task and refuses to overwrite it", async () => {
  const root = await makeRepository();
  const taskPath = path.join(root, "created.task.json");
  await execCli(["init", taskPath], { cwd: root });
  assert.equal(await readFile(path.join(root, ".loop", ".gitignore"), "utf8"), "runs/\nworktrees/\n");
  const { task: validated } = await loadTask(taskPath);
  assert.equal(validated.agent.sandbox, "workspace-write");
  await assert.rejects(execCli(["init", taskPath], { cwd: root }), (error) => error.code === 2);
});

test("run creates an isolated worktree, parses events, succeeds, and cleans up", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root);
  await withFakeEnvironment(root, "pass", async () => {
    const context = await createRun(taskPath, { cwd: root });
    assert.notEqual(context.state.worktreePath, root);
    assert.equal(await pathExists(context.state.worktreePath), true);
    const progressEvents = [];
    const state = await executeRun(context, { onProgress: (event) => progressEvents.push(structuredClone(event)) });
    assert.equal(state.status, "success");
    assert.equal(state.iteration, 1);
    assert.equal(state.sessionId, "thread-test");
    assert.equal(state.history[0].agent.finalMessage, "attempt 1");
    assert.equal(state.activity.phase, "success");
    assert.equal(state.activity.checks[0].status, "passed");
    assert.deepEqual(
      [
        ...new Set(
          progressEvents.filter((event) => event.type === "activity.updated").map((event) => event.activity.phase),
        ),
      ],
      ["implementing", "verifying", "persisting"],
    );
    assert.equal((await readFile(path.join(state.worktreePath, "result.txt"), "utf8")).trim(), "ok");
    const events = (await readFile(context.paths.eventsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "run.started",
        "iteration.started",
        "agent.completed",
        "verification.completed",
        "iteration.completed",
        "run.completed",
      ],
    );
    const listed = await listStates(root);
    assert.equal(listed[0].id, state.id);
    const { state: inspected } = await loadState(root, state.id);
    assert.equal(inspected.status, "success");
    await execCli(["cleanup", state.id], { cwd: root });
    assert.equal(await pathExists(state.worktreePath), false);
    assert.equal(await pathExists(context.paths.statePath), true);
  });
});

test("CLI run reports verified success as JSON", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root);
  await withFakeEnvironment(root, "pass", async () => {
    await execCli(["run", taskPath], { cwd: root });
    const [state] = await listStates(root);
    assert.equal(state.status, "success");
    await execCli(["cleanup", state.id], { cwd: root });
  });
});

test("failed verification is fed to a second iteration", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root);
  await withFakeEnvironment(root, "second-pass", async () => {
    const context = await createRun(taskPath, { cwd: root });
    const state = await executeRun(context);
    assert.equal(state.status, "success");
    assert.equal(state.iteration, 2);
    assert.match(state.history[1].prompt, /Iteration 1 feedback/);
    assert.match(state.history[1].prompt, /Failed verification/);
    await removeWorktree({ repoRoot: root, worktreePath: state.worktreePath });
  });
});

test("controller accepts a structured agent verification gate", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root, {
    verification: [
      {
        type: "agent",
        name: "review",
        provider: "claude",
        prompt: "Confirm result.txt contains ok",
      },
    ],
  });
  const previousClaude = process.env.LOOPS_CLAUDE_PATH;
  process.env.LOOPS_CLAUDE_PATH = await makeFakeClaude(root);
  try {
    await withFakeEnvironment(root, "pass", async () => {
      const context = await createRun(taskPath, { cwd: root });
      const state = await executeRun(context);
      assert.equal(state.status, "success");
      const check = state.history[0].verification.checks[0];
      assert.equal(check.type, "agent");
      assert.equal(check.provider, "claude");
      assert.equal(check.verdict.passed, true);
      assert.equal(check.verdict.evidence[0], "result.txt");
      await removeWorktree({ repoRoot: root, worktreePath: state.worktreePath });
    });
  } finally {
    if (previousClaude === undefined) delete process.env.LOOPS_CLAUDE_PATH;
    else process.env.LOOPS_CLAUDE_PATH = previousClaude;
  }
});

test("identical repository and verification evidence stops for no progress", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root, {
    limits: { maxIterations: 5, maxNoProgress: 1, timeoutSeconds: 5, maxOutputChars: 2000 },
  });
  await withFakeEnvironment(root, "noop", async () => {
    const context = await createRun(taskPath, { cwd: root });
    const state = await executeRun(context);
    assert.equal(state.status, "no_progress");
    assert.equal(state.iteration, 2);
    assert.equal(state.noProgress, 1);
    await removeWorktree({ repoRoot: root, worktreePath: state.worktreePath });
  });
});

test("iteration limit stops a changing-but-never-passing run", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root, {
    limits: { maxIterations: 2, maxNoProgress: 5, timeoutSeconds: 5, maxOutputChars: 2000 },
  });
  await withFakeEnvironment(root, "noop", async () => {
    const context = await createRun(taskPath, { cwd: root });
    const state = await executeRun(context);
    assert.equal(state.status, "max_iterations");
    assert.equal(state.iteration, 2);
    await removeWorktree({ repoRoot: root, worktreePath: state.worktreePath });
  });
});

test("a missing Codex executable is recorded and cannot produce success", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root, {
    verification: [{ name: "existing-state", command: "true" }],
    limits: { maxIterations: 1, maxNoProgress: 2, timeoutSeconds: 5, maxOutputChars: 2000 },
  });
  const previous = process.env.LOOPS_CODEX_PATH;
  process.env.LOOPS_CODEX_PATH = path.join(root, "does-not-exist");
  try {
    const context = await createRun(taskPath, { cwd: root });
    const state = await executeRun(context);
    assert.equal(state.status, "max_iterations");
    assert.match(state.history[0].agent.processError, /ENOENT/);
    assert.equal(state.history[0].verification.passed, true);
    await removeWorktree({ repoRoot: root, worktreePath: state.worktreePath });
  } finally {
    if (previous === undefined) delete process.env.LOOPS_CODEX_PATH;
    else process.env.LOOPS_CODEX_PATH = previous;
  }
});

test("resume continues at the next iteration and passes the saved thread ID", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root, { sessionStrategy: "resume" });
  await withFakeEnvironment(root, "resume", async () => {
    const created = await createRun(taskPath, { cwd: root });
    created.state.iteration = 1;
    created.state.sessionId = "saved-thread";
    await saveState(created.paths, created.state);
    await saveFeedback(created.paths, "saved external failure");
    const resumed = await resumeRun(root, created.state.id);
    const state = await executeRun(resumed);
    assert.equal(state.status, "success");
    assert.equal(state.iteration, 2);
    assert.match(state.history[0].prompt, /saved external failure/);
    const args = (await readFile(process.env.FAKE_CODEX_ARGS, "utf8")).trim().split("\n");
    assert.deepEqual(args.slice(0, 5), ["exec", "--sandbox", "workspace-write", "resume", "--json"]);
    assert.ok(args.includes("saved-thread"));
    await removeWorktree({ repoRoot: root, worktreePath: state.worktreePath });
  });
});

test("a timed out Codex process is killed and recorded", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root, {
    verification: [{ name: "always", command: "true" }],
    limits: { maxIterations: 3, maxNoProgress: 2, timeoutSeconds: 1, maxOutputChars: 2000 },
  });
  await withFakeEnvironment(root, "hang", async () => {
    const context = await createRun(taskPath, { cwd: root });
    const state = await executeRun(context);
    assert.equal(state.status, "timeout");
    assert.equal(state.history[0].agent.timedOut, true);
    await removeWorktree({ repoRoot: root, worktreePath: state.worktreePath });
  });
});

test("cancelling a run kills the agent and records a terminal state", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root, {
    limits: { maxIterations: 3, maxNoProgress: 2, timeoutSeconds: 10, maxOutputChars: 2000 },
  });
  await withFakeEnvironment(root, "hang", async () => {
    const context = await createRun(taskPath, { cwd: root });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const state = await executeRun(context, { signal: controller.signal });
    assert.equal(state.status, "cancelled");
    assert.equal(state.history[0].cancelled, true);
    assert.equal(await pathExists(context.paths.lockPath), false);
    await removeWorktree({ repoRoot: root, worktreePath: state.worktreePath });
  });
});

test("CLI SIGINT cancels the active run and releases its execution lock", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root, {
    limits: { maxIterations: 3, maxNoProgress: 2, timeoutSeconds: 10, maxOutputChars: 2000 },
  });
  await withFakeEnvironment(root, "hang", async () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [cliPath, "run", taskPath, "--quiet"], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();
    const running = await waitFor(async () => {
      const [state] = await listStates(root);
      return state?.activity?.phase === "implementing" ? state : null;
    });
    child.kill("SIGINT");
    const [exitCode] = await once(child, "close");
    assert.equal(exitCode, 130);
    const { state, paths } = await loadState(root, running.id);
    assert.equal(state.status, "cancelled");
    assert.equal(await pathExists(paths.lockPath), false);
    await removeWorktree({ repoRoot: root, worktreePath: state.worktreePath });
  });
});

test("resume refuses to start while the run execution lock is active", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root);
  const context = await createRun(taskPath, { cwd: root });
  const release = await acquireRunLock(context.paths);
  try {
    await assert.rejects(resumeRun(root, context.state.id), /already being executed/);
  } finally {
    await release();
    await removeWorktree({ repoRoot: root, worktreePath: context.state.worktreePath });
  }
});

test("repeated OpenCode provider failures stop the run explicitly", async () => {
  const root = await makeRepository();
  const executable = path.join(root, "fake-opencode-errors");
  await writeFile(
    executable,
    `#!/bin/sh
count=0
while [ "$count" -lt 3 ]; do
  printf '%s\n' 'timestamp=now level=ERROR message="stream error" providerID=gateway modelID=broken small=false error.error="AI_APICallError: unavailable"' >&2
  count=$((count + 1))
done
while :; do sleep 1; done
`,
    { mode: 0o755 },
  );
  const taskPath = await writeTask(root, {
    codex: undefined,
    agent: { provider: "opencode", sandbox: "workspace-write", model: null, extraArgs: [] },
    verification: [{ name: "always", command: "true" }],
    limits: { maxIterations: 3, maxNoProgress: 2, timeoutSeconds: 10, maxOutputChars: 2000 },
  });
  const previous = process.env.LOOPS_OPENCODE_PATH;
  process.env.LOOPS_OPENCODE_PATH = executable;
  try {
    const context = await createRun(taskPath, { cwd: root });
    const state = await executeRun(context);
    assert.equal(state.status, "provider_error");
    assert.match(state.error, /gateway\/broken failed 3 times/);
    assert.equal(state.history[0].agent.providerErrors, 3);
    await removeWorktree({ repoRoot: root, worktreePath: state.worktreePath });
  } finally {
    if (previous === undefined) delete process.env.LOOPS_OPENCODE_PATH;
    else process.env.LOOPS_OPENCODE_PATH = previous;
  }
});

test("verified delivery can create a commit automatically", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root, {
    delivery: { mode: "commit", commitMessage: "Implement verified fixture" },
  });
  await withFakeEnvironment(root, "pass", async () => {
    const context = await createRun(taskPath, { cwd: root });
    const state = await executeRun(context);
    assert.equal(state.status, "success");
    assert.equal(state.delivery.status, "success");
    assert.match(state.delivery.commitHash, /^[0-9a-f]{40}$/);
    const subject = await exec("git", ["show", "-s", "--format=%s", state.delivery.commitHash], {
      cwd: state.worktreePath,
    });
    assert.equal(subject.stdout.trim(), "Implement verified fixture");
    assert.equal((await exec("git", ["status", "--short"], { cwd: state.worktreePath })).stdout, "");
    await removeWorktree({ repoRoot: root, worktreePath: state.worktreePath });
  });
});

test("delivery failure is explicit and preserves the verified worktree", async () => {
  const root = await makeRepository();
  const taskPath = await writeTask(root, {
    verification: [{ name: "always", command: "true" }],
    delivery: { mode: "commit", commitMessage: "Nothing to commit" },
  });
  await withFakeEnvironment(root, "noop", async () => {
    const context = await createRun(taskPath, { cwd: root });
    const state = await executeRun(context);
    assert.equal(state.status, "delivery_failed");
    assert.equal(state.delivery.status, "failed");
    assert.match(state.error, /produced no changes/);
    assert.equal(await pathExists(state.worktreePath), true);
    await removeWorktree({ repoRoot: root, worktreePath: state.worktreePath });
  });
});

test("agent delivery authors, fixes, verifies, and monitors a pull request", async () => {
  const root = await makeRepository();
  const remote = await mkdtemp(path.join(os.tmpdir(), "loops-remote-"));
  await exec("git", ["init", "--bare", "-q"], { cwd: remote });
  await exec("git", ["remote", "add", "origin", remote], { cwd: root });
  const base = (await exec("git", ["branch", "--show-current"], { cwd: root })).stdout.trim();
  await exec("git", ["push", "-q", "origin", `HEAD:refs/heads/${base}`], { cwd: root });

  const fakeGh = path.join(root, "fake-gh");
  const ghArgs = path.join(root, "gh-args");
  await writeFile(
    fakeGh,
    `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  printf '%s\\n' "$@" > "$LOOPS_GH_ARGS"
  printf '%s\\n' 'https://github.com/example/project/pull/42'
elif [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"url":"https://github.com/example/project/pull/42","state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","reviewDecision":"","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"}]}'
else
  printf '%s\\n' "unexpected gh arguments: $*" >&2
  exit 1
fi
`,
    { mode: 0o755 },
  );
  const taskPath = await writeTask(root, {
    delivery: {
      mode: "pr",
      commitMessage: "Implement PR fixture",
      remote: "origin",
      base,
      branchPrefix: "loops",
      title: "Fixture pull request",
    },
  });
  const previousGh = process.env.LOOPS_GH_PATH;
  const previousGhArgs = process.env.LOOPS_GH_ARGS;
  process.env.LOOPS_GH_PATH = fakeGh;
  process.env.LOOPS_GH_ARGS = ghArgs;
  try {
    await withFakeEnvironment(root, "pr-fix", async () => {
      const context = await createRun(taskPath, { cwd: root });
      const state = await executeRun(context);
      assert.equal(state.status, "success");
      assert.equal(state.delivery.status, "success");
      assert.equal(state.delivery.prUrl, "https://github.com/example/project/pull/42");
      assert.equal(state.delivery.mergeReady, true);
      assert.equal(state.delivery.title, "Fixture pull request");
      assert.equal(state.delivery.attempts.length, 2);
      assert.equal(state.delivery.attempts[0].verification.passed, true);
      assert.match(state.delivery.branch, /^loops\/fixture-task-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/);
      await exec("git", ["--git-dir", remote, "rev-parse", `refs/heads/${state.delivery.branch}`]);
      const deliveredFix = await exec("git", [
        "--git-dir",
        remote,
        "show",
        `refs/heads/${state.delivery.branch}:review-fix.txt`,
      ]);
      assert.equal(deliveredFix.stdout.trim(), "review fix");
      const args = (await readFile(ghArgs, "utf8")).trim().split("\n");
      assert.deepEqual(args.slice(0, 7), ["pr", "create", "--base", base, "--head", state.delivery.branch, "--title"]);
      assert.ok(args.includes("Fixture pull request"));
      await removeWorktree({ repoRoot: root, worktreePath: state.worktreePath });
    });
  } finally {
    if (previousGh === undefined) delete process.env.LOOPS_GH_PATH;
    else process.env.LOOPS_GH_PATH = previousGh;
    if (previousGhArgs === undefined) delete process.env.LOOPS_GH_ARGS;
    else process.env.LOOPS_GH_ARGS = previousGhArgs;
  }
});
