# Loops

`loops` repeatedly invokes a coding-agent CLI in an isolated Git worktree and accepts completion only after every configured verification gate passes. It supports OpenAI Codex, OpenCode, and Claude Code for implementation, plus a mix of deterministic shell checks and independent agent review gates.

Failed verification becomes evidence for the next implementation iteration. Iteration, timeout, output, and no-progress limits keep every run bounded. By default the runner never commits or publishes; a task can explicitly opt into a deterministic post-verification commit or GitHub pull request. It never merges or deploys.

## Requirements

- Node.js 20.17 or newer
- Git
- At least one installed and authenticated agent CLI:
  - `codex`
  - `opencode`
  - `claude`
- macOS or Linux

## Install

From this repository:

```sh
npm install
npm link
loops
```

## Agent-operated usage

Loops can be operated headlessly through its existing explicit commands. An outer agent writes a task file using the task format below, validates it, and starts the bounded implementation loop:

```sh
loops validate tasks/my-feature.task.json
loops run tasks/my-feature.task.json --dry-run
loops run tasks/my-feature.task.json --quiet
```

When stdout is not attached to a terminal, the completed run is returned as JSON. The agent can use the returned run ID with the existing lifecycle commands:

```sh
loops inspect <run-id>
loops resume <run-id>
loops cleanup <run-id>
```

Use `loops list` when the run ID must be recovered. Cleanup removes the selected worktree, so preserve or deliver successful changes before invoking it.

Agents should use explicit subcommands instead of bare `loops`, `loops wizard`, or interactive `loops init`. They can write the task JSON directly, or generate the default task file without prompts and then edit it:

```sh
loops init tasks/my-feature.task.json --defaults
```

### Suggested agent instruction

Projects that delegate Loops operation to a coding agent can include guidance like this in `AGENTS.md` or an equivalent agent instruction file:

```md
When using Loops, operate it through explicit, non-interactive commands. Do not invoke
bare `loops`, `loops wizard`, or interactive `loops init`. Write a task JSON file that
follows the repository's existing Loops task format, then run `loops validate`, followed
by `loops run --dry-run` when appropriate and `loops run --quiet`. A run is complete only
when its status is `success`. Use the exact run ID with `loops inspect` or `loops resume`.
Do not call `loops cleanup` until successful changes have been preserved or delivered.
```

For a complete reusable workflow, this repository also includes the [`operate-loops` Agent Skill](.cursor/skills/operate-loops/SKILL.md). Copy or link that skill directory into the target project's `.cursor/skills/` directory to make it available to agents operating Loops there.

## Interactive setup

Interactive setup remains available as an optional convenience for human operators.

Run this inside the Git repository you want to change:

```sh
loops
```

Bare `loops` opens the main interactive menu. From there you can create, validate, preview, or run a task; resume, list, inspect, or clean up runs; or exit. `loops wizard` opens the same menu explicitly.

The menu checks Git before opening. If the current directory is not inside a Git repository, Loops stops with a warning suggesting that you change into the project directory or run `git init`. `loops help` remains available from any directory.

You can also open task creation directly:

```sh
loops init tasks/my-feature.task.json
```

In a terminal, `init` opens an interactive wizard that asks for:

- The implementation goal.
- Codex, OpenCode, or Claude Code as the implementation agent.
- Model, sandbox/access level, and session behavior.
- One or more verification gates.
- Iteration, no-progress, and timeout limits.
- Git worktree settings.
- What to do after verification: keep changes, commit, or create a GitHub pull request.

Each verification prompt can be a shell command or an independent agent review. Add as many as needed. To generate the default file without prompts:

```sh
loops init tasks/my-feature.task.json --defaults
```

Existing files are never overwritten.

## Task format

```json
{
  "name": "add-health-endpoint",
  "goal": "Add GET /health returning HTTP 200 with {\"status\":\"ok\"} and appropriate tests.",
  "agent": {
    "provider": "opencode",
    "sandbox": "workspace-write",
    "model": null,
    "extraArgs": []
  },
  "verification": [
    {
      "type": "command",
      "name": "tests",
      "command": "pnpm test"
    },
    {
      "type": "command",
      "name": "typecheck",
      "command": "pnpm typecheck"
    },
    {
      "type": "agent",
      "name": "security-review",
      "provider": "claude",
      "prompt": "Verify the endpoint does not expose sensitive data and follows the project's authentication conventions."
    }
  ],
  "limits": {
    "maxIterations": 5,
    "maxNoProgress": 2,
    "timeoutSeconds": 1800,
    "maxOutputChars": 12000
  },
  "sessionStrategy": "resume",
  "worktree": {
    "enabled": true,
    "base": "HEAD",
    "keep": true
  },
  "delivery": {
    "mode": "none"
  }
}
```

Old task files using a top-level `"codex"` block and verification entries without `"type": "command"` remain valid.

### Automatic delivery

Delivery runs only after the implementation agent exits successfully and every verification gate passes. The default is `"mode": "none"`. To create a commit in the isolated worktree:

```json
{
  "delivery": {
    "mode": "commit",
    "commitMessage": "Implement health endpoint"
  }
}
```

To create a GitHub pull request:

```json
{
  "delivery": {
    "mode": "pr",
    "commitMessage": "Implement health endpoint",
    "remote": "origin",
    "base": "main",
    "branchPrefix": "loops",
    "title": "Add health endpoint"
  }
}
```

Pull-request delivery creates a unique `loops/<task>-<run>` branch, pushes it, and invokes `gh pr create`. Git and GitHub authentication must already be configured. A delivery error produces `delivery_failed` and preserves the worktree, commit, and branch for recovery. Automatic delivery requires an isolated worktree and cannot be combined with `--no-worktree`.

### Implementation providers

| Provider | Non-interactive command | Workspace-write mapping | Read-only review mapping |
|---|---|---|---|
| `codex` | `codex exec --json` | `--sandbox workspace-write` | `--sandbox read-only` |
| `opencode` | `opencode run --dir <worktree> --format json` | isolated worktree plus `--auto` | built-in `plan` agent |
| `claude` | `claude -p --output-format json` | `--permission-mode acceptEdits` | `--permission-mode plan` |

OpenCode does not expose the same hard filesystem sandbox flag as Codex. The runner pins `--dir` to the isolated worktree so OpenCode does not resolve a linked worktree session back to the main checkout. The `--auto` flag approves provider permissions that are not explicitly denied. Review provider-specific configuration before using it with sensitive repositories.

Provider model formats differ. Codex and Claude accept their native model identifiers; OpenCode expects `provider/model`.

`sessionStrategy: "fresh"` starts a new provider session each iteration. `"resume"` saves the provider session ID and continues it on later iterations and controller resumes.

### Agent verification gates

An agent gate runs after the implementation agent, in the selected provider's read-only/plan mode. The runner asks it to inspect the repository and return:

```json
{
  "passed": true,
  "summary": "Concise conclusion",
  "evidence": ["Specific file, behavior, or finding"]
}
```

The gate fails if the provider exits unsuccessfully, times out, returns malformed output, or reports `passed: false`. Its summary and evidence are persisted and failures are fed into the next implementation iteration.

Agent judgments are probabilistic. Prefer at least one deterministic command gate for tests, lint, builds, schemas, or other machine-checkable behavior, then use agent gates for semantics, architecture, UX, security review, or requirements that are difficult to encode in a script.

## Running a task

```sh
loops validate tasks/my-feature.task.json
loops run tasks/my-feature.task.json --dry-run
loops run tasks/my-feature.task.json
```

Dry runs perform task validation and Git discovery without creating `.loop`, a run, or a worktree.

In a terminal, active runs use a compact display that refreshes in place:

```text
Loops • 20260811-143025-a12f
Agent: opencode    Elapsed: 03:14
Iteration: 2 / 5
Status: ◐ Verifying    Phase: 00:18
Current: Verifying: typecheck
Verification:
  ✓ tests — 00:42
  ◐ typecheck — 00:18
  ○ security-review (claude)
```

Agent messages and command output are not streamed. Concise provider diagnostics, retry counts, and last-activity timing are shown while an agent runs; full output remains in the persisted run evidence. Non-TTY/CI runs emit only phase transitions. Disable progress output with `--quiet`.

Pressing Ctrl-C cancels the active agent process group, records the run as `cancelled`, and preserves its worktree. A per-run execution lock prevents `resume` from starting a second agent while the original process is still active. OpenCode gateway failures are surfaced in the dashboard and stop the run with `provider_error` after three failed primary requests.

To monitor an existing run from another terminal:

```sh
loops watch <run-id>
```

The implementation loop is:

1. Invoke the configured implementation agent.
2. Run every verification gate sequentially.
3. Stop immediately if the agent and every gate pass.
4. Otherwise persist feedback and retry.
5. Stop on timeout, repeated no progress, or the iteration limit.

## Inspecting and preserving results

```sh
loops list
loops inspect <run-id>
cd .loop/worktrees/<run-id>
git status
git diff
```

With `delivery.mode: "none"`, the original branch is unchanged. To keep a successful result manually:

```sh
git add .
git commit -m "Implement requested change"
git rev-parse HEAD
```

Then cherry-pick that hash in the original checkout. Cleanup force-removes only the selected worktree, so commit or copy changes first:

```sh
loops cleanup <run-id>
```

Logs remain under `.loop/runs/<run-id>`.

## Commands

```text
init [task-file] [--interactive | --defaults]
validate <task-file>
run <task-file> [--dry-run] [--no-worktree] [--quiet]
resume <run-id> [--task <task-file>] [--repo <path>] [--quiet]
watch <run-id> [--repo <path>] [--quiet]
list [--repo <path>]
inspect <run-id> [--repo <path>]
cleanup <run-id> [--repo <path>]
wizard
```

`--no-worktree` explicitly allows the implementation agent and checks to operate in the current checkout. The default is an isolated detached worktree.

Terminal statuses are `success`, `no_progress`, `max_iterations`, `failed_to_start`, `cancelled`, `provider_error`, `delivery_failed`, and `timeout`. An agent's final claim never controls completion by itself; every configured gate must pass.

## Storage

```text
.loop/
├── .gitignore
├── runs/<run-id>/
│   ├── state.json
│   ├── events.jsonl
│   ├── feedback.md
│   └── final-report.json
└── worktrees/<run-id>/
```

State writes use a temporary file and atomic rename. Resume interrupted non-terminal runs with:

```sh
loops resume <run-id>
```

## Security

Verification command strings run sequentially through the platform shell with your local permissions. Automatic pull-request delivery pushes to the configured remote and uses your existing `gh` credentials. Treat task files and repository scripts as code. Use disposable runners in CI and expose only required credentials.

The runner does not serialize the environment or authentication files into prompts or reports. It does not manage provider authentication. Output is bounded by `limits.maxOutputChars`.

Custom executable locations can be configured for testing or nonstandard installations:

```text
LOOPS_CODEX_PATH
LOOPS_OPENCODE_PATH
LOOPS_CLAUDE_PATH
```

## Development

```sh
npm run check
npm test
```

Tests use temporary Git repositories and fake agent executables. They require no model calls or network access.
