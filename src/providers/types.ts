// ── Provider abstraction layer ──
//
// Every backend (Claude, Gemini, Codex) implements ProviderAdapter and emits
// UnifiedEvent — which is currently a re-export of the Claude stream-json
// shape, since that's what chat-view was built around. Non-Claude adapters
// translate their native event shape into this format inside a normalizer.

import type {
  ClaudeEvent,
  ClaudeNativeSettings,
  EffortLevel,
  ProviderId,
} from "../types";

export type { ProviderId };

export type ProcessState = "idle" | "running" | "error";

/** Wire format consumed by chat-view — Claude's stream-json shape. */
export type UnifiedEvent = ClaudeEvent;

export interface PermissionPromptInfo {
  toolName: string;
  input: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
}

export type PermissionDecision = "allow" | "deny" | "always";

export interface ProviderCallbacks {
  onEvent?: ((event: UnifiedEvent) => void) | null;
  onStateChange?: ((state: ProcessState) => void) | null;
  onComplete?: (() => void) | null;
  onStderr?: ((data: string) => void) | null;
  onPermissionRequest?:
    | ((info: PermissionPromptInfo) => Promise<PermissionDecision>)
    | null;
}

export interface CliInfo {
  found: boolean;
  path?: string;
  version?: string;
  error?: string;
  /** True if the user has authenticated with the provider's CLI. */
  authenticated?: boolean;
  /** Shell command to run if not authenticated (e.g. `codex login`). */
  loginHint?: string;
}

/**
 * Common contract for every backend the plugin can drive.
 *
 * Lifecycle mirrors ProcessManager so the existing chat-view code base
 * doesn't need to learn a new shape.
 */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly state: ProcessState;
  readonly sessionId: string | null;
  readonly isRunning: boolean;

  /** Provider-specific model identifier (e.g. "sonnet", "gemini-2.5-pro"). */
  model: string;
  effort: EffortLevel;

  setCallbacks(callbacks: ProviderCallbacks): void;
  updateSettings(settings: ClaudeNativeSettings): void;

  warmUp(workingDirectory?: string): void;
  send(message: string, workingDirectory?: string): void;
  abort(): void;
  newSession(): void;
  setSessionId(id: string): void;
  setModelRuntime(model: string): Promise<void>;
  destroy(): void;

  detectCli(): CliInfo;

  /**
   * Kick off the provider's login flow. Implementations either spawn a
   * subprocess (Claude / Codex have `auth login` commands) or open the
   * user's terminal with the right command (Gemini / Antigravity are
   * interactive TUIs). Resolves with success when the underlying flow
   * completes — or returns `manual: true` when the user has to finish
   * the flow in another window.
   */
  triggerLogin?(): Promise<{ success: boolean; manual?: boolean; reason?: string }>;

  /**
   * Discover slash commands the active session knows about.
   * Returns empty array when the backend has no such concept.
   */
  getSupportedCommands(): Promise<Array<{ name: string; description?: string }>>;

  /**
   * Optional raw query handle (Claude SDK exposes one for /command discovery).
   * Other adapters can return undefined.
   */
  readonly query?: unknown;
}
