import { runProcess } from "./process.js";

export function parseCodexEvents(stdout) {
  const events = [];
  let threadId;
  let finalMessage;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      events.push(event);
      threadId = event.thread_id ?? event.threadId ?? event.session_id ?? threadId;
      if (event.type === "thread.started") threadId = event.thread_id ?? threadId;
      const item = event.item;
      if (item?.type === "agent_message" && typeof item.text === "string") finalMessage = item.text;
      if ((event.type === "agent_message" || event.type === "message") && typeof event.text === "string")
        finalMessage = event.text;
      if (typeof event.final_message === "string") finalMessage = event.final_message;
    } catch {
      // stderr carries diagnostics; non-JSON stdout is retained in the raw log.
    }
  }
  return { events, threadId, finalMessage };
}

export async function runCodex({
  cwd,
  prompt,
  sandbox,
  model,
  sessionId,
  extraArgs = [],
  timeoutSeconds,
  signal,
  executable = process.env.LOOPS_CODEX_PATH || process.env.CODEX_LOOP_CODEX_PATH || "codex",
}) {
  const args = ["exec"];
  // `sandbox` is an exec-level option and must precede the `resume` subcommand.
  args.push("--sandbox", sandbox);
  if (model) args.push("--model", model);
  if (sessionId) args.push("resume");
  args.push("--json");
  args.push(...extraArgs);
  if (sessionId) args.push(sessionId);
  args.push(prompt);

  const result = await runProcess(executable, args, { cwd, timeoutSeconds, signal });
  const parsed = parseCodexEvents(result.stdout);
  return {
    provider: "codex",
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    processError: result.processError,
    sessionId: parsed.threadId,
    threadId: parsed.threadId,
    finalMessage: parsed.finalMessage,
    events: parsed.events,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}
