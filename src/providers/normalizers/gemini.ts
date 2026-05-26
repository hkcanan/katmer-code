// ── Gemini → UnifiedEvent normalizer ──
//
// Translates Gemini CLI stream-json events
// (packages/core/src/output/types.ts) into the Claude-shaped events the
// chat-view was originally built around. The point of this layer is to
// keep chat-view ignorant of which backend produced the stream.

import type {
  AssistantMessageEvent,
  ContentBlock,
  ResultEvent,
  StreamDeltaEvent,
  SystemInitEvent,
} from "../../types";
import type { UnifiedEvent } from "../types";

// ── Gemini wire-format types (copied from gemini-cli's
// packages/core/src/output/types.ts so we don't pull the package in just
// for types). Keep in sync with upstream. ──

export type GeminiStreamEventType =
  | "init"
  | "message"
  | "tool_use"
  | "tool_result"
  | "error"
  | "result";

export interface GeminiInitEvent {
  type: "init";
  timestamp: string;
  session_id: string;
  model: string;
}

export interface GeminiMessageEvent {
  type: "message";
  timestamp: string;
  role: "user" | "assistant";
  content: string;
  delta?: boolean;
}

export interface GeminiToolUseEvent {
  type: "tool_use";
  timestamp: string;
  tool_name: string;
  tool_id: string;
  parameters: Record<string, unknown>;
}

export interface GeminiToolResultEvent {
  type: "tool_result";
  timestamp: string;
  tool_id: string;
  status: "success" | "error";
  output?: string;
  error?: { type: string; message: string };
}

export interface GeminiErrorEvent {
  type: "error";
  timestamp: string;
  severity: "warning" | "error";
  message: string;
}

export interface GeminiResultEvent {
  type: "result";
  timestamp: string;
  status: "success" | "error";
  error?: { type: string; message: string };
  stats?: {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cached: number;
    input: number;
    duration_ms: number;
    tool_calls: number;
    models: Record<string, unknown>;
  };
}

export type GeminiStreamEvent =
  | GeminiInitEvent
  | GeminiMessageEvent
  | GeminiToolUseEvent
  | GeminiToolResultEvent
  | GeminiErrorEvent
  | GeminiResultEvent;

// ── Tool name + parameter aliasing ──
//
// chat-view branches on specific tool names ("Edit", "Read", "Write",
// "Bash"). Gemini uses snake_case names; map to Claude-style PascalCase so
// the existing UI branches still match.

// Source: gemini-cli/packages/core/src/tools/definitions/base-declarations.ts
const TOOL_NAME_ALIAS: Record<string, string> = {
  read_file: "Read",
  replace: "Edit",            // Gemini's actual edit tool is called "replace"
  edit_file: "Edit",          // legacy alias just in case
  write_file: "Write",
  run_shell_command: "Bash",
  shell: "Bash",
  grep_search: "Grep",
  grep: "Grep",
  glob: "Glob",
  list_directory: "LS",
  web_fetch: "WebFetch",
  google_web_search: "WebSearch",
  web_search: "WebSearch",
  read_many_files: "Read",
};

/** Normalize Gemini tool input keys to the names chat-view checks. */
function normalizeToolInput(
  toolName: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params };

  // Edit / Read / Write: chat-view reads `file_path`. Gemini sometimes uses
  // `path` or `absolute_path` for read/write; edit_file already matches.
  if (toolName === "Read" || toolName === "Edit" || toolName === "Write") {
    if (typeof out.file_path !== "string") {
      if (typeof out.absolute_path === "string") out.file_path = out.absolute_path;
      else if (typeof out.path === "string") out.file_path = out.path;
    }
  }

  // Bash: chat-view reads `command`. Gemini uses `command` already; just
  // pass through.
  return out;
}

/** Convert one Gemini tool_use event into a Claude-style content block. */
export function toolUseBlock(ev: GeminiToolUseEvent): ContentBlock {
  const name = TOOL_NAME_ALIAS[ev.tool_name] || ev.tool_name;
  return {
    type: "tool_use",
    id: ev.tool_id,
    name,
    input: normalizeToolInput(name, ev.parameters || {}),
  };
}

/** Wrap a tool_use block in an assistant message envelope. */
export function toolUseEnvelope(
  ev: GeminiToolUseEvent,
  sessionId: string,
  model: string,
): AssistantMessageEvent {
  return {
    type: "assistant",
    message: {
      id: ev.tool_id,
      model,
      role: "assistant",
      content: [toolUseBlock(ev)],
      stop_reason: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    session_id: sessionId,
    parent_tool_use_id: null,
  };
}

/**
 * Strip Gemini's internal reasoning markers (`[Thought: true]`,
 * `[Thought: false]`) from a chunk of text. These leak into the
 * assistant message stream and confuse the chat UI.
 */
function cleanGeminiText(text: string): string {
  return text
    .replace(/\[Thought:\s*(true|false)\]\s*/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

/** Wrap a finalized message (non-delta) as an assistant envelope. */
export function messageEnvelope(
  ev: GeminiMessageEvent,
  sessionId: string,
  model: string,
): AssistantMessageEvent {
  return {
    type: "assistant",
    message: {
      id: `gemini-${ev.timestamp}`,
      model,
      role: "assistant",
      content: [{ type: "text", text: cleanGeminiText(ev.content) }],
      stop_reason: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    session_id: sessionId,
    parent_tool_use_id: null,
  };
}

/** Tool result fed back as an assistant envelope so chat-view picks it up. */
export function toolResultEnvelope(
  ev: GeminiToolResultEvent,
  sessionId: string,
  model: string,
): AssistantMessageEvent {
  const block: ContentBlock = {
    type: "tool_result",
    id: ev.tool_id,
    content: ev.output || ev.error?.message || "",
    is_error: ev.status === "error",
  };
  return {
    type: "assistant",
    message: {
      id: `tr-${ev.tool_id}`,
      model,
      role: "assistant",
      content: [block],
      stop_reason: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    session_id: sessionId,
    parent_tool_use_id: null,
  };
}

export function initToSystem(ev: GeminiInitEvent): SystemInitEvent {
  return {
    type: "system",
    subtype: "init",
    session_id: ev.session_id,
    model: ev.model,
    tools: [],
    mcp_servers: [],
    claude_code_version: "gemini",
  };
}

export function resultToResult(
  ev: GeminiResultEvent,
  sessionId: string,
): ResultEvent {
  const stats = ev.stats;
  return {
    type: "result",
    subtype: ev.status,
    is_error: ev.status === "error",
    duration_ms: stats?.duration_ms || 0,
    result: ev.error?.message || "",
    total_cost_usd: 0,
    session_id: sessionId,
    usage: {
      input_tokens: stats?.input_tokens || 0,
      output_tokens: stats?.output_tokens || 0,
      cache_read_input_tokens: stats?.cached || 0,
      cache_creation_input_tokens: 0,
    },
  };
}

export function messageDelta(ev: GeminiMessageEvent): StreamDeltaEvent {
  return {
    type: "stream_delta",
    text: cleanGeminiText(ev.content),
    parent_tool_use_id: null,
  };
}

/**
 * Lightweight emit shape — the adapter calls this for every parsed line.
 * Returns the UnifiedEvent(s) that should be forwarded, or [] for events
 * we want to drop (e.g. user-echo messages).
 */
export function normalizeGeminiEvent(
  raw: GeminiStreamEvent,
  state: { sessionId: string; model: string },
): UnifiedEvent[] {
  switch (raw.type) {
    case "init":
      state.sessionId = raw.session_id;
      state.model = raw.model;
      return [initToSystem(raw)];

    case "message":
      // Drop user echoes; chat-view already rendered the outbound message.
      if (raw.role === "user") return [];
      if (raw.delta) return [messageDelta(raw)];
      return [messageEnvelope(raw, state.sessionId, state.model)];

    case "tool_use":
      return [toolUseEnvelope(raw, state.sessionId, state.model)];

    case "tool_result":
      return [toolResultEnvelope(raw, state.sessionId, state.model)];

    case "error":
      // Warnings are surfaced via onStderr in the adapter; nothing to emit
      // into the chat stream itself.
      return [];

    case "result":
      return [resultToResult(raw, state.sessionId)];

    default:
      return [];
  }
}
