// ── Codex → UnifiedEvent normalizer ──
//
// Translates `codex exec --experimental-json` ThreadEvents
// (sdk/typescript/src/events.ts + items.ts in openai/codex) into the
// Claude-shaped events chat-view consumes.
//
// Caveat: Codex's `file_change` item only carries `{path, kind}` — no
// pre/post text. That means we cannot drive the plugin's inline diff
// from a Codex turn; we surface the change as a tool_use panel instead,
// and the user reloads the file to see what changed.

import type {
  AssistantMessageEvent,
  ContentBlock,
  ResultEvent,
  SystemInitEvent,
} from "../../types";
import type { UnifiedEvent } from "../types";

// ── Codex wire-format types (copied verbatim from openai/codex's
// sdk/typescript so we don't pull the package into the bundle). ──

export type CodexUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
};

export type CodexThreadStarted = { type: "thread.started"; thread_id: string };
export type CodexTurnStarted = { type: "turn.started" };
export type CodexTurnCompleted = { type: "turn.completed"; usage: CodexUsage };
export type CodexTurnFailed = { type: "turn.failed"; error: { message: string } };
export type CodexThreadError = { type: "error"; message: string };

export type CodexCommandExecItem = {
  id: string;
  type: "command_execution";
  command: string;
  aggregated_output: string;
  exit_code?: number;
  status: "in_progress" | "completed" | "failed";
};

export type CodexFileChangeItem = {
  id: string;
  type: "file_change";
  changes: Array<{ path: string; kind: "add" | "delete" | "update" }>;
  status: "completed" | "failed";
};

export type CodexAgentMessageItem = {
  id: string;
  type: "agent_message";
  text: string;
};

export type CodexReasoningItem = {
  id: string;
  type: "reasoning";
  text: string;
};

export type CodexMcpToolCallItem = {
  id: string;
  type: "mcp_tool_call";
  server: string;
  tool: string;
  arguments: unknown;
  result?: { content: unknown[] };
  error?: { message: string };
  status: "in_progress" | "completed" | "failed";
};

export type CodexWebSearchItem = {
  id: string;
  type: "web_search";
  query: string;
};

export type CodexTodoListItem = {
  id: string;
  type: "todo_list";
  items: Array<{ text: string; completed: boolean }>;
};

export type CodexErrorItem = {
  id: string;
  type: "error";
  message: string;
};

export type CodexThreadItem =
  | CodexAgentMessageItem
  | CodexReasoningItem
  | CodexCommandExecItem
  | CodexFileChangeItem
  | CodexMcpToolCallItem
  | CodexWebSearchItem
  | CodexTodoListItem
  | CodexErrorItem;

export type CodexItemStartedEvent = { type: "item.started"; item: CodexThreadItem };
export type CodexItemUpdatedEvent = { type: "item.updated"; item: CodexThreadItem };
export type CodexItemCompletedEvent = { type: "item.completed"; item: CodexThreadItem };

export type CodexThreadEvent =
  | CodexThreadStarted
  | CodexTurnStarted
  | CodexTurnCompleted
  | CodexTurnFailed
  | CodexItemStartedEvent
  | CodexItemUpdatedEvent
  | CodexItemCompletedEvent
  | CodexThreadError;

// ── Normalization ──

interface ParserState {
  sessionId: string;
  model: string;
  /** Tracks which item ids have already been emitted to dedupe started/updated/completed. */
  emittedItems: Set<string>;
}

export function makeParserState(model: string): ParserState {
  return { sessionId: "", model, emittedItems: new Set() };
}

function wrapAssistant(
  block: ContentBlock,
  sessionId: string,
  model: string,
  messageId: string,
): AssistantMessageEvent {
  return {
    type: "assistant",
    message: {
      id: messageId,
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

function itemToBlock(item: CodexThreadItem): ContentBlock | null {
  switch (item.type) {
    case "agent_message":
      return { type: "text", text: item.text };

    case "reasoning":
      return { type: "thinking", thinking: item.text };

    case "command_execution":
      return {
        type: "tool_use",
        id: item.id,
        name: "Bash",
        input: { command: item.command },
      };

    case "file_change": {
      // Render as a synthetic Edit (no diff content — see file header).
      const summary = item.changes
        .map((c) => `${c.kind}: ${c.path}`)
        .join("\n");
      return {
        type: "tool_use",
        id: item.id,
        name: "Edit",
        input: {
          file_path: item.changes[0]?.path || "",
          // Intentionally omit old_string/new_string so chat-view skips
          // the inline-diff path.
          summary,
          status: item.status,
        },
      };
    }

    case "mcp_tool_call":
      return {
        type: "tool_use",
        id: item.id,
        name: `mcp__${item.server}__${item.tool}`,
        input: (item.arguments as Record<string, unknown>) || {},
      };

    case "web_search":
      return {
        type: "tool_use",
        id: item.id,
        name: "WebSearch",
        input: { query: item.query },
      };

    case "todo_list":
      return {
        type: "text",
        text: item.items.map((t) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join("\n"),
      };

    case "error":
      return {
        type: "tool_result",
        id: item.id,
        content: item.message,
        is_error: true,
      };
  }
}

function itemToResultBlock(item: CodexThreadItem): ContentBlock | null {
  // For items where a "completed" payload carries extra info that should
  // appear as a tool_result (Bash output, MCP result), emit a follow-up
  // tool_result block.
  switch (item.type) {
    case "command_execution":
      return {
        type: "tool_result",
        id: item.id,
        content: item.aggregated_output || "",
        is_error: item.status === "failed",
      };
    case "mcp_tool_call": {
      if (item.error) {
        return {
          type: "tool_result",
          id: item.id,
          content: item.error.message,
          is_error: true,
        };
      }
      if (item.result) {
        const text = (item.result.content as Array<{ text?: string }>)
          ?.map((c) => c?.text || "")
          .join("\n") || "";
        return {
          type: "tool_result",
          id: item.id,
          content: text,
          is_error: false,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

export function normalizeCodexEvent(
  raw: CodexThreadEvent,
  state: ParserState,
): UnifiedEvent[] {
  switch (raw.type) {
    case "thread.started": {
      state.sessionId = raw.thread_id;
      const sys: SystemInitEvent = {
        type: "system",
        subtype: "init",
        session_id: raw.thread_id,
        model: state.model,
        tools: [],
        mcp_servers: [],
        claude_code_version: "codex",
      };
      return [sys];
    }

    case "turn.started":
      return [];

    case "turn.completed": {
      const result: ResultEvent = {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 0,
        result: "",
        total_cost_usd: 0,
        session_id: state.sessionId,
        usage: {
          input_tokens: raw.usage.input_tokens,
          output_tokens: raw.usage.output_tokens,
          cache_read_input_tokens: raw.usage.cached_input_tokens,
          cache_creation_input_tokens: 0,
        },
      };
      return [result];
    }

    case "turn.failed": {
      const result: ResultEvent = {
        type: "result",
        subtype: "error",
        is_error: true,
        duration_ms: 0,
        result: raw.error.message,
        total_cost_usd: 0,
        session_id: state.sessionId,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
      return [result];
    }

    case "error": {
      // Fatal stream error — surface as a failed result.
      const result: ResultEvent = {
        type: "result",
        subtype: "error",
        is_error: true,
        duration_ms: 0,
        result: raw.message,
        total_cost_usd: 0,
        session_id: state.sessionId,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      };
      return [result];
    }

    case "item.started": {
      // Emit only items chat-view cares about — agent_message text is
      // emitted on completion to avoid double-rendering partial drafts.
      if (raw.item.type === "agent_message") return [];
      const block = itemToBlock(raw.item);
      if (!block) return [];
      if (state.emittedItems.has(raw.item.id)) return [];
      state.emittedItems.add(raw.item.id);
      return [wrapAssistant(block, state.sessionId, state.model, raw.item.id)];
    }

    case "item.updated":
      // Skip — chat-view handles tool state via the completed event.
      return [];

    case "item.completed": {
      const item = raw.item;
      const events: UnifiedEvent[] = [];

      if (item.type === "agent_message") {
        const block = itemToBlock(item);
        if (block) events.push(wrapAssistant(block, state.sessionId, state.model, item.id));
      } else {
        // For Bash / MCP: ensure the original tool_use was emitted
        // (item.started may have been collapsed when in_progress was
        // skipped), then send the tool_result follow-up.
        if (!state.emittedItems.has(item.id)) {
          const startBlock = itemToBlock(item);
          if (startBlock) {
            events.push(wrapAssistant(startBlock, state.sessionId, state.model, item.id));
            state.emittedItems.add(item.id);
          }
        }
        const resultBlock = itemToResultBlock(item);
        if (resultBlock) {
          events.push(wrapAssistant(resultBlock, state.sessionId, state.model, `${item.id}-result`));
        }
      }
      return events;
    }

    default:
      return [];
  }
}
