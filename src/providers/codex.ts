import { spawn, execFileSync, ChildProcess } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import { homedir, userInfo } from "os";

import type {
  ClaudeNativeSettings,
  EffortLevel,
} from "../types";
import type {
  CliInfo,
  ProcessState,
  ProviderAdapter,
  ProviderCallbacks,
  UnifiedEvent,
} from "./types";
import {
  normalizeCodexEvent,
  makeParserState,
  type CodexThreadEvent,
} from "./normalizers/codex";
import { getEnhancedPath, findCli } from "./path-detect";

function findCodexCLIPath(settingsPath?: string): string | null {
  const home = homedir();
  return findCli("codex", settingsPath, [
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    join(home, ".local", "bin", "codex"),
    join(home, ".cargo", "bin", "codex"),
  ]);
}

const MODEL_ALIASES: Record<string, string> = {
  // Reuse the plugin's existing model slots; Codex's default GPT-5.5 covers
  // both "opus" and "sonnet" intent (most-capable / balanced is a single tier).
  opus: "gpt-5.5",
  "opus[1m]": "gpt-5.5",
  sonnet: "gpt-5.5",
  haiku: "gpt-5.5-mini",
};

function resolveCodexModel(model: string): string {
  return MODEL_ALIASES[model] || model;
}

function mapApprovalPolicy(mode: string): string {
  switch (mode) {
    case "acceptEdits": return "never";        // edits go through silently
    case "bypassPermissions": return "never";
    default: return "on-request";              // model asks the user
  }
}

/** Map plugin effort tiers onto Codex's model_reasoning_effort values.
 * Codex's max tier is model-specific, so fall back to high for compatibility. */
function mapReasoningEffort(effort: string): string {
  switch (effort) {
    case "low":    return "low";
    case "medium": return "medium";
    case "xhigh":  return "xhigh";
    case "max":    return "high";
    case "high":
    default:       return "high";
  }
}

/** Sandbox: workspace-write lets the agent edit files inside cwd without
 *  per-call approval. Default `read-only` blocks all writes. */
function mapSandbox(mode: string): string {
  switch (mode) {
    case "acceptEdits": return "workspace-write";
    case "bypassPermissions": return "danger-full-access";
    default: return "read-only";
  }
}

/**
 * CodexAdapter — drives `codex exec --experimental-json` as a subprocess.
 *
 * The prompt is fed via stdin (Codex CLI's convention). Each send()
 * spawns a fresh subprocess; multi-turn continuity is established via
 * the positional `resume <thread-id>` argument once the first turn has
 * produced a thread_id.
 */
export class CodexAdapter implements ProviderAdapter {
  readonly id = "codex" as const;

  private settings: ClaudeNativeSettings;
  private callbacks: ProviderCallbacks = {};
  private _state: ProcessState = "idle";
  private _sessionId: string | null = null;
  private cwd: string = "";
  private cliPath: string | null = null;

  private child: ChildProcess | null = null;
  private stdoutBuffer = "";
  private parserState = makeParserState("gpt-5.5");

  model: string = "gpt-5.5";
  effort: EffortLevel = "high";

  constructor(settings: ClaudeNativeSettings) {
    this.settings = settings;
  }

  get state(): ProcessState { return this._state; }
  get isRunning(): boolean { return this._state === "running"; }
  get sessionId(): string | null { return this._sessionId; }
  get query(): undefined { return undefined; }

  setCallbacks(callbacks: ProviderCallbacks): void {
    this.callbacks = callbacks;
  }

  updateSettings(settings: ClaudeNativeSettings): void {
    this.settings = settings;
    this.cliPath = null;
  }

  detectCli(): CliInfo {
    const path = findCodexCLIPath(this.settings.providers?.codex?.cliPath);
    if (!path) {
      return {
        found: false,
        loginHint: "npm install -g @openai/codex && codex login",
      };
    }
    // Codex's `login status` returns empty stdout when invoked from a
    // non-TTY parent (Electron subprocess), even though it prints
    // "Logged in using ChatGPT" in a real terminal. So we always check
    // the auth file first, then use the status command as confirmation
    // if it actually printed something useful.
    let authenticated: boolean | undefined = undefined;
    const credPath = join(homedir(), ".codex", "auth.json");
    const fileExists = existsSync(credPath);
    try {
      const out = execFileSync(path, ["login", "status"], {
        env: { ...process.env, PATH: getEnhancedPath() },
        timeout: 4000,
        encoding: "utf-8",
      }).trim();
      if (out.length > 0) {
        // Status command spoke — trust its answer over file existence.
        authenticated = /logged in/i.test(out) && !/not/i.test(out);
        console.log(`[katmer-code] codex login status: "${out}" → authenticated=${authenticated}`);
      } else {
        // Empty stdout (Electron/non-TTY) — trust the auth file.
        authenticated = fileExists;
        console.log(`[katmer-code] codex login status was empty (non-TTY) → fallback to ${credPath} exists=${fileExists}`);
      }
    } catch (err) {
      console.warn(`[katmer-code] codex login status failed:`, err);
      authenticated = fileExists;
      console.log(`[katmer-code] codex fallback to file check: ${credPath} exists=${fileExists}`);
    }
    return {
      found: true,
      path,
      authenticated,
      loginHint: authenticated === false ? "codex login" : undefined,
    };
  }

  /**
   * Spawn `codex login` (opens browser) and poll `codex login status`
   * every few seconds. We declare success the moment the status flips —
   * don't trust subprocess exit (codex login can wait for ENTER, sit on
   * an interactive prompt, or otherwise stay alive after the browser
   * flow completes).
   */
  async triggerLogin(): Promise<{ success: boolean; reason?: string }> {
    const path = findCodexCLIPath(this.settings.providers?.codex?.cliPath);
    if (!path) return { success: false, reason: "Codex CLI not found" };

    // 1. Snapshot starting state so we know it actually changed.
    //    Use the same dual approach as detectCli (status command first,
    //    then auth file fallback for non-TTY Electron context).
    const credPath = join(homedir(), ".codex", "auth.json");
    const checkAuth = (): boolean => {
      try {
        const out = execFileSync(path, ["login", "status"], {
          env: { ...process.env, PATH: getEnhancedPath() },
          timeout: 4000,
          encoding: "utf-8",
        }).trim();
        if (out.length > 0) return /logged in/i.test(out) && !/not/i.test(out);
        return existsSync(credPath);
      } catch {
        return existsSync(credPath);
      }
    };
    const wasAuthed = checkAuth();

    // 2. Kick off login (don't await exit).
    const child = spawn(path, ["login"], {
      env: { ...process.env, PATH: getEnhancedPath() },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    child.on("error", () => { /* polling will fall through */ });

    // 3. Poll every 3s for up to 5 minutes.
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const nowAuthed = checkAuth();
      if (nowAuthed && !wasAuthed) {
        try { child.kill(); } catch { /* ignore */ }
        this.cliPath = null;
        return { success: true };
      }
      if (nowAuthed && wasAuthed) {
        // Re-login by an already-authed user — still success, no change to detect.
        try { child.kill(); } catch { /* ignore */ }
        return { success: true };
      }
    }
    try { child.kill(); } catch { /* ignore */ }
    return { success: false, reason: "Login didn't complete within 5 minutes — try the terminal command directly: codex login" };
  }

  async getSupportedCommands(): Promise<Array<{ name: string; description?: string }>> {
    // Codex CLI exposes interactive slash commands; no headless discovery.
    return [];
  }

  warmUp(workingDirectory?: string): void {
    if (workingDirectory) this.cwd = workingDirectory;
    // codex exec spins up fresh per-turn; no pre-warming.
  }

  send(message: string, workingDirectory?: string): void {
    if (workingDirectory) this.cwd = workingDirectory;
    if (this.child) {
      this.killChild();
    }

    const cliPath = this.getCliPath();
    if (!cliPath) {
      this.callbacks.onStderr?.("Codex CLI not found. Install with: npm install -g @openai/codex (or `brew install codex`).");
      this.setState("error");
      this.callbacks.onComplete?.();
      return;
    }

    this.setState("running");
    this.stdoutBuffer = "";
    this.parserState = makeParserState(resolveCodexModel(this.model));
    this.parserState.sessionId = this._sessionId || "";

    const args = this.buildArgs();
    const env = this.buildEnv();

    try {
      this.child = spawn(cliPath, args, {
        cwd: this.cwd || undefined,
        env: env as typeof process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.onStderr?.(`Failed to spawn codex: ${msg}`);
      this.setState("error");
      this.callbacks.onComplete?.();
      return;
    }

    // Codex consumes the prompt on stdin.
    try {
      this.child.stdin?.write(message);
      this.child.stdin?.end();
    } catch (err) {
      this.callbacks.onStderr?.(`stdin write failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString("utf-8"));
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.callbacks.onStderr?.(chunk.toString("utf-8"));
    });

    this.child.on("error", (err: Error) => {
      this.callbacks.onStderr?.(`codex process error: ${err.message}`);
      this.setState("error");
      this.callbacks.onComplete?.();
      this.child = null;
    });

    this.child.on("close", (code: number | null) => {
      if (this.stdoutBuffer.trim().length > 0) {
        this.tryEmitLine(this.stdoutBuffer);
        this.stdoutBuffer = "";
      }
      this.child = null;
      if (code !== 0 && this._state !== "error") {
        this.callbacks.onStderr?.(`codex exited with code ${code ?? "null"}`);
      }
      if (this._state === "running") {
        this.setState("idle");
        this.callbacks.onComplete?.();
      }
    });
  }

  abort(): void {
    this.killChild();
    this.setState("idle");
    this.callbacks.onComplete?.();
  }

  newSession(): void {
    this.killChild();
    this._sessionId = null;
  }

  setSessionId(id: string): void {
    this.killChild();
    this._sessionId = id;
  }

  async setModelRuntime(model: string): Promise<void> {
    this.model = model;
    // Per-turn flag, applied on next spawn.
  }

  destroy(): void {
    this.killChild();
  }

  // ── Internals ──

  private buildArgs(): string[] {
    const args: string[] = ["exec", "--json"];

    args.push("--model", resolveCodexModel(this.model));

    if (this.cwd) {
      args.push("--cd", this.cwd);
    }

    args.push("--sandbox", mapSandbox(this.settings.permissionMode));
    args.push(
      "--config",
      `approval_policy="${mapApprovalPolicy(this.settings.permissionMode)}"`,
    );
    // Plug the existing effort selector into Codex's reasoning effort knob.
    args.push(
      "--config",
      `model_reasoning_effort="${mapReasoningEffort(this.effort)}"`,
    );
    args.push("--skip-git-repo-check");

    if (this.settings.allowWebRequests) {
      // `codex exec` doesn't expose --search; toggle via config instead.
      args.push("--config", `web_search="live"`);
    }

    // Resume previous thread when known. Codex uses positional subcommand
    // `resume <thread-id>` rather than a flag.
    if (this._sessionId) {
      args.push("resume", this._sessionId);
    }

    return args;
  }

  private buildEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    const home = env.HOME || homedir();
    env.HOME = home;
    env.USER = env.USER || userInfo().username;
    env.PATH = getEnhancedPath();
    return env;
  }

  private getCliPath(): string | null {
    if (!this.cliPath) {
      this.cliPath = findCodexCLIPath(this.settings.providers?.codex?.cliPath);
    }
    return this.cliPath;
  }

  private killChild(): void {
    if (this.child && !this.child.killed) {
      try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    this.child = null;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx);
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      this.tryEmitLine(line);
    }
  }

  private tryEmitLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: CodexThreadEvent;
    try {
      parsed = JSON.parse(trimmed) as CodexThreadEvent;
    } catch {
      return;
    }
    const events = normalizeCodexEvent(parsed, this.parserState);
    for (const ev of events) {
      this.emit(ev);
    }
    if (parsed.type === "thread.started") {
      this._sessionId = parsed.thread_id;
    }
    if (parsed.type === "turn.completed" || parsed.type === "turn.failed" || parsed.type === "error") {
      this.setState("idle");
      this.callbacks.onComplete?.();
    }
  }

  private emit(event: UnifiedEvent): void {
    this.callbacks.onEvent?.(event);
  }

  private setState(state: ProcessState): void {
    if (this._state !== state) {
      this._state = state;
      this.callbacks.onStateChange?.(state);
    }
  }
}
