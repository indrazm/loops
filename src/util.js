import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const TERMINAL_STATUSES = new Set([
  "success",
  "no_progress",
  "max_iterations",
  "failed_to_start",
  "cancelled",
  "provider_error",
  "delivery_failed",
  "timeout",
]);

export function now() {
  return new Date().toISOString();
}

export function createRunId(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

export function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function atomicWriteJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function truncate(value, maximum) {
  const text = String(value ?? "");
  if (text.length <= maximum) return text;
  const omitted = text.length - maximum;
  return `${text.slice(0, maximum)}\n...[truncated ${omitted} characters]`;
}

export function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}
