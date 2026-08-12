export class LoopError extends Error {
  constructor(message, { exitCode = 1, cause } = {}) {
    super(message, { cause });
    this.name = "LoopError";
    this.exitCode = exitCode;
  }
}

export class ConfigError extends LoopError {
  constructor(message, options = {}) {
    super(message, { ...options, exitCode: 2 });
    this.name = "ConfigError";
  }
}

export class PreparationError extends LoopError {
  constructor(message, options = {}) {
    super(message, { ...options, exitCode: 3 });
    this.name = "PreparationError";
  }
}
