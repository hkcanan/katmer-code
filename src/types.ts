// ── Claude Code stream-json event types ──

export interface SystemInitEvent {
  type: "system";
  subtype: "init";
  session_id: string;
  model: string;
  tools: string[];
  mcp_servers: Array<{ name: string; status: string }>;
  claude_code_version: string;
}

export interface AssistantMessageEvent {
  type: "assistant";
  message: {
    id: string;
    model: string;
    role: "assistant";
    content: ContentBlock[];
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  session_id: string;
  /** null = main agent, string = subagent tool_use_id */
  parent_tool_use_id?: string | null;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export interface ResultEvent {
  type: "result";
  subtype: "success" | "error";
  is_error: boolean;
  duration_ms: number;
  result: string;
  total_cost_usd: number;
  session_id: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface RateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: {
    status: string;
    resetsAt: number;
  };
}

export interface StreamDeltaEvent {
  type: "stream_delta";
  /** Incrementally growing text for the current text block */
  text: string;
  /** Whether this is a subagent stream */
  parent_tool_use_id?: string | null;
}

export type ClaudeEvent =
  | SystemInitEvent
  | AssistantMessageEvent
  | ResultEvent
  | RateLimitEvent
  | StreamDeltaEvent
  | { type: string; [key: string]: unknown };

// ── UI State ──

export type ContentSegment =
  | { type: "text"; text: string; fromStream?: boolean }
  | { type: "tool"; tool: ToolCallInfo };

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: ToolCallInfo[];
  /** Ordered content blocks preserving text ↔ tool interleaving */
  segments?: ContentSegment[];
  timestamp: number;
  isStreaming?: boolean;
  /** Attached context shown in user message bubble */
  attachments?: Array<{ type: "selection" | "file"; name: string; preview?: string }>;
  /**
   * Auto-generated synthesis prompt sent after consulting another model.
   * Render as a compact pill instead of a full user bubble — the user
   * didn't actually type this, it's a system follow-up.
   */
  synthesisMeta?: {
    consultedProvider: ProviderId;
    consultedLabel: string;
  };
  /**
   * Inline marker for mid-conversation model/provider switches. The
   * message itself has role:"system" and renders as a horizontal
   * divider so the user can see exactly when the backend changed.
   */
  switchMeta?: {
    kind: "model" | "provider";
    fromProvider: ProviderId;
    fromModel: string;
    toProvider: ProviderId;
    toModel: string;
    /** Provider switches break conversation context — flag for warning UI. */
    contextLost: boolean;
  };
}

export interface ToolCallInfo {
  id: string;
  name: string;
  input: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  duration?: number;
  startTime?: number;
}

export interface SessionInfo {
  sessionId: string;
  model: string;
  mcpServers: Array<{ name: string; status: string }>;
  cliVersion: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

// ── Model & Effort ──

export type ModelChoice = "opus" | "opus[1m]" | "sonnet" | "haiku";
export type EffortLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const MODEL_LABELS: Record<ModelChoice, string> = {
  "opus[1m]": "Opus 1M",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

// ── Session History ──

export interface SavedSession {
  sessionId: string;
  firstMessage: string;
  model: string;
  timestamp: number;
  messageCount: number;
  messages: ChatMessage[];
}

// ── Settings ──

// ── Skills ──

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  category: "research" | "writing" | "analysis" | "transform";
  fileName: string;  // e.g. "peer-review.md"
}

export const SKILL_CATALOG: SkillDef[] = [
  // Research
  { id: "lit-search", name: "/lit-search", description: "Multi-database literature search", category: "research", fileName: "lit-search.md" },
  { id: "citation-network", name: "/citation-network", description: "Citation graph analysis + visualization", category: "research", fileName: "citation-network.md" },
  { id: "research-gap", name: "/research-gap", description: "Research gap analysis + trends", category: "research", fileName: "research-gap.md" },
  // Writing
  { id: "peer-review", name: "/peer-review", description: "Academic peer review (8 criteria)", category: "writing", fileName: "peer-review.md" },
  { id: "cite-verify", name: "/cite-verify", description: "Citation verification via DOI/CrossRef", category: "writing", fileName: "cite-verify.md" },
  { id: "abstract", name: "/abstract", description: "Generate abstract (5 formats, bilingual)", category: "writing", fileName: "abstract.md" },
  // Analysis
  { id: "journal-match", name: "/journal-match", description: "Journal recommendation for manuscript", category: "analysis", fileName: "journal-match.md" },
  // Design system (auto-installed with any skill)
  { id: "report-template", name: "/report-template", description: "Report design system (academic book aesthetic)", category: "transform", fileName: "report-template.md" },
];

export const CATEGORY_LABELS: Record<string, string> = {
  research: "Research",
  writing: "Writing & editing",
  analysis: "Analysis",
  transform: "Transform",
};

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export type ProviderId = "claude" | "gemini" | "codex" | "antigravity";

export interface ProviderConfig {
  /** Optional CLI path override; empty = auto-detect. */
  cliPath: string;
}

/** Long-form labels — used in headers, settings, badges. */
export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: "Claude Code",
  gemini: "Gemini",
  codex: "Codex",
  antigravity: "Antigravity",
};

/** Compact labels for narrow contexts (picker tabs, tab strip). */
export const PROVIDER_LABELS_SHORT: Record<ProviderId, string> = {
  claude: "Claude",
  gemini: "Gemini",
  codex: "Codex",
  antigravity: "Antigrav.",
};

export interface ModelOption {
  /** Wire identifier passed to the adapter. */
  id: string;
  /** Short label for the model picker. */
  label: string;
  /** Hint shown under the label. */
  desc: string;
  /** Max input tokens the model accepts. Used to fill the context strip
   *  when the provider's own result event doesn't carry a window value. */
  contextWindow?: number;
}

/**
 * Model menus shown per provider. The first entry of each provider is the
 * default selection when switching to that provider for the first time.
 */
export const PROVIDER_MODELS: Record<ProviderId, ModelOption[]> = {
  claude: [
    { id: "claude-fable-5-1", label: "Fable 5.1", desc: "Anthropic flagship model", contextWindow: 1_000_000 },
    { id: "claude-fable-5", label: "Fable 5", desc: "Active Anthropic model", contextWindow: 1_000_000 },
    { id: "claude-opus-5", label: "Opus 5", desc: "Most capable Claude model", contextWindow: 1_000_000 },
    { id: "claude-opus-4-8", label: "Opus 4.8", desc: "Previous-generation flagship", contextWindow: 1_000_000 },
    { id: "claude-opus-4-7", label: "Opus 4.7", desc: "Previous-generation flagship", contextWindow: 1_000_000 },
    { id: "claude-opus-4-6", label: "Opus 4.6", desc: "Previous-generation flagship", contextWindow: 1_000_000 },
    { id: "claude-opus-4-5-20251101", label: "Opus 4.5", desc: "Active dated model", contextWindow: 200_000 },
    { id: "claude-sonnet-5", label: "Sonnet 5", desc: "High-performance Claude model", contextWindow: 1_000_000 },
    { id: "claude-sonnet-4-6", label: "Sonnet 4.6", desc: "High-performance and efficient", contextWindow: 1_000_000 },
    { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5", desc: "Active dated model", contextWindow: 200_000 },
    { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5", desc: "Fast and efficient", contextWindow: 200_000 },
    { id: "opus[1m]", label: "Opus 1M", desc: "Most capable, 1M extended context", contextWindow: 1_000_000 },
    { id: "opus", label: "Opus", desc: "Most capable, 200K context", contextWindow: 200_000 },
    { id: "sonnet", label: "Sonnet", desc: "Balanced for everyday tasks", contextWindow: 200_000 },
    { id: "haiku", label: "Haiku", desc: "Fastest for quick answers", contextWindow: 200_000 },
  ],
  gemini: [
    { id: "gemini-3.8-flash", label: "3.8 Flash", desc: "Latest stable, long-horizon and agentic work", contextWindow: 1_000_000 },
    { id: "gemini-3.7-flash", label: "3.7 Flash", desc: "Stable coding and agentic workflows", contextWindow: 1_000_000 },
    { id: "gemini-3.6-flash", label: "3.6 Flash", desc: "Stable speed and multimodal capability", contextWindow: 1_000_000 },
    { id: "gemini-3.5-flash", label: "3.5 Flash", desc: "Stable general-purpose Flash model", contextWindow: 1_000_000 },
    { id: "gemini-3.5-flash-lite", label: "3.5 Flash Lite", desc: "Fastest, cost-sensitive tier", contextWindow: 1_000_000 },
    // Models exposed by Gemini CLI's /model picker. 3.x family requires
    // Google AI Pro (Google One) or paid tier; 2.5 family works on free
    // accounts too. Verified by querying the live CLI.
    { id: "gemini-3.1-pro-preview", label: "3.1 Pro Preview", desc: "Latest, complex reasoning (AI Pro)", contextWindow: 1_048_576 },
    { id: "gemini-3-flash-preview", label: "3 Flash Preview", desc: "Fast preview tier (AI Pro)", contextWindow: 1_000_000 },
    { id: "gemini-3.1-flash-lite-preview", label: "3.1 Flash Lite Preview", desc: "Lightest preview tier", contextWindow: 1_000_000 },
    { id: "gemini-2.5-pro", label: "2.5 Pro", desc: "Stable, 1M context", contextWindow: 1_048_576 },
    { id: "gemini-2.5-flash", label: "2.5 Flash", desc: "Fast and balanced", contextWindow: 1_048_576 },
    { id: "gemini-2.5-flash-lite", label: "Flash Lite", desc: "Fastest, lightweight", contextWindow: 1_000_000 },
  ],
  codex: [
    { id: "gpt-6-astra", label: "GPT-6 Astra", desc: "Most capable, complex reasoning and coding", contextWindow: 1_050_000 },
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", desc: "Flagship model for complex professional work", contextWindow: 1_050_000 },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", desc: "Balanced intelligence and cost", contextWindow: 1_050_000 },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", desc: "Cost-sensitive, high-volume workloads", contextWindow: 1_050_000 },
    { id: "gpt-5.5", label: "GPT-5.5", desc: "Current flagship, complex coding", contextWindow: 400_000 },
    { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", desc: "Codex-mini, faster for subagents", contextWindow: 128_000 },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex", desc: "Previous codex generation", contextWindow: 400_000 },
    { id: "gpt-5.4", label: "GPT-5.4", desc: "Previous pro tier", contextWindow: 400_000 },
  ],
  antigravity: [
    // Antigravity CLI v1.0.2 is hard-coded to Gemini 3.5 Flash; no model
    // selection flag yet. Single entry so the picker isn't empty.
    { id: "gemini-3.5-flash", label: "3.5 Flash", desc: "Antigravity-only (subscription)", contextWindow: 1_000_000 },
  ],
};

/** Look up a model's context window from the catalog, with sensible
 *  fallback for unknown ids. */
export function lookupContextWindow(providerId: ProviderId, modelId: string): number {
  const models = PROVIDER_MODELS[providerId] || [];
  const found = models.find((m) => m.id === modelId);
  return found?.contextWindow || 200_000;
}

export const PROVIDER_INSTALL_HINTS: Record<ProviderId, string> = {
  claude: "npm install -g @anthropic-ai/claude-code && claude",
  gemini: "npm install -g @google/gemini-cli && gemini",
  codex: "npm install -g @openai/codex && codex login",
  antigravity: "curl -fsSL https://antigravity.google/cli/install.sh | bash && agy",
};

export interface ClaudeNativeSettings {
  /** Claude CLI path (legacy; per-provider overrides live in `providers`). */
  cliPath: string;
  workingDirectory: string;
  defaultModel: ModelChoice;
  permissionMode: PermissionMode;
  allowWebRequests: boolean;
  maxScrollback: number;
  showToolCalls: boolean;
  showCostInfo: boolean;
  sessions: SavedSession[];
  enabledSkills: string[];  // skill IDs
  /** Which backend handles chat by default. */
  defaultProvider: ProviderId;
  /** Per-provider overrides — CLI path, auth hints, etc. */
  providers: Record<ProviderId, ProviderConfig>;
  /** Mirror ~/CLAUDE.md to ~/.gemini/GEMINI.md + ~/.codex/AGENTS.md so
   *  the same instructions reach every provider. */
  mirrorClaudeMd: boolean;
}

export const DEFAULT_SETTINGS: ClaudeNativeSettings = {
  cliPath: "claude",
  workingDirectory: "",
  defaultModel: "sonnet",
  permissionMode: "acceptEdits",
  allowWebRequests: false,
  maxScrollback: 200,
  showToolCalls: true,
  showCostInfo: true,
  sessions: [],
  enabledSkills: [],
  defaultProvider: "claude",
  providers: {
    claude: { cliPath: "" },
    gemini: { cliPath: "" },
    codex: { cliPath: "" },
    antigravity: { cliPath: "" },
  },
  mirrorClaudeMd: false,
};
