import { spawn, execFileSync } from "child_process";
import { join, dirname } from "path";
import { existsSync } from "fs";
import { homedir, userInfo } from "os";
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
} from "./types";

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKRateLimitEvent,
  SDKCompactBoundaryMessage,
  Query,
  Options,
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

export type ProcessState = "idle" | "running" | "error";

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
      this.waiting({ value: undefined as unknown as SDKUserMessage, done: true });
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
          return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

/**
 * Build an enhanced PATH for GUI apps (Obsidian has a minimal PATH).
 * Includes common Node.js install locations.
 */
function getEnhancedPath(): string {
  const home = homedir();
  const extraPaths = [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    join(home, ".local", "bin"),
    join(home, ".nvm", "versions", "node", "current", "bin"),
    "/usr/bin",
  ];

  // Detect active nvm version
  const nvmDir = process.env.NVM_DIR || join(home, ".nvm");
  try {
    const currentNode = execFileSync("node", ["--version"], {
      env: { ...process.env, PATH: [process.env.PATH, ...extraPaths].filter(Boolean).join(":") },
      timeout: 3000,
    }).toString().trim();
    if (currentNode) {
      const nvmBin = join(nvmDir, "versions", "node", currentNode, "bin");
      if (existsSync(nvmBin)) extraPaths.push(nvmBin);
    }
  } catch { /* ignore */ }

  return [process.env.PATH, ...extraPaths].filter(Boolean).join(":");
}

/**
 * Find the Claude Code CLI executable on the system.
 * Searches common install locations — does NOT bundle cli.js.
 */
function findClaudeCLIPath(settingsPath?: string): string | null {
  // 1. User-configured path
  if (settingsPath && existsSync(settingsPath)) return settingsPath;

  const home = homedir();
  const enhancedPath = getEnhancedPath();

  // 2. Try `which claude` with enhanced PATH
  try {
    const claudePath = execFileSync("which", ["claude"], {
      env: { ...process.env, PATH: enhancedPath },
      timeout: 3000,
    }).toString().trim();
    if (claudePath && existsSync(claudePath)) return claudePath;
  } catch { /* not found */ }

  // 3. Common locations
  const candidates = [
    join(home, ".claude", "local", "claude"),
    join(home, ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];

  // 4. npm global install — cli.js
  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], {
      env: { ...process.env, PATH: enhancedPath },
      timeout: 5000,
    }).toString().trim();
    if (npmRoot) {
      candidates.push(join(npmRoot, "@anthropic-ai", "claude-code", "cli.js"));
    }
  } catch { /* ignore */ }

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  return null;
}

/**
 * Find the node executable with enhanced PATH.
 */
function findNodeExecutable(): string {
  const enhancedPath = getEnhancedPath();
  try {
    const nodePath = execFileSync("which", ["node"], {
      env: { ...process.env, PATH: enhancedPath },
      timeout: 3000,
    }).toString().trim();
    if (nodePath) return nodePath;
  } catch { /* ignore */ }
  return "node";
}

/**
 * Manages a persistent Claude Agent SDK query.
 *
 * Uses the SDK's `query()` with AsyncIterable prompt for multi-turn conversations.
 * Events are mapped to our ClaudeEvent type for backward compatibility with chat-view.
 */
export class ProcessManager {
  private activeQuery: Query | null = null;
  private channel: UserMessageChannel | null = null;
  private abortController: AbortController | null = null;
  private _state: ProcessState = "idle";
  private settings: ClaudeNativeSettings;
  private _sessionId: string | null = null;
  private cwd: string = "";
  private _aborted = false;
  private cliPath: string | null = null;

  // User-selected options (set from UI before sending)
  model: ModelChoice = "sonnet";
  effort: EffortLevel = "high";

  onEvent: ((event: ClaudeEvent) => void) | null = null;
  onStateChange: ((state: ProcessState) => void) | null = null;
  onComplete: (() => void) | null = null;
  onStderr: ((data: string) => void) | null = null;
  /** Permission prompt callback — returns 'allow' | 'deny' | 'always' */
  onPermissionRequest: ((info: {
    toolName: string;
    input: Record<string, unknown>;
    title?: string;
    displayName?: string;
    description?: string;
  }) => Promise<"allow" | "deny" | "always">) | null = null;

  constructor(settings: ClaudeNativeSettings) {
    this.settings = settings;
  }

  get state(): ProcessState {
    return this._state;
  }

  get isRunning(): boolean {
    return this._state === "running";
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  /** Expose the active query for supportedCommands() etc. */
  get query(): Query | null {
    return this.activeQuery;
  }

  updateSettings(settings: ClaudeNativeSettings): void {
    this.settings = settings;
    // Reset cached CLI path if settings changed
    this.cliPath = null;
  }

  /** Build environment variables for the SDK subprocess */
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
   *
   * Return the ChildProcess directly (cast as SpawnedProcess) — it has all
   * required methods including once() from EventEmitter.
   */
  private createCustomSpawn(): (options: SpawnOptions) => SpawnedProcess {
    const enhancedPath = getEnhancedPath();

    return (options: SpawnOptions): SpawnedProcess => {
      let { command } = options;
      let spawnArgs = [...options.args];
      const { cwd, env, signal } = options;

      // Resolve node binary with enhanced PATH (GUI apps have minimal PATH)
      if (command === "node") {
        // Check if first arg is a native binary (not a .js file)
        // Claude CLI can be a Mach-O binary — run it directly, not via node
        if (spawnArgs.length > 0 && !spawnArgs[0].endsWith(".js") && !spawnArgs[0].endsWith(".mjs")) {
          command = spawnArgs[0];
          spawnArgs = spawnArgs.slice(1);
        } else {
          command = findNodeExecutable();
        }
      }

      const child = spawn(command, spawnArgs, {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // DO NOT pass signal — Electron's AbortSignal realm mismatch
      });

      // Manual abort signal handling
      if (signal) {
        if (signal.aborted) {
          child.kill();
        } else {
          signal.addEventListener("abort", () => child.kill(), { once: true });
        }
      }

      // Forward stderr for error detection
      if (child.stderr) {
        child.stderr.on("data", (data: Buffer) => {
          this.onStderr?.(data.toString("utf-8"));
        });
      }

      if (!child.stdin || !child.stdout) {
        throw new Error("Failed to create process streams");
      }

      // Cast ChildProcess directly — it satisfies SpawnedProcess interface
      // (has stdin, stdout, killed, exitCode, kill, on, once from EventEmitter)
      return child as unknown as SpawnedProcess;
    };
  }

  /** Resolve model string and betas for SDK options */
  private resolveModel(): { model: string; betas?: ("context-1m-2025-08-07")[] } {
    const model = this.model || this.settings.defaultModel || "sonnet";
    if (model === "opus[1m]") {
      return { model: "opus", betas: ["context-1m-2025-08-07"] };
    }
    return { model };
  }

  /**
   * Find and cache the Claude CLI path.
   */
  private getCliPath(): string | null {
    if (!this.cliPath) {
      this.cliPath = findClaudeCLIPath(this.settings.cliPath);
    }
    return this.cliPath;
  }

  /** Build SDK query options */
  private buildOptions(): Options {
    const { model, betas } = this.resolveModel();
    const permMode = this.settings.permissionMode || "acceptEdits";
    const cliPath = this.getCliPath();

    this.abortController = new AbortController();

    const options: Options = {
      abortController: this.abortController,
      cwd: this.cwd || undefined,
      env: this.buildEnv(),
      model,
      effort: this.effort || "high",
      permissionMode: permMode,
      pathToClaudeCodeExecutable: cliPath || undefined,
      settingSources: ["user", "project"],
      includePartialMessages: true,
      enableFileCheckpointing: true,
      thinking: { type: "adaptive" },
      spawnClaudeCodeProcess: this.createCustomSpawn(),
      canUseTool: this.onPermissionRequest ? async (toolName, input, opts) => {
        const result = await this.onPermissionRequest!({
          toolName,
          input,
          title: opts.title,
          displayName: opts.displayName,
          description: opts.description,
        });
        if (result === "allow" || result === "always") {
          return {
            behavior: "allow" as const,
            updatedPermissions: result === "always" ? opts.suggestions : undefined,
          };
        }
        return { behavior: "deny" as const, message: "User denied" };
      } : undefined,
    };

    if (betas) {
      options.betas = betas;
    }

    // Always-allowed tools (including all MCP tools)
    const allowed = [
      "Read", "Write", "Edit", "Glob", "Grep", "Agent",
      "Bash(cat*)", "Bash(ls*)", "Bash(head*)", "Bash(tail*)", "Bash(wc*)",
      "Bash(find*)", "Bash(grep*)", "Bash(echo*)", "Bash(mkdir*)", "Bash(cd*)",
      "mcp__arguman__*", "mcp__zettelkasten__*", "mcp__supabase__*",
    ];
    if (this.settings.allowWebRequests) {
      allowed.push("WebFetch", "WebSearch", "Bash(curl*)", "Bash(python3*)", "Bash(open *)");
    }
    options.allowedTools = allowed;

    // Resume existing session
    if (this._sessionId) {
      options.resume = this._sessionId;
    }

    return options;
  }

  /**
   * Start a new SDK query with AsyncIterable prompt.
   * Returns true if successful.
   */
  private async startQuery(): Promise<boolean> {
    // Clean up previous query
    this.closeQuery();

    // Check CLI availability
    const cliPath = this.getCliPath();
    if (!cliPath) {
      console.error("[katmer-code] Claude CLI not found");
      this.onStderr?.("Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code");
      this.setState("error");
      this.onComplete?.();
      return false;
    }

    try {
      this.channel = new UserMessageChannel();
      const options = this.buildOptions();

      this.activeQuery = sdkQuery({
        prompt: this.channel,
        options,
      });

      // Start consuming events in background
      void this.consumeEvents();
      return true;
    } catch (err) {
      console.error("[katmer-code] SDK query start error:", err);
      this.setState("error");
      this.onComplete?.();
      return false;
    }
  }

  /**
   * Background event consumer — iterates over SDK query output.
   */
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
          this.onStderr?.("Not logged in. Please run `claude` in your terminal first to authenticate.");
        }
        this.setState("error");
        this.onComplete?.();
      }
    }
  }

  /**
   * Map SDK message to our ClaudeEvent and forward.
   */
  private handleSDKMessage(msg: SDKMessage): void {
    switch (msg.type) {
      case "system": {
        const sysMsg = msg as SDKSystemMessage | SDKCompactBoundaryMessage;
        if ("subtype" in sysMsg && sysMsg.subtype === "init") {
          const initMsg = sysMsg as SDKSystemMessage;
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
          this.onEvent?.(event);
        }
        if ("subtype" in sysMsg && sysMsg.subtype === "compact_boundary") {
          this.onEvent?.({ type: "system", subtype: "compact_boundary", ...(sysMsg as SDKCompactBoundaryMessage).compact_metadata });
        }
        break;
      }

      case "assistant": {
        const aMsg = msg as SDKAssistantMessage;
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
              cache_read_input_tokens: (aMsg.message?.usage as Record<string, number>)?.cache_read_input_tokens || 0,
              cache_creation_input_tokens: (aMsg.message?.usage as Record<string, number>)?.cache_creation_input_tokens || 0,
            },
          },
          session_id: aMsg.session_id,
          parent_tool_use_id: aMsg.parent_tool_use_id,
        };
        this.onEvent?.(event);
        break;
      }

      case "result": {
        const rMsg = msg as SDKResultSuccess | SDKResultError;
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

        // Attach modelUsage for context window extraction
        if (rMsg.modelUsage) {
          (event as unknown as Record<string, unknown>).modelUsage = rMsg.modelUsage;
        }

        this.onEvent?.(event);
        this.setState("idle");
        this.onComplete?.();
        break;
      }

      case "rate_limit_event": {
        const rlMsg = msg as SDKRateLimitEvent;
        const event: RateLimitEvent = {
          type: "rate_limit_event",
          rate_limit_info: {
            status: rlMsg.rate_limit_info?.status || "allowed",
            resetsAt: rlMsg.rate_limit_info?.resetsAt || 0,
          },
        };
        this.onEvent?.(event);
        break;
      }

      case "stream_event": {
        // Partial streaming — extract text delta for live rendering
        const streamMsg = msg as { type: "stream_event"; event: Record<string, unknown>; parent_tool_use_id: string | null };
        if (streamMsg.parent_tool_use_id) break; // skip subagent streams

        const ev = streamMsg.event;
        if (ev && ev.type === "content_block_delta") {
          const delta = ev.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            const streamEvent: StreamDeltaEvent = {
              type: "stream_delta",
              text: delta.text,
              parent_tool_use_id: streamMsg.parent_tool_use_id,
            };
            this.onEvent?.(streamEvent);
          }
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * Pre-warm the query — start CLI subprocess without sending a message.
   * Makes the first real message instant.
   */
  warmUp(workingDirectory?: string): void {
    if (this.activeQuery) return;
    if (workingDirectory) this.cwd = workingDirectory;
    // Start query but stay in idle state (not "running")
    void this.startQuery().then(() => {
      if (this._state === "running") this.setState("idle");
    });
  }

  /**
   * Send a message to Claude via the SDK query.
   */
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
      void this.startQuery().then((ok) => {
        if (ok) {
          this.channel?.enqueue(userMsg);
        }
      });
    } else {
      this.channel?.enqueue(userMsg);
    }
  }

  /**
   * Abort the current in-flight request.
   */
  abort(): void {
    this._aborted = true;

    // Kill everything — next send() will create a new query
    if (this.activeQuery) {
      this.activeQuery.interrupt().catch(() => {});
    }
    this.abortController?.abort();
    this.channel?.close();
    this.channel = null;
    this.abortController = null;
    this.activeQuery = null;

    this.setState("idle");
    this.onComplete?.();
  }

  /**
   * Reset session — closes query, next message starts fresh.
   */
  newSession(): void {
    this.closeQuery();
    this._sessionId = null;
  }

  setSessionId(id: string): void {
    this.closeQuery();
    this._sessionId = id;
  }

  /**
   * Change model at runtime — uses SDK's setModel() if query is active.
   */
  async setModelRuntime(model: ModelChoice): Promise<void> {
    this.model = model;
    if (this.activeQuery) {
      const { model: modelStr } = this.resolveModel();
      try {
        await this.activeQuery.setModel(modelStr);
      } catch {
        // Next query will use the new model
      }
    }
  }

  /** Close current query and channel */
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
      this.onStateChange?.(state);
    }
  }

  /** Clean up on plugin unload */
  destroy(): void {
    this.closeQuery();
  }
}
