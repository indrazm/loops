import { clearScreenDown, cursorTo, moveCursor } from "node:readline";

const ACTIVE_PHASES = new Set([
  "preparing",
  "implementing",
  "verifying",
  "persisting",
  "retrying",
  "delivering",
  "cancelling",
]);
const SPINNER = ["◐", "◓", "◑", "◒"];

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function phaseLabel(phase) {
  return String(phase ?? "preparing")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function checkIcon(status, spinner) {
  if (status === "passed") return "✓";
  if (status === "failed") return "✗";
  if (status === "running") return spinner;
  return "○";
}

export function formatStatus(snapshot, { at = Date.now(), spinner = "◐" } = {}) {
  const activity = snapshot.activity ?? {};
  const startedAt = Date.parse(snapshot.startedAt ?? activity.startedAt ?? new Date(at).toISOString());
  const phaseStartedAt = Date.parse(activity.startedAt ?? snapshot.startedAt ?? new Date(at).toISOString());
  const active = ACTIVE_PHASES.has(activity.phase);
  const phaseIcon = active ? spinner : activity.phase === "success" ? "✓" : "■";
  const lines = [
    `Loops${snapshot.id ? ` • ${snapshot.id}` : ""}`,
    `Agent: ${activity.provider ?? snapshot.provider ?? "waiting"}    Elapsed: ${formatDuration(at - startedAt)}`,
    `Iteration: ${activity.iteration ?? snapshot.iteration ?? 0} / ${activity.maxIterations ?? snapshot.maxIterations ?? "?"}`,
    `Status: ${phaseIcon} ${phaseLabel(activity.phase)}${active ? `    Phase: ${formatDuration(at - phaseStartedAt)}` : ""}`,
    `Current: ${activity.message ?? "Preparing run"}`,
  ];
  if (activity.phase === "implementing" && activity.lastProviderActivityAt) {
    lines.push(`Provider activity: ${formatDuration(at - Date.parse(activity.lastProviderActivityAt))} ago`);
  }
  if (activity.checks?.length) {
    lines.push("Verification:");
    for (const check of activity.checks) {
      const detail = check.type === "agent" && check.provider ? ` (${check.provider})` : "";
      const duration =
        check.status === "running" && check.startedAt
          ? ` — ${formatDuration(at - Date.parse(check.startedAt))}`
          : check.durationMs !== undefined
            ? ` — ${formatDuration(check.durationMs)}`
            : "";
      lines.push(`  ${checkIcon(check.status, spinner)} ${check.name}${detail}${duration}`);
    }
  }
  return lines;
}

export function snapshotFromState(state) {
  return {
    id: state.id,
    task: state.task,
    startedAt: state.startedAt,
    iteration: state.iteration,
    maxIterations: state.taskConfig?.limits?.maxIterations,
    provider: state.taskConfig?.agent?.provider,
    activity: structuredClone(
      state.activity ?? {
        phase: state.status,
        message: state.status,
        iteration: state.iteration,
      },
    ),
  };
}

export class LiveStatus {
  constructor({ stream = process.stderr, quiet = false, tty = stream.isTTY } = {}) {
    this.stream = stream;
    this.quiet = quiet;
    this.tty = Boolean(tty);
    this.snapshot = null;
    this.renderedLines = 0;
    this.frame = 0;
    this.lastTransition = null;
  }

  start(snapshot) {
    if (this.quiet) return;
    this.snapshot = structuredClone(snapshot);
    this.render();
    if (this.tty) {
      this.timer = setInterval(() => this.render(), 250);
      this.timer.unref();
    }
  }

  startState(state) {
    this.start(snapshotFromState(state));
  }

  update(event) {
    if (this.quiet) return;
    if (event.type === "activity.updated") {
      this.snapshot = {
        ...(this.snapshot ?? {}),
        id: event.runId ?? this.snapshot?.id,
        task: event.task ?? this.snapshot?.task,
        activity: structuredClone(event.activity),
      };
    } else if (event.type === "iteration.completed" && this.snapshot) {
      this.snapshot.lastResult = event.passed ? "passed" : `failed; no progress ${event.noProgress}`;
    }
    this.render();
  }

  setState(state) {
    if (this.quiet) return;
    this.snapshot = snapshotFromState(state);
    this.render();
  }

  render() {
    if (this.quiet || !this.snapshot) return;
    const spinner = SPINNER[this.frame % SPINNER.length];
    this.frame += 1;
    const maximumWidth = Math.max(40, (this.stream.columns ?? 100) - 1);
    const lines = formatStatus(this.snapshot, { spinner }).map((line) => line.slice(0, maximumWidth));
    if (!this.tty) {
      const activity = this.snapshot.activity ?? {};
      const transition = `${activity.phase}:${activity.message}`;
      if (transition !== this.lastTransition) {
        this.stream.write(
          `[${this.snapshot.id ?? "loops"}] ${phaseLabel(activity.phase)}: ${activity.message ?? ""}\n`,
        );
        this.lastTransition = transition;
      }
      return;
    }
    if (this.renderedLines > 0) {
      moveCursor(this.stream, 0, -this.renderedLines);
      cursorTo(this.stream, 0);
      clearScreenDown(this.stream);
    }
    this.stream.write(`${lines.join("\n")}\n`);
    this.renderedLines = lines.length;
  }

  stop(state) {
    clearInterval(this.timer);
    if (!state || this.quiet) return;
    const next = snapshotFromState(state);
    if (JSON.stringify(next) !== JSON.stringify(this.snapshot)) {
      this.snapshot = next;
      this.render();
    }
  }
}
