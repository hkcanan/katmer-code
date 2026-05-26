import { spawn, ChildProcess } from "child_process";
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
  normalizeGeminiEvent,
  type GeminiStreamEvent,
} from "./normalizers/gemini";
import { getEnhancedPath, findCli, getCliVersion, openInTerminal } from "./path-detect";

function findGeminiCLIPath(settingsPath?: string): string | null {
  const home = homedir();
  return findCli("gemini", settingsPath, [
    "/usr/local/bin/gemini",
    "/opt/homebrew/bin/gemini",
    join(home, ".local", "bin", "gemini"),
  ]);
}

/**
 * Gemini's stream-json output was added in v0.11. Anything earlier rejects
 * the flag. We detect once and fall back to plain text mode otherwise.
 */
function geminiSupportsStreamJson(cliPath: string): boolean {
  const v = getCliVersion(cliPath);
  if (!v) return false;
  // Output is like "0.43.0" or "@google/gemini-cli/0.43.0"
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const [, major, minor] = m;
  const maj = parseInt(major, 10);
  const min = parseInt(minor, 10);
  if (maj > 0) return true;
  return min >= 11;
}

// ── Model resolution ──

const MODEL_ALIASES: Record<string, string> = {
  // Plugin-legacy slot → Gemini equivalent. We aim high (3.1 Pro Preview)
  // for paid plans; 2.5 Pro is the safe fallback if the user is on the
  // free tier and 3.x returns 404.
  opus: "gemini-3.1-pro-preview",
  "opus[1m]": "gemini-3.1-pro-preview",
  sonnet: "gemini-3.1-pro-preview",
  haiku: "gemini-3-flash-preview",
  auto: "auto",
  pro: "pro",
  flash: "flash",
  "flash-lite": "flash-lite",
};

function resolveGeminiModel(model: string): string {
  return MODEL_ALIASES[model] || model;
}

// ── Approval mode mapping ──

function mapPermissionMode(mode: string): string {
  switch (mode) {
    case "acceptEdits": return "auto_edit";
    case "bypassPermissions": return "yolo";
    default: return "default";
  }
}

/**
 * GeminiAdapter — drives `gemini` CLI in headless stream-json mode.
 *
 * Each `send()` spawns a one-shot subprocess (Gemini CLI exits after the
 * turn finishes). Session continuity comes from --resume on subsequent
 * turns, using the session_id captured from the first init event.
 */
export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini" as const;

  private settings: ClaudeNativeSettings;
  private callbacks: ProviderCallbacks = {};
  private _state: ProcessState = "idle";
  private _sessionId: string | null = null;
  private cwd: string = "";
  private cliPath: string | null = null;

  private child: ChildProcess | null = null;
  private stdoutBuffer = "";
  private parserState = { sessionId: "", model: "" };

  model: string = "auto";
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
    const path = findGeminiCLIPath(this.settings.providers?.gemini?.cliPath);
    if (!path) {
      return {
        found: false,
        loginHint: "npm install -g @google/gemini-cli && gemini",
      };
    }
    // Gemini stores OAuth creds at ~/.gemini/oauth_creds.json after login.
    const credPath = join(homedir(), ".gemini", "oauth_creds.json");
    const authenticated = existsSync(credPath);
    return {
      found: true,
      path,
      authenticated,
      loginHint: authenticated ? undefined : "gemini   # opens browser to log in with Google",
    };
  }

  /**
   * Gemini CLI is an interactive TUI — there's no `gemini auth login`
   * subcommand. We open Terminal.app and run `gemini` there; the first
   * run opens the browser for OAuth. Returns `manual: true` so the
   * caller knows the user has to come back to refresh status manually.
   */
  async triggerLogin(): Promise<{ success: boolean; manual?: boolean; reason?: string }> {
    const path = findGeminiCLIPath(this.settings.providers?.gemini?.cliPath);
    if (!path) return { success: false, reason: "Gemini CLI not found" };
    return openInTerminal(path);
  }

  async getSupportedCommands(): Promise<Array<{ name: string; description?: string }>> {
    // Gemini exposes slash commands inside its REPL; there's no headless
    // discovery API, so we return an empty list and let chat-view fall back
    // to its built-in skill catalog.
    return [];
  }

  warmUp(workingDirectory?: string): void {
    if (workingDirectory) this.cwd = workingDirectory;
    // Gemini CLI has no persistent session to pre-spawn; warmUp is a no-op.
  }

  send(message: string, workingDirectory?: string): void {
    if (workingDirectory) this.cwd = workingDirectory;
    if (this.child) {
      // Previous turn still running — kill it before starting a new one.
      this.killChild();
    }

    const cliPath = this.getCliPath();
    if (!cliPath) {
      this.callbacks.onStderr?.("Gemini CLI not found. Install with: npm install -g @google/gemini-cli && gemini");
      this.setState("error");
      this.callbacks.onComplete?.();
      return;
    }

    if (!geminiSupportsStreamJson(cliPath)) {
      const ver = getCliVersion(cliPath) || "unknown";
      this.callbacks.onStderr?.(
        `Gemini CLI at ${cliPath} reports version "${ver}" which does not support stream-json output. ` +
        `Plugin needs v0.11+ (latest is v0.43+). Run: gemini update  (or: npm install -g @google/gemini-cli@latest), ` +
        `then reload Obsidian.`,
      );
      this.setState("error");
      this.callbacks.onComplete?.();
      return;
    }

    this.setState("running");
    this.stdoutBuffer = "";
    this.parserState = { sessionId: this._sessionId || "", model: this.model };

    const args = this.buildArgs(message);
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
      this.callbacks.onStderr?.(`Failed to spawn gemini: ${msg}`);
      this.setState("error");
      this.callbacks.onComplete?.();
      return;
    }

    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString("utf-8"));
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.callbacks.onStderr?.(chunk.toString("utf-8"));
    });

    this.child.on("error", (err: Error) => {
      this.callbacks.onStderr?.(`gemini process error: ${err.message}`);
      this.setState("error");
      this.callbacks.onComplete?.();
      this.child = null;
    });

    this.child.on("close", (code: number | null) => {
      // Flush any trailing partial line as a best-effort JSON parse.
      if (this.stdoutBuffer.trim().length > 0) {
        this.tryEmitLine(this.stdoutBuffer);
        this.stdoutBuffer = "";
      }
      this.child = null;
      if (code !== 0 && this._state !== "error") {
        this.callbacks.onStderr?.(`gemini exited with code ${code ?? "null"}`);
      }
      // Mirror Claude behaviour: the result event already moved state to idle.
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
    // Gemini CLI re-reads model per spawn — no live switch needed.
  }

  destroy(): void {
    this.killChild();
  }

  // ── Internals ──

  private buildArgs(prompt: string): string[] {
    const args: string[] = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--model", resolveGeminiModel(this.model),
      "--approval-mode", mapPermissionMode(this.settings.permissionMode),
    ];
    if (this._sessionId) {
      args.push("--resume", this._sessionId);
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
      this.cliPath = findGeminiCLIPath(this.settings.providers?.gemini?.cliPath);
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
    // Process complete lines (NDJSON / JSONL).
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
    let parsed: GeminiStreamEvent;
    try {
      parsed = JSON.parse(trimmed) as GeminiStreamEvent;
    } catch {
      // Not JSON — likely human-readable status text. Drop it.
      return;
    }
    const events = normalizeGeminiEvent(parsed, this.parserState);
    for (const ev of events) {
      this.emit(ev);
    }
    // Track session id for subsequent turns.
    if (parsed.type === "init") {
      this._sessionId = parsed.session_id;
    }
    if (parsed.type === "result") {
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
