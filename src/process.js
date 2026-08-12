import { spawn } from "node:child_process";

function appendBounded(current, chunk, maximum) {
  if (current.length >= maximum) return current;
  return current + chunk.slice(0, maximum - current.length);
}

export function runProcess(
  command,
  args,
  {
    cwd,
    env = process.env,
    timeoutSeconds,
    shell = false,
    maxCaptureChars = 2_000_000,
    combineOutput = false,
    signal,
    onStdout,
    onStderr,
  } = {},
) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let output = "";
    let processError;
    let timedOut = false;
    let cancelled = false;
    let terminationReason;
    let settled = false;
    let timer;
    let forceTimer;
    let child;
    const childEnv = { ...env };
    // Node's test runner uses this private variable to reroute child stdio over
    // its test protocol. Agent CLIs and verification commands are independent
    // subprocesses and must retain ordinary stdout/stderr semantics.
    delete childEnv.NODE_TEST_CONTEXT;

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      optionsSignal?.removeEventListener("abort", abort);
      resolve({
        exitCode: Number.isInteger(exitCode) ? exitCode : 1,
        signal: signal ?? undefined,
        timedOut,
        cancelled,
        terminationReason,
        processError: processError?.message,
        stdout,
        stderr,
        output: combineOutput ? output : `${stdout}${stderr}`,
        durationMs: Date.now() - startedAt,
      });
    };

    const kill = (killSignal) => {
      if (!child?.pid) return;
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, killSignal);
          return;
        } catch {
          // Fall back to the direct child if its process group is already gone.
        }
      }
      child.kill(killSignal);
    };

    const terminate = (reason) => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      kill("SIGTERM");
      forceTimer = setTimeout(() => {
        if (!settled) kill("SIGKILL");
      }, 1000);
      forceTimer.unref();
    };

    const inspectOutput = (callback, text) => {
      if (!callback) return;
      try {
        const reason = callback(text);
        if (typeof reason === "string" && reason) terminate(reason);
      } catch (error) {
        processError = error;
        terminate(`output handler failed: ${error.message}`);
      }
    };

    const optionsSignal = signal;
    const abort = () => {
      cancelled = true;
      terminate("cancelled by user");
    };

    try {
      child = spawn(command, args, {
        cwd,
        env: childEnv,
        shell,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      processError = error;
      finish(1);
      return;
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout = appendBounded(stdout, text, maxCaptureChars);
      if (combineOutput) output = appendBounded(output, text, maxCaptureChars);
      inspectOutput(onStdout, text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr = appendBounded(stderr, text, maxCaptureChars);
      if (combineOutput) output = appendBounded(output, text, maxCaptureChars);
      inspectOutput(onStderr, text);
    });
    child.on("error", (error) => {
      processError = error;
    });
    child.on("close", finish);

    optionsSignal?.addEventListener("abort", abort, { once: true });
    if (optionsSignal?.aborted) abort();

    timer = setTimeout(() => {
      timedOut = true;
      terminate(`process timed out after ${timeoutSeconds} seconds`);
    }, timeoutSeconds * 1000);
    timer.unref();
  });
}
