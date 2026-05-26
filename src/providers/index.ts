import type { ClaudeNativeSettings } from "../types";
import type { ProviderAdapter, ProviderId } from "./types";
import { ClaudeAdapter } from "./claude";
import { GeminiAdapter } from "./gemini";
import { CodexAdapter } from "./codex";
import { AntigravityAdapter } from "./antigravity";

export type { ProviderAdapter, ProviderId, UnifiedEvent, ProcessState, ProviderCallbacks, PermissionPromptInfo, PermissionDecision, CliInfo } from "./types";
export { ClaudeAdapter } from "./claude";
export { GeminiAdapter } from "./gemini";
export { CodexAdapter } from "./codex";
export { AntigravityAdapter } from "./antigravity";

/** Build a provider adapter by ID. */
export function createProvider(id: ProviderId, settings: ClaudeNativeSettings): ProviderAdapter {
  switch (id) {
    case "claude":
      return new ClaudeAdapter(settings);
    case "gemini":
      return new GeminiAdapter(settings);
    case "codex":
      return new CodexAdapter(settings);
    case "antigravity":
      return new AntigravityAdapter(settings);
    default:
      return new ClaudeAdapter(settings);
  }
}
