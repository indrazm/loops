import { runProcess } from "./process.js";

function eventText(event) {
  if (typeof event.text === "string") return event.text;
  if (typeof event.part?.text === "string") return event.part.text;
  if (typeof event.properties?.text === "string") return event.properties.text;
  if (typeof event.data?.text === "string") return event.data.text;
  return undefined;
}

export function parseOpenCodeEvents(stdout) {
  const events = [];
  let sessionId;
  let finalMessage;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      events.push(event);
      sessionId =
        event.sessionID ??
        event.sessionId ??
        event.session_id ??
        event.part?.sessionID ??
        event.properties?.sessionID ??
        event.data?.sessionID ??
        sessionId;
      const text = eventText(event);
      if (text) finalMessage = text;
    } catch {
      // Preserve non-JSON output in stdout for diagnostics.
    }
  }
  return { events, sessionId, finalMessage };
}

function logValue(line, name) {
  const quoted = line.match(new RegExp(`${name}="([^"]*)"`));
  if (quoted) return quoted[1];
  return line.match(new RegExp(`${name}=([^\\s]+)`))?.[1];
}

export function parseOpenCodeDiagnostic(line) {
  if (!line.includes("level=ERROR") || !line.includes('message="stream error"')) return null;
  const error = logValue(line, "error.error") ?? "provider stream failed";
  const provider = logValue(line, "providerID");
  const model = logValue(line, "modelID");
  const primary = logValue(line, "small") !== "true";
  return {
    type: "provider.error",
    provider,
    model,
    primary,
    error: error.replace(/^AI_[A-Za-z]+Error:\s*/, "") || "request failed",
  };
}

export async function runOpenCode({
  cwd,
  prompt,
  sandbox,
  model,
  sessionId,
  extraArgs = [],
  timeoutSeconds,
  signal,
  onActivity = () => {},
  maxProviderErrors = 3,
  executable = process.env.LOOPS_OPENCODE_PATH || process.env.CODEX_LOOP_OPENCODE_PATH || "opencode",
}) {
  // OpenCode resolves linked Git worktrees to their shared main project unless
  // the session directory is explicit. Pinning --dir keeps every tool and edit
  // inside the isolated run worktree instead of the user's original checkout.
  const args = ["run", "--dir", cwd, "--format", "json", "--print-logs", "--log-level", "WARN"];
  if (model) args.push("--model", model);
  if (sessionId) args.push("--session", sessionId);
  if (sandbox === "read-only") {
    args.push("--agent", "plan");
  } else {
    // OpenCode does not expose a Codex-style filesystem sandbox. `--auto`
    // makes non-interactive build runs usable inside our isolated worktree.
    args.push("--auto");
  }
  args.push(...extraArgs, prompt);

  let stderrBuffer = "";
  let providerErrors = 0;
  let lastProviderError;
  const result = await runProcess(executable, args, {
    cwd,
    timeoutSeconds,
    signal,
    onStderr(chunk) {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? "";
      let terminationReason;
      for (const line of lines) {
        const diagnostic = parseOpenCodeDiagnostic(line);
        if (!diagnostic?.primary) continue;
        providerErrors += 1;
        lastProviderError = diagnostic;
        const retrying = providerErrors < maxProviderErrors;
        onActivity({
          ...diagnostic,
          count: providerErrors,
          maximum: maxProviderErrors,
          retrying,
          message: retrying
            ? `Gateway request failed; OpenCode is retrying (${providerErrors}/${maxProviderErrors})`
            : `OpenCode provider failed ${providerErrors} times`,
        });
        if (!retrying) {
          const target = [diagnostic.provider, diagnostic.model].filter(Boolean).join("/");
          terminationReason = `OpenCode provider${target ? ` ${target}` : ""} failed ${providerErrors} times: ${diagnostic.error}`;
        }
      }
      return terminationReason;
    },
  });
  const parsed = parseOpenCodeEvents(result.stdout);
  return {
    provider: "opencode",
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    processError: result.processError,
    providerError: !result.cancelled && !result.timedOut ? result.terminationReason : undefined,
    lastProviderError,
    providerErrors,
    sessionId: parsed.sessionId,
    finalMessage: parsed.finalMessage,
    events: parsed.events,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  };
}
