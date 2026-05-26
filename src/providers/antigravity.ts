import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import { homedir, userInfo } from "os";

import type {
  ClaudeNativeSettings,
  EffortLevel,
} from "../types";
import type {
  AssistantMessageEvent,
  ResultEvent,
  SystemInitEvent,
} from "../types";
import type {
  CliInfo,
  ProcessState,
  ProviderAdapter,
  ProviderCallbacks,
  UnifiedEvent,
} from "./types";
import { getEnhancedPath, findCli, openInTerminal } from "./path-detect";

function findAgyCLIPath(settingsPath?: string): string | null {
  const home = homedir();
  return findCli("agy", settingsPath, [
    join(home, ".local", "bin", "agy"),
    "/usr/local/bin/agy",
    "/opt/homebrew/bin/agy",
  ]);
}

function mapSandboxFlag(mode: string): string[] {
  // agy has `--sandbox` (boolean) and `--dangerously-skip-permissions` —
  // there's no granular per-tool approval, so we map plugin's mode onto
  // these coarsest controls.
  switch (mode) {
    case "bypassPermissions": return ["--dangerously-skip-permissions"];
    case "acceptEdits":       return ["--dangerously-skip-permissions"];
    default:                  return ["--sandbox"];
  }
}

/**
 * AntigravityAdapter — drives Google's `agy` CLI (replacement for Gemini
 * CLI after June 18 2026 for Google One AI Pro users).
 *
 * Caveats — agy v1.0.2 has no structured output, so this adapter is
 * deliberately limited:
 *   - Captures stdout as a single text blob → one `agent_message` event.
 *   - No tool_use / tool_result events → inline diff and tool panels
 *     can't be driven from here.
 *   - No streaming deltas → the response lands all at once when the
 *     subprocess exits.
 *   - Model is fixed (Gemini 3.5 Flash). agy currently exposes no
 *     `--model` flag.
 *
 * When agy adds structured/JSONL output (likely soon, v1.0.2 is brand
 * new), upgrade this adapter to a proper streaming parser.
 */
export class AntigravityAdapter implements ProviderAdapter {
  readonly id = "antigravity" as const;

  private settings: ClaudeNativeSettings;
  private callbacks: ProviderCallbacks = {};
  private _state: ProcessState = "idle";
  private _sessionId: string | null = null;
  private cwd: string = "";
  private cliPath: string | null = null;

  private child: ChildProcess | null = null;
  private stdoutBuffer = "";

  model: string = "gemini-3.5-flash";
  effort: EffortLevel = "high";

  constructor(settings: ClaudeNativeSettings) {
    this.settings = settings;
  }

  get state(): ProcessState { return this._state; }
  get isRunning(): boolean { return this._state === "running"; }
  get sessionId(): string | null { return this._sessionId; }
  get query(): undefined { return undefined; }

  setCallbacks(callbacks: ProviderCallbacks): void { this.callbacks = callbacks; }

  updateSettings(settings: ClaudeNativeSettings): void {
    this.settings = settings;
    this.cliPath = null;
  }

  detectCli(): CliInfo {
    const path = findAgyCLIPath(this.settings.providers?.antigravity?.cliPath);
    if (!path) {
      return {
        found: false,
        loginHint: "curl -fsSL https://antigravity.google/cli/install.sh | bash && agy",
      };
    }
    // agy shares Google OAuth creds with Gemini at ~/.gemini/oauth_creds.json.
    const credPath = join(homedir(), ".gemini", "oauth_creds.json");
    const authenticated = existsSync(credPath);
    return {
      found: true,
      path,
      authenticated,
      loginHint: authenticated ? undefined : "agy   # opens browser to log in with Google",
    };
  }

  /** Same approach as Gemini — agy is interactive, so we open Terminal. */
  async triggerLogin(): Promise<{ success: boolean; manual?: boolean; reason?: string }> {
    const path = findAgyCLIPath(this.settings.providers?.antigravity?.cliPath);
    if (!path) return { success: false, reason: "Antigravity CLI not found" };
    return openInTerminal(path);
  }

  async getSupportedCommands(): Promise<Array<{ name: string; description?: string }>> {
    return [];
  }

  warmUp(workingDirectory?: string): void {
    if (workingDirectory) this.cwd = workingDirectory;
  }

  send(message: string, workingDirectory?: string): void {
    if (workingDirectory) this.cwd = workingDirectory;
    if (this.child) this.killChild();

    const cliPath = this.getCliPath();
    if (!cliPath) {
      this.callbacks.onStderr?.(
        "Antigravity CLI (`agy`) not found. Install with: curl -fsSL https://antigravity.google/cli/install.sh | bash",
      );
      this.setState("error");
      this.callbacks.onComplete?.();
      return;
    }

    this.setState("running");
    this.stdoutBuffer = "";

    // Emit a synthetic init event so chat-view can show the session info.
    const init: SystemInitEvent = {
      type: "system",
      subtype: "init",
      session_id: this._sessionId || `agy-${Date.now()}`,
      model: this.model,
      tools: [],
      mcp_servers: [],
      claude_code_version: "antigravity",
    };
    this._sessionId = init.session_id;
    this.callbacks.onEvent?.(init);

    const args: string[] = [
      "--print", message,
      ...mapSandboxFlag(this.settings.permissionMode),
    ];
    if (this.cwd) {
      args.push("--add-dir", this.cwd);
    }
    // Continue prior conversation if one exists (best-effort).
    if (this._sessionId && this._sessionId.startsWith("agy-conv-")) {
      args.push("--conversation", this._sessionId.replace(/^agy-conv-/, ""));
    }

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
      this.callbacks.onStderr?.(`Failed to spawn agy: ${msg}`);
      this.setState("error");
      this.callbacks.onComplete?.();
      return;
    }

    // Close stdin immediately — agy --print otherwise waits for EOF on
    // stdin before deciding it has nothing more to read. This caused the
    // turn to hang forever ("Thinking…" with no response).
    try { this.child.stdin?.end(); } catch { /* ignore */ }

    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString("utf-8");
    });

    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.callbacks.onStderr?.(chunk.toString("utf-8"));
    });

    this.child.on("error", (err: Error) => {
      this.callbacks.onStderr?.(`agy process error: ${err.message}`);
      this.setState("error");
      this.callbacks.onComplete?.();
      this.child = null;
    });

    this.child.on("close", (code: number | null) => {
      const text = this.stdoutBuffer.trim();
      this.child = null;
      if (code !== 0 && this._state !== "error") {
        this.callbacks.onStderr?.(`agy exited with code ${code ?? "null"}`);
      }
      if (text) {
        const assistant: AssistantMessageEvent = {
          type: "assistant",
          message: {
            id: `agy-${Date.now()}`,
            model: this.model,
            role: "assistant",
            content: [{ type: "text", text }],
            stop_reason: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
          session_id: this._sessionId || "",
          parent_tool_use_id: null,
        };
        this.callbacks.onEvent?.(assistant);
      }
      const result: ResultEvent = {
        type: "result",
        subtype: code === 0 ? "success" : "error",
        is_error: code !== 0,
        duration_ms: 0,
        result: "",
        total_cost_usd: 0,
        session_id: this._sessionId || "",
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
      this.callbacks.onEvent?.(result);
      this.setState("idle");
      this.callbacks.onComplete?.();
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

  async setModelRuntime(_model: string): Promise<void> {
    // agy v1.0.2 ignores --model; no-op.
  }

  destroy(): void {
    this.killChild();
  }

  private buildEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    const home = env.HOME || homedir();
    env.HOME = home;
    env.USER = env.USER || userInfo().username;
    env.PATH = getEnhancedPath();
    // Force agy out of any TTY/pager logic so output flushes promptly to
    // our pipe instead of being buffered for an interactive terminal.
    env.TERM = "dumb";
    env.NO_COLOR = "1";
    return env;
  }

  private getCliPath(): string | null {
    if (!this.cliPath) {
      this.cliPath = findAgyCLIPath(this.settings.providers?.antigravity?.cliPath);
    }
    return this.cliPath;
  }

  private killChild(): void {
    if (this.child && !this.child.killed) {
      try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
    }
    this.child = null;
  }

  private setState(state: ProcessState): void {
    if (this._state !== state) {
      this._state = state;
      this.callbacks.onStateChange?.(state);
    }
  }
}
