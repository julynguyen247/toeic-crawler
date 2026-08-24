import fs from "node:fs";
import path from "node:path";

export function ensureDirectory(directory: string, mode = 0o755): void {
  fs.mkdirSync(directory, { recursive: true, mode });
  fs.chmodSync(directory, mode);
}

export function ensureParent(filePath: string, mode = 0o755): void {
  ensureDirectory(path.dirname(filePath), mode);
}

export function writeJsonAtomic(
  filePath: string,
  value: unknown,
  mode = 0o600,
): void {
  ensureParent(filePath, mode === 0o600 ? 0o700 : 0o755);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
    mode,
  });
  fs.chmodSync(temporaryPath, mode);
  fs.renameSync(temporaryPath, filePath);
  fs.chmodSync(filePath, mode);
}

export function removeFileIfPresent(filePath: string): boolean {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
