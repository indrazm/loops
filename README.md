# Loops

Loops runs coding agents in a bounded, externally verified feedback loop.

For each iteration it:

1. Creates or reuses an isolated Git worktree.
2. Asks an agent to implement the task.
3. Runs every verification gate.
4. Feeds failures into the next attempt.

A run succeeds only when the agent exits successfully **and every gate passes**. Iteration, timeout, output, and no-progress limits keep runs bounded.

Supported agents: **Codex, OpenCode, Claude Code, Pi, and Cursor Agent**.

Loops does not commit or publish by default. Tasks may opt into a verified commit or GitHub pull request; Loops never merges or deploys.

## Requirements

- Node.js 20.17 or newer
- Git
- macOS or Linux
- At least one installed and authenticated CLI: `codex`, `opencode`, `claude`, `pi`, or `cursor-agent`

## Install

```sh
npm install
npm link
loops help
```

## Quick start

Create a task file in the repository you want to change:

```json
{
  "name": "add-health-endpoint",
  "goal": "Add GET /health returning HTTP 200 with {\"status\":\"ok\"} and add tests.",
  "agent": {
    "provider": "pi"
  },
  "verification": [
    {
      "type": "command",
      "name": "tests",
      "command": "npm test"
    }
  ]
}
```

Validate, preview, and run it:

```sh
loops validate tasks/add-health-endpoint.task.json
loops run tasks/add-health-endpoint.task.json --dry-run
loops run tasks/add-health-endpoint.task.json
```

A dry run validates the task and Git base without creating `.loop`, a run, or a worktree.

Inspect the result:

```sh
loops list
loops inspect <run-id>
cd .loop/worktrees/<run-id>
git status
git diff
```

Only `status: "success"` means all verification passed.

## Configuration

### Agents

Set `agent.provider` to `codex`, `opencode`, `claude`, `pi`, or `cursor`:

```json
{
  "agent": {
    "provider": "pi",
    "sandbox": "workspace-write",
    "model": null,
    "extraArgs": []
  },
  "sessionStrategy": "resume"
}
```

- **Codex:** `codex exec --json`; access maps to Codex sandbox modes.
- **OpenCode:** `opencode run --dir <worktree> --format json`; write runs use `--auto`, reviews use its `plan` agent.
- **Claude Code:** `claude -p --output-format json`; write runs use `acceptEdits`, reviews use `plan` mode.
- **Pi:** `pi --mode json`; reviews allow only `read`, `grep`, `find`, and `ls` tools.
- **Cursor Agent:** `cursor-agent --print --output-format stream-json`; write runs use Cursor's enabled sandbox with forced non-interactive approvals, while reviews use plan mode.

Model identifiers are provider-specific. OpenCode expects `provider/model`; Pi accepts model patterns or `provider/model`; Codex, Claude, and Cursor use native identifiers.

`sessionStrategy` is `fresh` by default. Set it to `resume` to continue the provider session across iterations and resumed Loops runs.

Loops pins every provider to its isolated worktree. Cursor's own worktree option is intentionally not used, avoiding nested worktrees. OpenCode and Pi do not provide a Codex-style filesystem sandbox; a Loops worktree is not a security boundary, and both CLIs retain the permissions of the Loops process.

### Verification

At least one verification gate is required. Gates run sequentially.

Use command gates for tests, builds, linting, type checking, and schemas:

```json
{
  "type": "command",
  "name": "typecheck",
  "command": "npm run typecheck"
}
```

Use agent gates for semantic, architecture, UX, or security review:

```json
{
  "type": "agent",
  "name": "security-review",
  "provider": "pi",
  "prompt": "Check for authentication bypasses and sensitive-data exposure."
}
```

Agent gates run in read-only or plan mode. Loops supplies the run's base commit,
changed paths, preceding command-gate results, and earlier verdicts from the same
review gate. The reviewer is instructed to inspect the complete in-scope change
without rerunning deterministic commands, and to separate acceptance failures
from optional improvements.

The preferred structured verdict is:

```json
{
  "passed": false,
  "summary": "One acceptance criterion remains unmet",
  "blockingFindings": [
    {
      "criterion": "Exact acceptance criterion or repository rule",
      "evidence": "Specific file and behavior"
    }
  ],
  "advisories": ["Useful non-blocking improvement"],
  "evidence": ["Passing evidence or relevant context"]
}
```

Set `passed` to `false` only when `blockingFindings` is non-empty. Advisories do
not fail a run. The legacy `passed`, `summary`, and `evidence` shape remains
accepted for existing agents and task files.

Agent judgments are probabilistic. Prefer at least one deterministic command
gate and place semantic agent gates after it so the reviewer receives the gate
result.

### Limits and worktrees

```json
{
  "limits": {
    "maxIterations": 5,
    "maxNoProgress": 2,
    "timeoutSeconds": 1800,
    "maxOutputChars": 12000
  },
  "worktree": {
    "enabled": true,
    "base": "HEAD",
    "keep": true
  }
}
```

These are the defaults. No-progress detection fingerprints the repository and verification results. Failed checks, agent diagnostics, and Git status become feedback for the next iteration.

Use `--no-worktree` only when you explicitly want the current checkout modified. It disables automatic delivery.

### Delivery

Delivery runs only after all verification passes:

```json
{ "delivery": { "mode": "none" } }
```

Supported modes:

- `none` — default; leave changes uncommitted in the worktree.
- `commit` — create a commit using `delivery.commitMessage`.
- `pr` — commit and push a unique branch, use the configured agent to author the PR, then monitor it until merge-ready.

Pull-request configuration:

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

Git and GitHub authentication must already be configured. The implementation provider authors the title and description from the verified diff, monitors checks and review feedback with `gh`, and may prepare local fixes. Loops re-runs every verification gate before committing and pushing those fixes. Monitoring is bounded by `limits.maxIterations` and `limits.timeoutSeconds`.

A PR is complete when checks pass, it has no conflicts or requested changes, required reviews are satisfied, and the delivery agent reports no actionable feedback. Loops never merges the PR. Delivery failures preserve the worktree, commit, branch, PR, and evidence for recovery. Automatic delivery requires an isolated worktree.

### Compatibility

Omitted agent, limit, worktree, session, and delivery fields use the defaults above. The default agent is Codex with `workspace-write` access.

Legacy task files using a top-level `codex` block or command gates without `"type": "command"` remain valid.

## Commands

```text
loops init [task-file] [--interactive | --defaults]
loops validate <task-file>
loops run <task-file> [--dry-run] [--no-worktree] [--quiet]
loops resume <run-id> [--task <task-file>] [--repo <path>] [--quiet]
loops watch <run-id> [--repo <path>] [--quiet]
loops list [--repo <path>]
loops inspect <run-id> [--repo <path>]
loops cleanup <run-id> [--repo <path>]
loops wizard
loops help
```

Bare `loops` opens the interactive wizard in a terminal. Existing task files are never overwritten.

Pressing Ctrl-C cancels the active process group, records `cancelled`, and preserves the worktree. A per-run lock prevents concurrent execution of the same run.

Terminal statuses are:

```text
success  no_progress  max_iterations  failed_to_start
cancelled  provider_error  delivery_failed  timeout
```

## Headless and agent usage

Use explicit commands:

```sh
loops validate tasks/change.task.json
loops run tasks/change.task.json --dry-run
loops run tasks/change.task.json --quiet
loops inspect <run-id>
```

With non-TTY stdout, `run` and `resume` print the final state as JSON. Progress and errors use stderr; `--quiet` suppresses progress.

When another agent operates Loops:

- Do not use bare `loops`, `loops wizard`, or interactive `loops init`.
- Use a task file; there is no `--json` flag or task-from-stdin interface.
- Treat only `success` as completion.
- Do not enable commit or PR delivery without authorization.
- Preserve successful changes before cleanup.

See [`skills/operate-loops/SKILL.md`](skills/operate-loops/SKILL.md) for the reusable workflow.

## Storage and cleanup

```text
.loop/
├── runs/<run-id>/
│   ├── state.json
│   ├── events.jsonl
│   ├── feedback.md
│   └── final-report.json
└── worktrees/<run-id>/
```

State writes are atomic. Resume interrupted non-terminal runs with `loops resume <run-id>`.

`loops cleanup <run-id>` force-removes only that worktree and keeps its logs. Inspect and preserve useful changes first. With delivery mode `none`, commit in the worktree and cherry-pick the commit, or copy the changes manually.

## Security

Agents and verification commands run with your local permissions. Command gates use the platform shell. PR delivery pushes with your Git remote and existing `gh` credentials.

Treat task files, repositories, scripts, agent configuration, extensions, PR comments, and CI output as untrusted input. Agent-monitored PR delivery reads remote feedback through `gh`; review who can comment on the repository. Use a disposable container or VM for untrusted work and expose only required files, network access, and credentials.

Loops does not manage provider authentication or include authentication files and the full environment in prompts and reports.

Override executable paths when needed:

```text
LOOPS_CODEX_PATH
LOOPS_OPENCODE_PATH
LOOPS_CLAUDE_PATH
LOOPS_PI_PATH
LOOPS_CURSOR_PATH
LOOPS_GH_PATH
```

## Development

```sh
npm install
npm run check
npm test
```

Tests use temporary Git repositories and fake agents. They require no model calls or network access.
