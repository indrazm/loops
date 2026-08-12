import { runAgent } from "./agent.js";
import { runProcess } from "./process.js";
import { truncate } from "./util.js";

export function parseAgentVerdict(message) {
  if (typeof message !== "string" || !message.trim()) return null;
  const candidates = [message.trim()];
  for (const match of message.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  candidates.push(
    ...message
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{") && line.endsWith("}")),
  );
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(message.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const verdict = JSON.parse(candidate);
      if (typeof verdict.passed !== "boolean" || typeof verdict.summary !== "string") continue;
      return {
        passed: verdict.passed,
        summary: verdict.summary,
        evidence: Array.isArray(verdict.evidence) ? verdict.evidence.filter((item) => typeof item === "string") : [],
      };
    } catch {
      // Try the next possible JSON fragment.
    }
  }
  return null;
}

export function buildAgentVerificationPrompt(check, goal) {
  return [
    "You are an independent implementation verification harness.",
    "Inspect the repository in read-only mode. Do not edit, create, or delete files.",
    `Overall implementation goal:\n${goal}`,
    `Verification criterion:\n${check.prompt}`,
    "Return exactly one JSON object as your final response with this shape:",
    '{"passed":true,"summary":"concise conclusion","evidence":["specific file, behavior, or finding"]}',
    "Set passed to false if the evidence is insufficient, the implementation is incomplete, or the criterion is not met.",
  ].join("\n\n");
}

async function runCommandCheck({ cwd, check, timeoutSeconds, maxOutputChars, signal }) {
  const result = await runProcess(check.command, [], {
    cwd,
    timeoutSeconds,
    shell: true,
    combineOutput: true,
    maxCaptureChars: maxOutputChars,
    signal,
  });
  return {
    type: "command",
    name: check.name,
    command: check.command,
    passed: result.exitCode === 0 && !result.timedOut && !result.processError,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    processError: result.processError,
    output: result.output,
    durationMs: result.durationMs,
  };
}

async function runAgentCheck({ cwd, check, goal, timeoutSeconds, maxOutputChars, agentRunner, signal, onActivity }) {
  const prompt = buildAgentVerificationPrompt(check, goal);
  const result = await agentRunner({
    provider: check.provider,
    cwd,
    prompt,
    sandbox: "read-only",
    model: check.model,
    extraArgs: check.extraArgs,
    timeoutSeconds,
    signal,
    onActivity,
  });
  const verdict = parseAgentVerdict(result.finalMessage);
  const processPassed = result.exitCode === 0 && !result.timedOut && !result.processError;
  const diagnostics = [result.finalMessage, result.stderr].filter(Boolean).join("\n");
  return {
    type: "agent",
    name: check.name,
    provider: check.provider,
    prompt: check.prompt,
    passed: processPassed && verdict?.passed === true,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    processError: result.processError,
    providerError: result.providerError,
    verdict,
    output: truncate(diagnostics || result.stdout || "(no agent output)", maxOutputChars),
    durationMs: result.durationMs,
  };
}

export async function runVerification({
  cwd,
  checks,
  goal,
  timeoutSeconds,
  maxOutputChars,
  signal,
  agentRunner = runAgent,
  onCheckStarted = async () => {},
  onCheckCompleted = async () => {},
  onCheckActivity = () => {},
}) {
  const results = [];
  for (const [index, check] of checks.entries()) {
    await onCheckStarted(check, index);
    const result =
      check.type === "agent"
        ? await runAgentCheck({
            cwd,
            check,
            goal,
            timeoutSeconds,
            maxOutputChars,
            agentRunner,
            signal,
            onActivity: (diagnostic) => onCheckActivity(check, index, diagnostic),
          })
        : await runCommandCheck({ cwd, check, timeoutSeconds, maxOutputChars, signal });
    results.push(result);
    await onCheckCompleted(result, index);
    if (result.cancelled || signal?.aborted) break;
  }
  const passed = results.every((check) => check.passed);
  return {
    passed,
    cancelled: results.some((check) => check.cancelled) || signal?.aborted === true,
    providerError: results.find((check) => check.providerError),
    checks: results,
    summary: results
      .map((check) => {
        const label = check.type === "agent" ? `${check.name} (${check.provider})` : check.name;
        return `${label}: ${check.passed ? "passed" : `failed (exit ${check.exitCode}${check.timedOut ? ", timed out" : ""})`}`;
      })
      .join("\n"),
  };
}
