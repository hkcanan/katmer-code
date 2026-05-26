import type {
  ClaudeEvent,
  ClaudeNativeSettings,
  ModelChoice,
  EffortLevel,
} from "./types";

import { createProvider } from "./providers";
import type {
  ProviderAdapter,
  ProviderId,
  ProcessState,
  PermissionPromptInfo,
  PermissionDecision,
} from "./providers";

export type { ProcessState };

/**
 * ProcessManager — backend-agnostic facade.
 *
 * Holds a single ProviderAdapter (Claude / Gemini / Codex). Chat-view talks
 * to this class without caring which backend is active; switching providers
 * tears down the current adapter and constructs a fresh one.
 */
export class ProcessManager {
  private settings: ClaudeNativeSettings;
  private adapter: ProviderAdapter;
  private _providerId: ProviderId;
  private _model: ModelChoice = "sonnet";
  private _effort: EffortLevel = "high";

  onEvent: ((event: ClaudeEvent) => void) | null = null;
  onStateChange: ((state: ProcessState) => void) | null = null;
  onComplete: (() => void) | null = null;
  onStderr: ((data: string) => void) | null = null;
  onPermissionRequest:
    | ((info: PermissionPromptInfo) => Promise<PermissionDecision>)
    | null = null;

  constructor(settings: ClaudeNativeSettings, providerId: ProviderId = "claude") {
    this.settings = settings;
    this._providerId = providerId;
    this.adapter = this.buildAdapter(providerId);
  }

  // ── Public accessors that proxy to the active adapter ──

  get providerId(): ProviderId { return this._providerId; }
  get state(): ProcessState { return this.adapter.state; }
  get isRunning(): boolean { return this.adapter.isRunning; }
  get sessionId(): string | null { return this.adapter.sessionId; }
  get query(): unknown { return this.adapter.query; }

  get model(): ModelChoice { return this._model; }
  set model(v: ModelChoice) {
    this._model = v;
    this.adapter.model = v;
  }

  get effort(): EffortLevel { return this._effort; }
  set effort(v: EffortLevel) {
    this._effort = v;
    this.adapter.effort = v;
  }

  // ── Lifecycle ──

  updateSettings(settings: ClaudeNativeSettings): void {
    this.settings = settings;
    this.adapter.updateSettings(settings);
  }

  /** Swap providers — tears the current one down and starts fresh. */
  setProvider(id: ProviderId): void {
    if (id === this._providerId) return;
    this.adapter.destroy();
    this._providerId = id;
    this.adapter = this.buildAdapter(id);
  }

  warmUp(workingDirectory?: string): void {
    this.adapter.warmUp(workingDirectory);
  }

  send(message: string, workingDirectory?: string): void {
    this.adapter.send(message, workingDirectory);
  }

  abort(): void {
    this.adapter.abort();
  }

  newSession(): void {
    this.adapter.newSession();
  }

  setSessionId(id: string): void {
    this.adapter.setSessionId(id);
  }

  async setModelRuntime(model: ModelChoice): Promise<void> {
    this._model = model;
    await this.adapter.setModelRuntime(model);
  }

  destroy(): void {
    this.adapter.destroy();
  }

  /** Discover slash commands the active session exposes. */
  getSupportedCommands(): Promise<Array<{ name: string; description?: string }>> {
    return this.adapter.getSupportedCommands();
  }

  // ── Internals ──

  private buildAdapter(id: ProviderId): ProviderAdapter {
    const adapter = createProvider(id, this.settings);
    adapter.model = this._model;
    adapter.effort = this._effort;
    adapter.setCallbacks({
      onEvent: (e) => this.onEvent?.(e),
      onStateChange: (s) => this.onStateChange?.(s),
      onComplete: () => this.onComplete?.(),
      onStderr: (d) => this.onStderr?.(d),
      // Always supply the bridge — adapter checks for `undefined` to decide
      // whether to engage permission flow at all, so we synthesize a denial
      // when the host plugin hasn't wired one up yet.
      onPermissionRequest: (info) =>
        this.onPermissionRequest
          ? this.onPermissionRequest(info)
          : Promise.resolve("deny" as const),
    });
    return adapter;
  }
}
