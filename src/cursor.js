import { runProcess } from "./process.js";

function messageText(message) {
  if (message?.role !== "assistant") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return (
    message.content
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n") || undefined
  );
}

export function parseCursorEvents(stdout) {
  const events = [];
  let sessionId;
  let finalMessage;
  let providerError;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      events.push(event);
      sessionId = event.session_id ?? event.sessionId ?? sessionId;

      const text = messageText(event.message);
      if (text) finalMessage = text;
      if (event.type === "result" && typeof event.result === "string") finalMessage = event.result;
      if (event.type === "result" && (event.is_error === true || event.subtype === "error")) {
        providerError =
          (typeof event.result === "string" && event.result) ||
          (typeof event.error === "string" && event.error) ||
          (typeof event.message === "string" && event.message) ||
          "Cursor Agent reported an error";
      }
    } catch {
      // Preserve non-JSON output in stdout for diagnostics.
    }
  }
  return { events, sessionId, finalMessage, providerError };
}

export async function runCursor({
  cwd,
  prompt,
  sandbox,
  model,
  sessionId,
  extraArgs = [],
  timeoutSeconds,
  signal,
  executable = process.env.LOOPS_CURSOR_PATH || process.env.CODEX_LOOP_CURSOR_PATH || "cursor-agent",
}) {
  const args = ["--print", "--output-format", "stream-json", "--workspace", cwd, "--trust"];
  if (model) args.push("--model", model);
  if (sessionId) args.push("--resume", sessionId);
  if (sandbox === "read-only") {
    args.push("--mode", "plan", "--sandbox", "enabled");
  } else if (sandbox === "danger-full-access") {
    args.push("--force", "--sandbox", "disabled");
  } else {
    args.push("--force", "--sandbox", "enabled");
  }
  args.push(...extraArgs, prompt);

  const result = await runProcess(executable, args, { cwd, timeoutSeconds, signal });
  const parsed = parseCursorEvents(result.stdout);
  return {
    provider: "cursor",
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    processError: result.processError,
    providerError: !result.cancelled && !result.timedOut ? parsed.providerError : undefined,
    sessionId: parsed.sessionId,
    finalMessage: parsed.finalMessage,
    events: parsed.events,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}
