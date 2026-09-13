import { spawn, execFileSync } from "child_process";
import { join } from "path";
import { existsSync } from "fs";
import { homedir, userInfo } from "os";
import { getEnhancedPath, findCli } from "./path-detect";

/** Claude Agent SDK supports low/medium/high/max; narrower Codex levels
 * are intentionally not passed through to the Claude subprocess. */
function resolveClaudeEffort(effort: EffortLevel): "low" | "medium" | "high" | "max" {
  if (effort === "minimal") return "low";
  if (effort === "xhigh") return "max";
  return effort;
}
import type {
  ClaudeEvent,
  ClaudeNativeSettings,
  ModelChoice,
  EffortLevel,
  AssistantMessageEvent,
  SystemInitEvent,
  ResultEvent,
  RateLimitEvent,
  StreamDeltaEvent,
} from "../types";

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKUserMessage,
  SDKSystemMessage,
  SDKResultSuccess,
  SDKCompactBoundaryMessage,
  Query,
  Options,
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  CliInfo,
  ProcessState,
  ProviderAdapter,
  ProviderCallbacks,
  UnifiedEvent,
} from "./types";

/**
 * AsyncIterable message channel for persistent SDK query.
 * Allows pushing user messages that the SDK consumes on demand.
 */
class UserMessageChannel implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  enqueue(msg: SDKUserMessage): void {
    if (this.waiting) {
      this.waiting({ value: msg, done: false });
      this.waiting = null;
    } else {
      this.queue.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      this.waiting({ value: undefined!, done: true });
      this.waiting = null;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined!, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

function findClaudeCLIPath(settingsPath?: string): string | null {
  const home = homedir();
  const extras: string[] = [
    join(home, ".claude", "local", "claude"),
    join(home, ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];

  // npm global install location
  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], {
      env: { ...process.env, PATH: getEnhancedPath() },
      timeout: 5000,
    }).toString().trim();
    if (npmRoot) extras.push(join(npmRoot, "@anthropic-ai", "claude-code", "cli.js"));
  } catch { /* ignore */ }

  return findCli("claude", settingsPath, extras);
}

function findNodeExecutable(): string {
  return findCli("node") || "node";
}

/**
 * ClaudeAdapter — wraps the official Claude Agent SDK as a ProviderAdapter.
 *
 * This is the canonical reference implementation; non-Claude adapters
 * normalize their event stream into the same UnifiedEvent shape consumed
 * by chat-view.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude" as const;

  private activeQuery: Query | null = null;
  private channel: UserMessageChannel | null = null;
  private abortController: AbortController | null = null;
  private _state: ProcessState = "idle";
  private settings: ClaudeNativeSettings;
  private _sessionId: string | null = null;
  private cwd: string = "";
  private _aborted = false;
  private cliPath: string | null = null;

  model: string = "sonnet";
  effort: EffortLevel = "high";

  private callbacks: ProviderCallbacks = {};

  constructor(settings: ClaudeNativeSettings) {
    this.settings = settings;
  }

  get state(): ProcessState { return this._state; }
  get isRunning(): boolean { return this._state === "running"; }
  get sessionId(): string | null { return this._sessionId; }
  get query(): Query | null { return this.activeQuery; }

  setCallbacks(callbacks: ProviderCallbacks): void {
    this.callbacks = callbacks;
  }

  updateSettings(settings: ClaudeNativeSettings): void {
    this.settings = settings;
    this.cliPath = null;
  }

  detectCli(): CliInfo {
    const path = findClaudeCLIPath(this.resolveCliOverride());
    if (!path) {
      return {
        found: false,
        loginHint: "npm install -g @anthropic-ai/claude-code && claude auth login",
      };
    }
    // Definitive auth check — Claude stores creds in macOS Keychain so
    // file-based detection doesn't work. Ask the CLI directly.
    let authenticated: boolean | undefined = undefined;
    try {
      const out = execFileSync(path, ["auth", "status"], {
        env: { ...process.env, PATH: getEnhancedPath() },
        timeout: 4000,
        encoding: "utf-8",
      });
      try {
        const json = JSON.parse(out);
        authenticated = json.loggedIn === true;
        console.log(`[katmer-code] claude auth status: loggedIn=${authenticated} method=${json.authMethod}`);
      } catch {
        authenticated = /logged ?in/i.test(out) && !/not/i.test(out);
        console.log(`[katmer-code] claude auth status (text): "${out.trim()}" → ${authenticated}`);
      }
    } catch (err) {
      console.warn(`[katmer-code] claude auth status failed:`, err);
      // CLI present but `auth status` failed — leave undefined so UI
      // doesn't false-flag.
    }
    return {
      found: true,
      path,
      authenticated,
      loginHint: authenticated === false ? "claude auth login" : undefined,
    };
  }

  /**
   * Spawn `claude auth login` (opens browser) and poll
   * `claude auth status` every few seconds. Don't trust subprocess exit
   * — Claude's auth flow can wait for user input after browser auth.
   */
  async triggerLogin(): Promise<{ success: boolean; reason?: string }> {
    const path = findClaudeCLIPath(this.resolveCliOverride());
    if (!path) return { success: false, reason: "Claude CLI not found" };

    const checkAuth = (): boolean => {
      try {
        const out = execFileSync(path, ["auth", "status"], {
          env: { ...process.env, PATH: getEnhancedPath() },
          timeout: 4000,
          encoding: "utf-8",
        });
        try {
          const json = JSON.parse(out);
          return json.loggedIn === true;
        } catch {
          return /logged ?in/i.test(out) && !/not/i.test(out);
        }
      } catch { return false; }
    };
    const wasAuthed = checkAuth();

    const child = spawn(path, ["auth", "login"], {
      env: { ...process.env, PATH: getEnhancedPath() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", () => { /* polling will fall through */ });

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
        try { child.kill(); } catch { /* ignore */ }
        return { success: true };
      }
    }
    try { child.kill(); } catch { /* ignore */ }
    return { success: false, reason: "Login didn't complete within 5 minutes — try the terminal command directly: claude auth login" };
  }

  /** Per-provider CLI override falls back to the legacy top-level field. */
  private resolveCliOverride(): string | undefined {
    return this.settings.providers?.claude?.cliPath || this.settings.cliPath;
  }

  private buildEnv(): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };
    const home = env.HOME || homedir();
    env.HOME = home;
    env.USER = env.USER || userInfo().username;
    env.PATH = getEnhancedPath();
    return env;
  }

  /**
   * Custom spawn function for Electron compatibility.
   *
   * CRITICAL: Do NOT pass `signal` to spawn() — Obsidian's Electron uses a
   * different realm for AbortSignal, causing instanceof checks to fail.
   */
  private createCustomSpawn(): (options: SpawnOptions) => SpawnedProcess {
    return (options: SpawnOptions): SpawnedProcess => {
      let { command } = options;
      let spawnArgs = [...options.args];
      const { cwd, env, signal } = options;

      if (command === "node") {
        if (spawnArgs.length > 0 && !spawnArgs[0].endsWith(".js") && !spawnArgs[0].endsWith(".mjs")) {
          command = spawnArgs[0];
          spawnArgs = spawnArgs.slice(1);
        } else {
          command = findNodeExecutable();
        }
      }

      const child = spawn(command, spawnArgs, {
        cwd,
        env: env as typeof process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      if (signal) {
        if (signal.aborted) {
          child.kill();
        } else {
          signal.addEventListener("abort", () => child.kill(), { once: true });
        }
      }

      if (child.stderr) {
        child.stderr.on("data", (data: Buffer) => {
          this.callbacks.onStderr?.(data.toString("utf-8"));
        });
      }

      if (!child.stdin || !child.stdout) {
        throw new Error("Failed to create process streams");
      }

      return child as unknown as SpawnedProcess;
    };
  }

  private resolveModel(): { model: string } {
    const model = this.model || this.settings.defaultModel || "sonnet";
    return { model };
  }

  private getCliPath(): string | null {
    if (!this.cliPath) {
      this.cliPath = findClaudeCLIPath(this.resolveCliOverride());
    }
    return this.cliPath;
  }

  private buildOptions(): Options {
    const { model } = this.resolveModel();
    const permMode = this.settings.permissionMode || "acceptEdits";
    const cliPath = this.getCliPath();

    this.abortController = new AbortController();

    const onPermissionRequest = this.callbacks.onPermissionRequest;

    const options: Options = {
      abortController: this.abortController,
      cwd: this.cwd || undefined,
      env: this.buildEnv(),
      model,
      effort: resolveClaudeEffort(this.effort || "high"),
      permissionMode: permMode,
      pathToClaudeCodeExecutable: cliPath || undefined,
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      enableFileCheckpointing: true,
      thinking: { type: "adaptive" },
      spawnClaudeCodeProcess: this.createCustomSpawn(),
      canUseTool: onPermissionRequest ? async (toolName, input, opts) => {
        if (toolName.startsWith("mcp__")) {
          return { behavior: "allow" as const, updatedInput: input };
        }

        const signal = opts.signal;
        try {
          const result = await new Promise<"allow" | "deny" | "always">((resolve, reject) => {
            if (signal?.aborted) { reject(new Error("Aborted")); return; }
            const onAbort = () => reject(new Error("Aborted"));
            signal?.addEventListener("abort", onAbort, { once: true });
            onPermissionRequest({
              toolName,
              input,
              title: opts.title,
              displayName: opts.displayName,
              description: opts.description,
            }).then(resolve, reject).finally(() => {
              signal?.removeEventListener("abort", onAbort);
            });
          });
          if (result === "allow" || result === "always") {
            return {
              behavior: "allow" as const,
              updatedInput: input,
              updatedPermissions: result === "always" ? opts.suggestions : undefined,
            };
          }
          return { behavior: "deny" as const, message: "User denied" };
        } catch {
          return { behavior: "deny" as const, message: "Aborted" };
        }
      } : undefined,
    };

    const allowed = [
      "Read", "Write", "Edit", "Glob", "Grep", "Agent",
      "Bash(cat*)", "Bash(ls*)", "Bash(head*)", "Bash(tail*)", "Bash(wc*)",
      "Bash(find*)", "Bash(grep*)", "Bash(echo*)", "Bash(mkdir*)", "Bash(cd*)",
    ];
    if (this.settings.allowWebRequests) {
      allowed.push("WebFetch", "WebSearch", "Bash(curl*)", "Bash(python3*)", "Bash(open *)");
    }
    options.allowedTools = allowed;

    if (this._sessionId) {
      options.resume = this._sessionId;
    }

    return options;
  }

  private startQuery(): boolean {
    this.closeQuery();

    const cliPath = this.getCliPath();
    if (!cliPath) {
      console.error("[katmer-code] Claude CLI not found");
      this.callbacks.onStderr?.("Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code");
      this.setState("error");
      this.callbacks.onComplete?.();
      return false;
    }

    try {
      this.channel = new UserMessageChannel();
      const options = this.buildOptions();

      this.activeQuery = sdkQuery({
        prompt: this.channel,
        options,
      });

      void this.consumeEvents();
      return true;
    } catch (err) {
      console.error("[katmer-code] SDK query start error:", err);
      this.setState("error");
      this.callbacks.onComplete?.();
      return false;
    }
  }

  private async consumeEvents(): Promise<void> {
    if (!this.activeQuery) return;

    try {
      for await (const message of this.activeQuery) {
        if (this._aborted) break;
        this.handleSDKMessage(message);
      }
    } catch (err: unknown) {
      if (!this._aborted) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[katmer-code] SDK event loop error:", errMsg);
        if (errMsg.includes("not logged in") || errMsg.includes("authenticate") || errMsg.includes("API key")) {
          this.callbacks.onStderr?.("Not logged in. Please run `claude` in your terminal first to authenticate.");
        }
        this.setState("error");
        this.callbacks.onComplete?.();
      }
    }
  }

  private emit(event: UnifiedEvent): void {
    this.callbacks.onEvent?.(event);
  }

  private handleSDKMessage(msg: SDKMessage): void {
    switch (msg.type) {
      case "system": {
        if ("subtype" in msg && msg.subtype === "init") {
          const initMsg = msg as SDKSystemMessage;
          this._sessionId = initMsg.session_id;
          const event: SystemInitEvent = {
            type: "system",
            subtype: "init",
            session_id: initMsg.session_id,
            model: initMsg.model,
            tools: initMsg.tools || [],
            mcp_servers: initMsg.mcp_servers || [],
            claude_code_version: initMsg.claude_code_version || "",
          };
          this.emit(event);
        }
        if ("subtype" in msg && msg.subtype === "compact_boundary") {
          this.emit({ type: "system", subtype: "compact_boundary", ...(msg as SDKCompactBoundaryMessage).compact_metadata });
        }
        break;
      }

      case "assistant": {
        const aMsg = msg;
        const event: AssistantMessageEvent = {
          type: "assistant",
          message: {
            id: aMsg.message?.id || "",
            model: aMsg.message?.model || "",
            role: "assistant",
            content: (aMsg.message?.content as AssistantMessageEvent["message"]["content"]) || [],
            stop_reason: aMsg.message?.stop_reason || null,
            usage: {
              input_tokens: aMsg.message?.usage?.input_tokens || 0,
              output_tokens: aMsg.message?.usage?.output_tokens || 0,
              cache_read_input_tokens: aMsg.message?.usage?.cache_read_input_tokens || 0,
              cache_creation_input_tokens: aMsg.message?.usage?.cache_creation_input_tokens || 0,
            },
          },
          session_id: aMsg.session_id,
          parent_tool_use_id: aMsg.parent_tool_use_id,
        };
        this.emit(event);
        break;
      }

      case "result": {
        const rMsg = msg;
        this._sessionId = rMsg.session_id;

        const event: ResultEvent = {
          type: "result",
          subtype: rMsg.subtype === "success" ? "success" : "error",
          is_error: rMsg.is_error,
          duration_ms: rMsg.duration_ms,
          result: "result" in rMsg ? (rMsg as SDKResultSuccess).result : "",
          total_cost_usd: rMsg.total_cost_usd,
          session_id: rMsg.session_id,
          usage: {
            input_tokens: rMsg.usage?.input_tokens || 0,
            output_tokens: rMsg.usage?.output_tokens || 0,
            cache_read_input_tokens: rMsg.usage?.cache_read_input_tokens || 0,
            cache_creation_input_tokens: rMsg.usage?.cache_creation_input_tokens || 0,
          },
        };

        if (rMsg.modelUsage) {
          Object.assign(event, { modelUsage: rMsg.modelUsage });
        }

        this.emit(event);
        this.setState("idle");
        this.callbacks.onComplete?.();
        break;
      }

      case "rate_limit_event": {
        const rlMsg = msg;
        const event: RateLimitEvent = {
          type: "rate_limit_event",
          rate_limit_info: {
            status: rlMsg.rate_limit_info?.status || "allowed",
            resetsAt: rlMsg.rate_limit_info?.resetsAt || 0,
          },
        };
        this.emit(event);
        break;
      }

      case "stream_event": {
        const streamMsg = msg as unknown as { type: "stream_event"; event: Record<string, unknown>; parent_tool_use_id: string | null };

        if (streamMsg.parent_tool_use_id) break;

        const ev = streamMsg.event;
        if (ev && ev.type === "content_block_delta") {
          const delta = ev.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            const streamEvent: StreamDeltaEvent = {
              type: "stream_delta",
              text: delta.text,
              parent_tool_use_id: streamMsg.parent_tool_use_id,
            };
            this.emit(streamEvent);
          }
        }
        break;
      }

      default:
        break;
    }
  }

  warmUp(workingDirectory?: string): void {
    if (this.activeQuery) return;
    if (workingDirectory) this.cwd = workingDirectory;
    this.startQuery();
    if (this._state === "running") this.setState("idle");
  }

  send(message: string, workingDirectory?: string): void {
    if (workingDirectory) {
      this.cwd = workingDirectory;
    }

    this._aborted = false;
    this.setState("running");

    const userMsg: SDKUserMessage = {
      type: "user",
      message: {
        role: "user",
        content: message,
      },
      parent_tool_use_id: null,
      session_id: this._sessionId || "",
    };

    if (!this.activeQuery) {
      const ok = this.startQuery();
      if (ok) {
        this.channel?.enqueue(userMsg);
      }
    } else {
      this.channel?.enqueue(userMsg);
    }
  }

  abort(): void {
    this._aborted = true;

    if (this.activeQuery) {
      void this.activeQuery.interrupt().catch(() => {});
    }
    this.abortController?.abort();
    this.channel?.close();
    this.channel = null;
    this.abortController = null;
    this.activeQuery = null;

    this.setState("idle");
    this.callbacks.onComplete?.();
  }

  newSession(): void {
    this.closeQuery();
    this._sessionId = null;
  }

  setSessionId(id: string): void {
    this.closeQuery();
    this._sessionId = id;
  }

  async setModelRuntime(model: string): Promise<void> {
    this.model = model;
    if (this.activeQuery) {
      const { model: modelStr } = this.resolveModel();
      try {
        await this.activeQuery.setModel(modelStr);
      } catch {
        /* Next query will use the new model */
      }
    }
  }

  private closeQuery(): void {
    this._aborted = true;
    this.channel?.close();
    this.channel = null;
    this.abortController?.abort();
    this.abortController = null;
    this.activeQuery = null;
    this._aborted = false;
    this.setState("idle");
  }

  private setState(state: ProcessState): void {
    if (this._state !== state) {
      this._state = state;
      this.callbacks.onStateChange?.(state);
    }
  }

  destroy(): void {
    this.closeQuery();
  }

  async getSupportedCommands(): Promise<Array<{ name: string; description?: string }>> {
    if (!this.activeQuery) return [];
    try {
      const cmds = await this.activeQuery.supportedCommands();
      return cmds || [];
    } catch {
      return [];
    }
  }
}

/** Convenience re-export for legacy imports. */
export type { ModelChoice };
