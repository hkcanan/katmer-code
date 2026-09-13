// ── Shared PATH + CLI discovery helpers ──
//
// Obsidian (Electron) launches with a stripped-down PATH that often misses
// nvm, asdf, volta, and homebrew-on-arm install locations. Every adapter
// uses these helpers so detection is consistent and aggressive.

import { execFileSync, spawn } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";

/**
 * Build a PATH that includes every place we know a Node-based CLI might
 * live, regardless of how the user installed it. Order matters: we put the
 * most-specific (nvm) before the most-general (/usr/bin).
 */
export function getEnhancedPath(): string {
  const home = homedir();
  const extras: string[] = [];

  // nvm — scan every installed Node version's bin/ directly. Don't rely on
  // `node --version`, because if Obsidian's PATH lacks node it returns
  // nothing and we'd skip nvm entirely.
  const nvmRoot = process.env.NVM_DIR || join(home, ".nvm");
  const nvmVersions = join(nvmRoot, "versions", "node");
  try {
    if (existsSync(nvmVersions)) {
      const versions = readdirSync(nvmVersions)
        .filter((name) => name.startsWith("v"))
        .sort()
        .reverse(); // newest first
      for (const v of versions) {
        const bin = join(nvmVersions, v, "bin");
        if (existsSync(bin)) extras.push(bin);
      }
    }
  } catch { /* ignore */ }

  // volta
  const voltaHome = process.env.VOLTA_HOME || join(home, ".volta");
  const voltaBin = join(voltaHome, "bin");
  if (existsSync(voltaBin)) extras.push(voltaBin);

  // asdf
  const asdfShims = join(home, ".asdf", "shims");
  if (existsSync(asdfShims)) extras.push(asdfShims);

  // homebrew (arm + intel)
  extras.push("/opt/homebrew/bin", "/usr/local/bin");

  // user-local
  // npm configured with a user prefix (a common macOS setup) is not
  // necessarily present in Electron's stripped-down environment.
  const npmPrefix = process.env.NPM_CONFIG_PREFIX;
  extras.push(
    ...(npmPrefix ? [join(npmPrefix, "bin")] : []),
    join(home, ".npm-global", "bin"),
    join(home, ".npm", "bin"),
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
  );

  // system
  extras.push("/usr/bin", "/bin");

  return [process.env.PATH, ...extras].filter(Boolean).join(":");
}

/**
 * Try `which <name>` with our enhanced PATH; return the resolved absolute
 * path if found.
 */
export function whichBinary(name: string): string | null {
  const enhanced = getEnhancedPath();
  try {
    const p = execFileSync("which", [name], {
      env: { ...process.env, PATH: enhanced },
      timeout: 3000,
    }).toString().trim();
    if (p && existsSync(p)) return p;
  } catch { /* not found */ }
  return null;
}

/**
 * Aggressive fallback: walk PATH dirs ourselves and probe for `name`
 * (some `which` implementations behave inconsistently when piped via
 * spawn — this gives the same answer without relying on the helper).
 */
export function probeBinaryInPath(name: string): string | null {
  const enhanced = getEnhancedPath();
  for (const dir of enhanced.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Locate a CLI by name. Tries `which` first, then walks PATH manually,
 * then checks a list of explicit candidate paths the caller provides.
 */
export function findCli(
  name: string,
  override?: string,
  extraCandidates: string[] = [],
): string | null {
  if (override && existsSync(override)) return override;

  const which = whichBinary(name);
  if (which) return which;

  const probed = probeBinaryInPath(name);
  if (probed) return probed;

  for (const c of extraCandidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Run `<cli> --version` (or another version flag) and return the trimmed
 * output. Returns null if the call fails.
 */
export function getCliVersion(cliPath: string, flag = "--version"): string | null {
  try {
    const out = execFileSync(cliPath, [flag], {
      env: { ...process.env, PATH: getEnhancedPath() },
      timeout: 5000,
    }).toString().trim();
    return out;
  } catch {
    return null;
  }
}

/**
 * Open the user's terminal app with the given command typed in. Used for
 * provider CLIs that are interactive TUIs (Gemini, Antigravity) where we
 * can't drive the login from a hidden subprocess.
 *
 * Returns `manual: true` so the caller surfaces a "complete login in
 * Terminal, then refresh" hint to the user.
 */
export function openInTerminal(cliPath: string): Promise<{ success: boolean; manual?: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const plat = platform();
    let child;
    try {
      if (plat === "darwin") {
        // AppleScript: open Terminal.app and type the command.
        const script = `tell application "Terminal" to do script "${cliPath.replace(/"/g, '\\"')}"`;
        child = spawn("osascript", ["-e", script], { stdio: "ignore" });
      } else if (plat === "linux") {
        // Best-effort: try common terminals.
        child = spawn("x-terminal-emulator", ["-e", cliPath], { stdio: "ignore", detached: true });
      } else if (plat === "win32") {
        child = spawn("cmd", ["/c", "start", "cmd", "/k", cliPath], { stdio: "ignore", detached: true });
      } else {
        return resolve({ success: false, reason: `Unsupported platform: ${plat}` });
      }
      child.on("error", (err) => resolve({ success: false, reason: err.message }));
      child.on("spawn", () => resolve({ success: true, manual: true }));
    } catch (err) {
      resolve({ success: false, reason: err instanceof Error ? err.message : String(err) });
    }
  });
}
