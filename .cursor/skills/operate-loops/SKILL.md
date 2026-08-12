---
name: operate-loops
description: Operates Loops headlessly to run bounded, externally verified coding-agent tasks in isolated Git worktrees. Use when asked to create, validate, preview, run, resume, watch, inspect, list, or clean up a Loops task or run, or when working with Loops task JSON files and `.loop` run state.
---

# Operate Loops

Use Loops as a non-interactive execution engine. Preserve its existing CLI and task-file contracts.

## Operating rules

- Run explicit subcommands. Do not invoke bare `loops`, `loops wizard`, or `loops init --interactive`.
- Do not invent flags or interfaces. In particular, Loops has no `--json` flag and does not accept a task from stdin.
- Run Loops inside the Git repository it should change.
- Prefer the default isolated worktree. Use `--no-worktree` only when the user explicitly wants the current checkout modified.
- Treat a run as complete only when its persisted status is `success`.
- Do not treat the implementation agent's final message as proof of completion; configured verification gates control success.
- Do not change delivery to `commit` or `pr` unless the user authorized that outcome.
- Never clean up a successful worktree until its changes have been preserved or delivered.

## Create or select a task

Reuse an existing task file when one matches the requested work. Do not overwrite existing task files.

For a new task, inspect the repository first so the goal and verification commands are concrete. Write a JSON file using the existing task format. The smallest useful task is:

```json
{
  "name": "fix-authentication",
  "goal": "Fix the authentication failure and add regression coverage.",
  "verification": [
    {
      "type": "command",
      "name": "tests",
      "command": "npm test"
    }
  ]
}
```

Choose verification commands that actually exist in the repository. Prefer at least one deterministic command gate for tests, linting, type checking, builds, or schemas. Add an agent gate only for requirements that need semantic judgment:

```json
{
  "type": "agent",
  "name": "implementation-review",
  "provider": "codex",
  "prompt": "Verify the implementation satisfies the goal and identify correctness or security issues."
}
```

Omitted optional fields receive the defaults implemented by Loops. Add provider, limits, session, worktree, or delivery configuration only when the task requires non-default behavior.

If a starter file is useful, generate it without prompts:

```sh
loops init tasks/change.task.json --defaults
```

Then edit the generated file before validation.

## Validate and preview

Always validate a new or changed task:

```sh
loops validate tasks/change.task.json
```

Use a dry run when repository discovery, worktree base resolution, or the effective configuration should be checked before execution:

```sh
loops run tasks/change.task.json --dry-run
```

A dry run does not create `.loop`, a run, or a worktree.

## Execute

Run without the interactive dashboard:

```sh
loops run tasks/change.task.json --quiet
```

Use a non-TTY subprocess when possible. With non-TTY stdout, the final persisted run state is emitted as JSON. `--quiet` suppresses progress output; it does not alter execution.

Allow the command to finish unless the user asks to cancel. Loops already bounds execution with its configured iteration, no-progress, and timeout limits.

Record the returned run ID. If output is unavailable or truncated, recover it with:

```sh
loops list
```

## Interpret the result

The terminal statuses are:

- `success`
- `no_progress`
- `max_iterations`
- `failed_to_start`
- `cancelled`
- `provider_error`
- `delivery_failed`
- `timeout`

Only `success` means the implementation agent exited successfully and every verification gate passed. For any other status, inspect the run before reporting the outcome:

```sh
loops inspect <run-id>
```

Use the state, history, verification evidence, error, worktree path, and delivery fields to explain the result. Full artifacts are stored under `.loop/runs/<run-id>/`.

## Resume or monitor

Resume a non-terminal run left incomplete by an interruption or process failure:

```sh
loops resume <run-id> --quiet
```

Do not attempt to resume a terminal run. To monitor a run started by another process:

```sh
loops watch <run-id> --quiet
```

Use `--repo <path>` with `list`, `inspect`, `resume`, `watch`, or `cleanup` only when operating outside the target repository.

## Preserve and clean up

Check `delivery.mode` and the final delivery state:

- `none`: changes remain in `.loop/worktrees/<run-id>/`; inspect and preserve them manually.
- `commit`: report the created commit hash.
- `pr`: report the created branch and pull-request URL.

For `delivery.mode: "none"`, inspect the worktree before deciding what to do:

```sh
cd .loop/worktrees/<run-id>
git status
git diff
```

Cleanup force-removes the selected worktree while preserving logs. Invoke it only with the exact intended run ID and only after the changes are no longer needed there:

```sh
loops cleanup <run-id>
```

## Safety

- Verification commands execute through the shell with local permissions. Treat task files as executable code.
- Pull-request delivery pushes to the configured remote through the existing `gh` credentials.
- Confirm repository identity, task path, worktree path, run ID, and delivery mode before consequential actions.
- Preserve diagnostic evidence when a run fails; cleanup is not part of failure handling unless the user requests it.
