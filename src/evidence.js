import { truncate } from "./util.js";

export function buildPrompt({ task, iteration, feedback }) {
  const parts = [
    "You are working inside an isolated Git worktree. Inspect the current repository state before editing.",
    `Overall goal:\n${task.goal}`,
    `Iteration: ${iteration} of ${task.limits.maxIterations}`,
  ];
  if (feedback) parts.push(`External verification from the previous iteration:\n${feedback}`);
  parts.push("Implement the goal and fix any failures. Do not merely describe them. Run relevant checks before finishing.");
  return parts.join("\n\n");
}

export function buildFeedback({ iteration, agent, codex, verification, gitStatus, maxOutputChars }) {
  const harness = agent ?? codex;
  const failed = verification.checks.filter((check) => !check.passed);
  const lines = [
    `# Iteration ${iteration} feedback`,
    "",
    "## Codex process",
    "",
    `- Provider: ${harness.provider ?? "codex"}`,
    `- Exit code: ${harness.exitCode}`,
    `- Timed out: ${harness.timedOut}`,
  ];
  if (harness.signal) lines.push(`- Signal: ${harness.signal}`);
  if (harness.processError) lines.push(`- Process error: ${harness.processError}`);
  if (harness.finalMessage) lines.push("", "### Final agent message", "", truncate(harness.finalMessage, maxOutputChars));
  lines.push("", "## Git status", "", "```text", truncate(gitStatus || "(clean)", maxOutputChars), "```");
  lines.push("", "## Failed verification", "");
  if (!failed.length) lines.push("No verification gate failed; the Codex process itself did not complete successfully.");
  for (const check of failed) {
    const descriptor = check.type === "agent"
      ? `Agent harness: \`${check.provider}\`\nCriterion: ${check.prompt}`
      : `Command: \`${check.command.replaceAll("`", "\\`")}\``;
    lines.push(
      `### ${check.name}`,
      "",
      descriptor,
      `Exit code: ${check.exitCode}${check.timedOut ? " (timed out)" : ""}`,
      "",
      "```text",
      truncate(check.output || check.processError || "(no output)", maxOutputChars),
      "```",
      "",
    );
  }
  lines.push("Inspect the current repository state and fix these failures. Do not merely explain them.");
  return `${lines.join("\n")}\n`;
}

export function verificationFingerprintSummary(verification) {
  return verification.checks.map((check) => ({
    name: check.name,
    type: check.type,
    provider: check.provider,
    passed: check.passed,
    exitCode: check.exitCode,
    timedOut: check.timedOut,
  }));
}

export function evaluateStop({ passed, timedOut, noProgress, iteration, limits }) {
  if (passed) return "success";
  if (timedOut) return "timeout";
  if (noProgress >= limits.maxNoProgress) return "no_progress";
  if (iteration >= limits.maxIterations) return "max_iterations";
  return null;
}
