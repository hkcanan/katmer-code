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
  | { type: "text"; text: string }
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
export type EffortLevel = "low" | "medium" | "high" | "max";

export const MODEL_LABELS: Record<ModelChoice, string> = {
  "opus[1m]": "Opus 1M",
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
};

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Med",
  high: "High",
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

export interface ClaudeNativeSettings {
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
};
