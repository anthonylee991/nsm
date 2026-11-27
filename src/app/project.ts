import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, parse, resolve } from "node:path";

/**
 * A project is identified by the top folder of its git repository, so every subfolder of a repo is the same
 * project. A folder outside any repository is its own project, except the home folder and drive roots, which
 * are no project at all (an agent started there is not working on anything in particular).
 *
 * Keys are absolute paths with forward slashes, lower-cased on Windows (where paths are case-insensitive).
 */
export function projectKey(folder: string | undefined | null): string | null {
  if (!folder || !folder.trim()) return null;
  const start = resolve(folder.trim());
  const norm = (p: string) => {
    const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "win32" ? s.toLowerCase() : s;
  };
  const home = norm(homedir());
  let dir = start;
  for (;;) {
    if (norm(dir) === home) break; // never treat the home folder (or anything above it) as a repo root
    if (existsSync(resolve(dir, ".git"))) return norm(dir);
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const key = norm(start);
  if (key === home || start === parse(start).root || norm(parse(start).root) === key) return null;
  return key;
}

/** The folder name of a project key, for display. */
export function projectName(key: string | null): string {
  return key ? basename(key) : "global";
}
