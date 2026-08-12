import { runProcess } from "./process.js";

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return (
    content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n") || undefined
  );
}

export function parseClaudeOutput(stdout) {
  const events = [];
  let sessionId;
  let finalMessage;
  const trimmed = stdout.trim();
  const sources = trimmed.startsWith("{") && trimmed.endsWith("}") ? [trimmed] : stdout.split(/\r?\n/).filter(Boolean);
  for (const source of sources) {
    try {
      const event = JSON.parse(source);
      events.push(event);
      sessionId = event.session_id ?? event.sessionId ?? sessionId;
      finalMessage =
        event.result ??
        (event.structured_output ? JSON.stringify(event.structured_output) : undefined) ??
        contentText(event.message?.content) ??
        contentText(event.content) ??
        finalMessage;
    } catch {
      // Preserve malformed/non-JSON output in stdout for diagnostics.
    }
  }
  return { events, sessionId, finalMessage };
}

export async function runClaude({
  cwd,
  prompt,
  sandbox,
  model,
  sessionId,
  extraArgs = [],
  timeoutSeconds,
  signal,
  executable = process.env.LOOPS_CLAUDE_PATH || process.env.CODEX_LOOP_CLAUDE_PATH || "claude",
}) {
  const args = ["-p", "--output-format", "json"];
  if (sandbox === "danger-full-access") {
    args.push("--dangerously-skip-permissions");
  } else {
    args.push("--permission-mode", sandbox === "read-only" ? "plan" : "acceptEdits");
  }
  if (model) args.push("--model", model);
  if (sessionId) args.push("--resume", sessionId);
  args.push(...extraArgs, prompt);

  const result = await runProcess(executable, args, { cwd, timeoutSeconds, signal });
  const parsed = parseClaudeOutput(result.stdout);
  return {
    provider: "claude",
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    processError: result.processError,
    sessionId: parsed.sessionId,
    finalMessage: parsed.finalMessage,
    events: parsed.events,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}
