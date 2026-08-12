import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { PreparationError } from "./errors.js";
import { runProcess } from "./process.js";
import { hash } from "./util.js";

async function git(args, cwd, timeoutSeconds = 60) {
  return runProcess("git", args, { cwd, timeoutSeconds });
}

export async function resolveRepoRoot(cwd = process.cwd()) {
  const result = await git(["rev-parse", "--show-toplevel"], cwd);
  if (result.exitCode !== 0) {
    throw new PreparationError(
      `Cannot resolve a Git repository from ${path.resolve(cwd)}: ${(result.stderr || result.processError || "git rev-parse failed").trim()}`,
    );
  }
  return path.resolve(result.stdout.trim());
}

export async function verifyGitReference(repoRoot, reference) {
  const result = await git(["rev-parse", "--verify", "--quiet", `${reference}^{commit}`], repoRoot);
  if (result.exitCode !== 0) {
    throw new PreparationError(
      `Worktree base is not a valid commit: ${reference}. Create an initial commit or choose another worktree.base.`,
    );
  }
  return result.stdout.trim();
}

export async function createWorktree({ repoRoot, worktreePath, base }) {
  const result = await git(["worktree", "add", "--detach", worktreePath, base], repoRoot);
  if (result.exitCode !== 0) {
    throw new PreparationError(
      `Could not create worktree at ${worktreePath}: ${(result.stderr || result.processError || "git worktree add failed").trim()}`,
    );
  }
  return { path: worktreePath };
}

export async function removeWorktree({ repoRoot, worktreePath }) {
  // Cleanup is explicit and the entire purpose of a run worktree is to contain
  // uncommitted output, so Git's force flag is required for successful runs.
  const result = await git(["worktree", "remove", "--force", worktreePath], repoRoot);
  if (result.exitCode !== 0) {
    throw new PreparationError(
      `Could not remove worktree ${worktreePath}: ${(result.stderr || result.processError || "git worktree remove failed").trim()}`,
    );
  }
  await git(["worktree", "prune"], repoRoot);
}

export async function pathExists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function gitStatus(cwd) {
  const result = await git(["status", "--porcelain=v1", "--untracked-files=all"], cwd);
  return result.exitCode === 0 ? result.stdout : `git status failed: ${result.stderr || result.processError}`;
}

export async function repositoryFingerprint(cwd, verificationSummary) {
  const [diff, status, untracked] = await Promise.all([
    git(["diff", "--binary", "HEAD", "--"], cwd),
    git(["status", "--porcelain=v1", "--untracked-files=all"], cwd),
    git(["ls-files", "--others", "--exclude-standard", "-z"], cwd),
  ]);

  const untrackedEntries = [];
  for (const name of untracked.stdout.split("\0").filter(Boolean).sort()) {
    const absolute = path.resolve(cwd, name);
    if (!absolute.startsWith(`${path.resolve(cwd)}${path.sep}`)) continue;
    try {
      const contents = await readFile(absolute);
      untrackedEntries.push(`${name}\0${hash(contents)}`);
    } catch (error) {
      untrackedEntries.push(`${name}\0<unreadable:${error.code ?? error.message}>`);
    }
  }

  return hash(
    JSON.stringify({
      diff: diff.stdout,
      status: status.stdout,
      untracked: untrackedEntries,
      verification: verificationSummary,
    }),
  );
}
