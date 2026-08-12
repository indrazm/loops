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

export function parsePiEvents(stdout) {
  const events = [];
  let sessionId;
  let finalMessage;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === "session" && typeof event.id === "string") sessionId = event.id;

      const directMessage = messageText(event.message);
      if (directMessage) finalMessage = directMessage;

      if (event.type === "agent_end" && Array.isArray(event.messages)) {
        for (const message of event.messages) {
          const text = messageText(message);
          if (text) finalMessage = text;
        }
      }
    } catch {
      // Preserve non-JSON output in stdout for diagnostics.
    }
  }
  return { events, sessionId, finalMessage };
}

export async function runPi({
  cwd,
  prompt,
  sandbox,
  model,
  sessionId,
  extraArgs = [],
  timeoutSeconds,
  signal,
  executable = process.env.LOOPS_PI_PATH || process.env.CODEX_LOOP_PI_PATH || "pi",
}) {
  const args = ["--mode", "json"];
  if (model) args.push("--model", model);
  if (sessionId) args.push("--session", sessionId);
  args.push(...extraArgs);
  if (sandbox === "read-only") args.push("--tools", "read,grep,find,ls");
  args.push(prompt);

  const result = await runProcess(executable, args, { cwd, timeoutSeconds, signal });
  const parsed = parsePiEvents(result.stdout);
  return {
    provider: "pi",
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
