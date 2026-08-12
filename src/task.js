import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "./errors.js";

export const AGENT_PROVIDERS = Object.freeze(["codex", "opencode", "claude", "pi", "cursor"]);

export const DEFAULT_TASK = Object.freeze({
  limits: {
    maxIterations: 5,
    maxNoProgress: 2,
    timeoutSeconds: 1800,
    maxOutputChars: 12000,
  },
  agent: {
    provider: "codex",
    sandbox: "workspace-write",
    model: null,
    extraArgs: [],
  },
  sessionStrategy: "fresh",
  worktree: {
    enabled: true,
    base: "HEAD",
    keep: true,
  },
  delivery: {
    mode: "none",
    commitMessage: null,
    remote: "origin",
    base: "main",
    branchPrefix: "loops",
    title: null,
  },
});

const PROVIDERS = new Set(AGENT_PROVIDERS);
const SANDBOXES = new Set(["read-only", "workspace-write", "danger-full-access"]);
const STRATEGIES = new Set(["fresh", "resume"]);
const DELIVERY_MODES = new Set(["none", "commit", "pr"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value, field, errors) {
  if (!Number.isInteger(value) || value <= 0) errors.push(`${field} must be an integer greater than zero`);
}

function nonEmptyString(value, field, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${field} must be a non-empty string`);
    return false;
  }
  return true;
}

function validateAgentConfig(input, field, errors, { defaultProvider = "codex", allowSandbox = true } = {}) {
  if (input !== undefined && !object(input)) {
    errors.push(`${field} must be an object`);
    input = {};
  }
  const config = input ?? {};
  const provider = config.provider ?? defaultProvider;
  if (!PROVIDERS.has(provider)) errors.push(`${field}.provider must be one of: ${AGENT_PROVIDERS.join(", ")}`);
  const sandbox = config.sandbox ?? DEFAULT_TASK.agent.sandbox;
  if (allowSandbox && !SANDBOXES.has(sandbox))
    errors.push(`${field}.sandbox must be one of: ${[...SANDBOXES].join(", ")}`);
  if (config.model !== undefined && config.model !== null && !nonEmptyString(config.model, `${field}.model`, errors)) {
    // Error recorded by nonEmptyString.
  }
  if (
    config.extraArgs !== undefined &&
    (!Array.isArray(config.extraArgs) || config.extraArgs.some((arg) => typeof arg !== "string"))
  ) {
    errors.push(`${field}.extraArgs must be an array of strings`);
  }
  return {
    provider: PROVIDERS.has(provider) ? provider : defaultProvider,
    sandbox: allowSandbox ? sandbox : "read-only",
    model: typeof config.model === "string" && config.model.trim() ? config.model.trim() : null,
    extraArgs: Array.isArray(config.extraArgs) ? [...config.extraArgs] : [],
  };
}

function validateVerification(check, index, implementationProvider, errors) {
  const field = `verification[${index}]`;
  if (!object(check)) {
    errors.push(`${field} must be an object`);
    return null;
  }
  nonEmptyString(check.name, `${field}.name`, errors);
  const type = check.type ?? (check.command !== undefined ? "command" : "agent");
  if (type === "command") {
    nonEmptyString(check.command, `${field}.command`, errors);
    return {
      type: "command",
      name: typeof check.name === "string" ? check.name.trim() : "",
      command: typeof check.command === "string" ? check.command.trim() : "",
    };
  }
  if (type === "agent" || type === "harness") {
    nonEmptyString(check.prompt, `${field}.prompt`, errors);
    const config = validateAgentConfig(check, field, errors, {
      defaultProvider: implementationProvider,
      allowSandbox: false,
    });
    return {
      type: "agent",
      name: typeof check.name === "string" ? check.name.trim() : "",
      provider: config.provider,
      prompt: typeof check.prompt === "string" ? check.prompt.trim() : "",
      model: config.model,
      extraArgs: config.extraArgs,
    };
  }
  errors.push(`${field}.type must be command or agent`);
  return null;
}

export function validateTask(input) {
  if (!object(input)) throw new ConfigError("Task must be a JSON object");

  const errors = [];
  nonEmptyString(input.name, "name", errors);
  nonEmptyString(input.goal, "goal", errors);

  if (input.agent !== undefined && input.codex !== undefined) {
    errors.push("use either agent or the legacy codex configuration, not both");
  }
  const legacyCodex =
    input.agent === undefined && input.codex !== undefined ? { ...input.codex, provider: "codex" } : undefined;
  const agent = validateAgentConfig(input.agent ?? legacyCodex, input.agent !== undefined ? "agent" : "codex", errors);

  let verification = [];
  if (!Array.isArray(input.verification) || input.verification.length === 0) {
    errors.push("verification must contain at least one command or agent gate");
  } else {
    verification = input.verification
      .map((check, index) => validateVerification(check, index, agent.provider, errors))
      .filter(Boolean);
  }

  for (const section of ["limits", "worktree", "delivery"]) {
    if (input[section] !== undefined && !object(input[section])) errors.push(`${section} must be an object`);
  }

  const limits = object(input.limits) ? input.limits : {};
  positiveInteger(limits.maxIterations ?? DEFAULT_TASK.limits.maxIterations, "limits.maxIterations", errors);
  positiveInteger(limits.maxNoProgress ?? DEFAULT_TASK.limits.maxNoProgress, "limits.maxNoProgress", errors);
  positiveInteger(limits.timeoutSeconds ?? DEFAULT_TASK.limits.timeoutSeconds, "limits.timeoutSeconds", errors);
  positiveInteger(limits.maxOutputChars ?? DEFAULT_TASK.limits.maxOutputChars, "limits.maxOutputChars", errors);

  const strategy = input.sessionStrategy ?? DEFAULT_TASK.sessionStrategy;
  if (!STRATEGIES.has(strategy)) errors.push("sessionStrategy must be fresh or resume");

  const worktree = object(input.worktree) ? input.worktree : {};
  if (worktree.enabled !== undefined && typeof worktree.enabled !== "boolean")
    errors.push("worktree.enabled must be a boolean");
  if (worktree.keep !== undefined && typeof worktree.keep !== "boolean") errors.push("worktree.keep must be a boolean");
  if (worktree.base !== undefined) nonEmptyString(worktree.base, "worktree.base", errors);

  const delivery = object(input.delivery) ? input.delivery : {};
  const deliveryMode = delivery.mode ?? DEFAULT_TASK.delivery.mode;
  if (!DELIVERY_MODES.has(deliveryMode)) errors.push("delivery.mode must be none, commit, or pr");
  for (const field of ["commitMessage", "remote", "base", "branchPrefix", "title"]) {
    if (delivery[field] !== undefined && delivery[field] !== null) {
      nonEmptyString(delivery[field], `delivery.${field}`, errors);
    }
  }
  const worktreeEnabled = worktree.enabled ?? DEFAULT_TASK.worktree.enabled;
  if (deliveryMode !== "none" && !worktreeEnabled) {
    errors.push("automatic delivery requires worktree.enabled to be true");
  }

  if (errors.length) throw new ConfigError(`Invalid task:\n- ${errors.join("\n- ")}`);

  return {
    name: input.name.trim(),
    goal: input.goal.trim(),
    verification,
    limits: {
      maxIterations: limits.maxIterations ?? DEFAULT_TASK.limits.maxIterations,
      maxNoProgress: limits.maxNoProgress ?? DEFAULT_TASK.limits.maxNoProgress,
      timeoutSeconds: limits.timeoutSeconds ?? DEFAULT_TASK.limits.timeoutSeconds,
      maxOutputChars: limits.maxOutputChars ?? DEFAULT_TASK.limits.maxOutputChars,
    },
    agent,
    sessionStrategy: strategy,
    worktree: {
      enabled: worktreeEnabled,
      base: (worktree.base ?? DEFAULT_TASK.worktree.base).trim(),
      keep: worktree.keep ?? DEFAULT_TASK.worktree.keep,
    },
    delivery: {
      mode: DELIVERY_MODES.has(deliveryMode) ? deliveryMode : "none",
      commitMessage: deliveryMode === "none" ? null : delivery.commitMessage?.trim() || `loops: ${input.name.trim()}`,
      remote: delivery.remote?.trim() || DEFAULT_TASK.delivery.remote,
      base: delivery.base?.trim() || DEFAULT_TASK.delivery.base,
      branchPrefix: delivery.branchPrefix?.trim() || DEFAULT_TASK.delivery.branchPrefix,
      title: delivery.title?.trim() || input.name.trim(),
    },
  };
}

export async function loadTask(taskPath) {
  const absolutePath = path.resolve(taskPath);
  let source;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new ConfigError(`Cannot read task file ${absolutePath}: ${error.message}`, { cause: error });
  }

  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ConfigError(`Malformed JSON in ${absolutePath}: ${error.message}`, { cause: error });
  }
  return { path: absolutePath, task: validateTask(parsed) };
}

export const STARTER_TASK = {
  name: "implement-feature",
  goal: "Implement the feature described in the repository.",
  verification: [{ type: "command", name: "tests", command: "npm test" }],
  limits: {
    maxIterations: 5,
    maxNoProgress: 2,
    timeoutSeconds: 1800,
  },
  agent: {
    provider: "codex",
    sandbox: "workspace-write",
    model: null,
    extraArgs: [],
  },
  sessionStrategy: "fresh",
  worktree: {
    enabled: true,
    base: "HEAD",
    keep: true,
  },
  delivery: {
    mode: "none",
  },
};
