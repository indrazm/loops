import { confirm, input, number, select } from "@inquirer/prompts";
import { validateTask } from "./task.js";

const providerChoices = [
  { name: "OpenAI Codex CLI", value: "codex" },
  { name: "OpenCode", value: "opencode" },
  { name: "Claude Code", value: "claude" },
  { name: "Pi", value: "pi" },
  { name: "Cursor Agent", value: "cursor" },
];

const required = (value) => (value.trim() ? true : "This value is required");
const positiveInteger = (value) =>
  Number.isInteger(value) && value > 0 ? true : "Enter a whole number greater than zero";

export async function createTaskInteractively(prompts = { confirm, input, number, select }) {
  const name = await prompts.input({ message: "Task name", default: "implement-feature", validate: required });
  const goal = await prompts.input({ message: "Implementation goal", validate: required });
  const provider = await prompts.select({ message: "Implementation agent", choices: providerChoices });
  const sandbox = await prompts.select({
    message: "Agent access level",
    choices: [
      { name: "Workspace write (recommended)", value: "workspace-write" },
      { name: "Read only", value: "read-only" },
      { name: "Danger: unrestricted access", value: "danger-full-access" },
    ],
  });
  const model = await prompts.input({ message: "Model override (leave blank for provider default)", default: "" });
  const sessionStrategy = await prompts.select({
    message: "Conversation strategy",
    choices: [
      { name: "Resume the same agent session", value: "resume" },
      { name: "Start fresh each iteration", value: "fresh" },
    ],
  });

  const verification = [];
  let another = true;
  while (another) {
    const type = await prompts.select({
      message: `Verification gate ${verification.length + 1}`,
      choices: [
        { name: "Shell command (deterministic)", value: "command" },
        { name: "Agent review (subjective)", value: "agent" },
      ],
    });
    const gateName = await prompts.input({
      message: "Gate name",
      default: type === "command" ? "tests" : "implementation-review",
      validate: required,
    });
    if (type === "command") {
      const command = await prompts.input({ message: "Verification command", default: "npm test", validate: required });
      verification.push({ type, name: gateName, command });
    } else {
      const reviewProvider = await prompts.select({
        message: "Review agent",
        choices: providerChoices,
        default: provider,
      });
      const reviewPrompt = await prompts.input({
        message: "What should the review agent verify?",
        default: "Verify the implementation fully satisfies the goal and identify any correctness or security issues.",
        validate: required,
      });
      verification.push({ type, name: gateName, provider: reviewProvider, prompt: reviewPrompt });
    }
    another = await prompts.confirm({ message: "Add another verification gate?", default: false });
  }

  const maxIterations = await prompts.number({
    message: "Maximum iterations",
    default: 5,
    min: 1,
    required: true,
    validate: positiveInteger,
  });
  const maxNoProgress = await prompts.number({
    message: "Repeated no-progress limit",
    default: 2,
    min: 1,
    required: true,
    validate: positiveInteger,
  });
  const timeoutSeconds = await prompts.number({
    message: "Process timeout in seconds",
    default: 1800,
    min: 1,
    required: true,
    validate: positiveInteger,
  });
  const worktreeEnabled = await prompts.confirm({ message: "Use an isolated Git worktree?", default: true });
  const base = worktreeEnabled
    ? await prompts.input({ message: "Worktree base", default: "HEAD", validate: required })
    : "HEAD";
  const deliveryMode = worktreeEnabled
    ? await prompts.select({
        message: "After all verification passes",
        choices: [
          { name: "Keep changes in the worktree", value: "none" },
          { name: "Create a Git commit automatically", value: "commit" },
          { name: "Create and monitor a GitHub pull request until merge-ready", value: "pr" },
        ],
      })
    : "none";
  let delivery = { mode: deliveryMode };
  if (deliveryMode !== "none") {
    const commitMessage = await prompts.input({
      message: "Commit message",
      default: `loops: ${name}`,
      validate: required,
    });
    delivery = { ...delivery, commitMessage };
  }
  if (deliveryMode === "pr") {
    const remote = await prompts.input({ message: "Git remote", default: "origin", validate: required });
    const pullRequestBase = await prompts.input({
      message: "Pull request base branch",
      default: "main",
      validate: required,
    });
    const branchPrefix = await prompts.input({ message: "Branch prefix", default: "loops", validate: required });
    const title = await prompts.input({ message: "Pull request title", default: name, validate: required });
    delivery = { ...delivery, remote, base: pullRequestBase, branchPrefix, title };
  }

  return validateTask({
    name,
    goal,
    verification,
    limits: { maxIterations, maxNoProgress, timeoutSeconds },
    agent: { provider, sandbox, model: model || null, extraArgs: [] },
    sessionStrategy,
    worktree: { enabled: worktreeEnabled, base, keep: true },
    delivery,
  });
}
