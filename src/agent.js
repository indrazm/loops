import { runClaude } from "./claude.js";
import { runCodex } from "./codex.js";
import { ConfigError } from "./errors.js";
import { runOpenCode } from "./opencode.js";

const RUNNERS = {
  codex: runCodex,
  opencode: runOpenCode,
  claude: runClaude,
};

export function getAgentRunner(provider) {
  const runner = RUNNERS[provider];
  if (!runner) throw new ConfigError(`Unsupported agent provider: ${provider}`);
  return runner;
}

export async function runAgent(request) {
  return getAgentRunner(request.provider)(request);
}
