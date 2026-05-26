import { ItemView, MarkdownRenderer, WorkspaceLeaf, setIcon, TFile, Notice } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
  addChange, acceptChange, acceptAllChanges, rejectAllChanges, rejectSingleChange,
  goToNextChange, goToPreviousChange, getChangeSummary,
  changeRegistry,
  type InlineChange,
} from "./editor-extension";
import { ProcessManager } from "./process-manager";
import { createProvider } from "./providers";
import { execFile } from "child_process";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { writeFileSync, readFileSync } from "fs";
import type {
  ClaudeEvent,
  AssistantMessageEvent,
  SystemInitEvent,
  ResultEvent,
  StreamDeltaEvent,
  ChatMessage,
  ToolCallInfo,
  SessionInfo,
  ClaudeNativeSettings,
  ModelChoice,
  EffortLevel,
  SavedSession,
  ProviderId,
} from "./types";
import { MODEL_LABELS, EFFORT_LABELS, SKILL_CATALOG, PROVIDER_LABELS, PROVIDER_LABELS_SHORT, PROVIDER_MODELS, lookupContextWindow } from "./types";

/** Get file path from Electron webUtils or legacy File.path */
function getFilePathFromFile(f: File): string | undefined {
  try {
    const electron = (window as unknown as { require: (m: string) => Record<string, unknown> }).require("electron");
    const webUtils = electron.webUtils as { getPathForFile(f: File): string };
    return webUtils.getPathForFile(f);
  } catch {
    return (f as File & { path?: string }).path;
  }
}

export const VIEW_TYPE_CLAUDE = "claude-native-chat";

/** State for a single tab/conversation */
interface TabState {
  id: string;
  title: string;
  messages: ChatMessage[];
  session: SessionInfo | null;
  sessionId: string | null;
  firstMessageText: string;
  turnCount: number;
  pm: ProcessManager;
  /** Queued permission requests for background tabs */
  pendingPermissions: Array<{
    info: { toolName: string; input: Record<string, unknown>; title?: string; displayName?: string; description?: string };
    resolve: (result: "allow" | "deny" | "always") => void;
  }>;
}

export class ClaudeChatView extends ItemView {
  private pm: ProcessManager;
  private settings: ClaudeNativeSettings;
  private messages: ChatMessage[] = [];
  private session: SessionInfo | null = null;

  // Tabs
  private tabs: TabState[] = [];
  private activeTabId: string = "";
  private tabBarEl!: HTMLElement;

  // DOM refs
  private chatContainer!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLElement;
  private statusBar!: HTMLElement;
  private newSessionBtn!: HTMLElement;
  private abortBtn!: HTMLElement;
  private emptyState!: HTMLElement;
  private contextBar!: HTMLElement;
  private diffBar!: HTMLElement;
  private diffBarLabel!: HTMLElement;
  private diffBarFilePath: string = "";
  private contextLabel!: HTMLElement;
  private modelBtns!: Record<ModelChoice, HTMLElement>;
  private effortBtns!: Record<EffortLevel, HTMLElement>;
  private _stopBtn!: HTMLElement;
  private providerBadge!: HTMLElement;
  private triggerProviderEl!: HTMLElement;
  private modelTriggerLabel!: HTMLElement;
  private modelPopup!: HTMLElement;
  private providerTabsContainer!: HTMLElement;
  private modelListContainer!: HTMLElement;
  private effortContainer!: HTMLElement;
  /** Track last-used model per provider so switching back restores choice. */
  private thinkingPlaceholder: HTMLElement | null = null;
  private modelByProvider: Record<ProviderId, string> = {
    claude: "sonnet",
    gemini: "gemini-3.1-pro-preview",
    codex: "gpt-5.5",
    antigravity: "gemini-3.5-flash",
  };
  /**
   * CLI detection cache. Calling `detectCli()` spawns `which` and walks
   * the filesystem — running it for 4 providers on every popup open or
   * tab switch made the picker feel laggy. Cache once, invalidate when
   * settings change.
   */
  private cliProbeCache = new Map<ProviderId, { found: boolean; path?: string; authenticated?: boolean; loginHint?: string }>();

  // Attached context (selected text from editor)
  private attachedContext: { fileName: string; text: string } | null = null;
  private contextCardEl: HTMLElement | null = null;

  // Skill/command autocomplete
  private skillPopup: HTMLElement | null = null;
  private skillSelectedIdx = 0;
  private sdkCommands: Array<{ name: string; description: string }> = [];
  private sdkCommandsFetched = false;

  // Message queue — hold message while Claude is responding
  private queuedMessage: string | null = null;
  private queueIndicatorEl: HTMLElement | null = null;

  // Incremental rendering — track what's already rendered
  private renderedSegmentCount = 0;
  private lastRenderedText = "";

  // Image attachments
  private attachedImages: Array<{ path: string; name: string }> = [];

  // Progress tracking — live indicator in chat stream
  private currentActivity = "";
  private liveProgressEl: HTMLElement | null = null;


  // Streaming state — append-only cursor pattern
  private currentStreamingEl: HTMLElement | null = null;
  private currentAssistantMsg: ChatMessage | null = null;
  private streamingTextEl: HTMLElement | null = null;
  private streamingText: string = "";
  // Track rendered content to prevent duplicates from cumulative events
  private _renderedToolIds: Set<string> = new Set();
  private _renderedTextHashes: Set<string> = new Set();
  private _renderedThinkingCount: number = 0;
  // Track which Edit tools already triggered showEditInEditor
  private editDiffShown: Set<string> = new Set();
  /** True when session is live (receiving new events), false during resume re-render */
  private _isLiveSession: boolean = true;
  private _lastAssistantMsgId: string = "";
  private firstMessageText: string = "";
  private turnCount: number = 0;

  // Callbacks to plugin
  onSaveSession: ((session: SavedSession) => void) | null = null;
  onShowSessionPicker: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, settings: ClaudeNativeSettings) {
    super(leaf);
    this.settings = settings;
    const initialProvider = settings.defaultProvider || "claude";
    this.pm = new ProcessManager(settings, initialProvider);
    // settings.defaultModel is a Claude model id; for other providers,
    // pick that provider's first model instead so the trigger isn't
    // showing "opus[1m]" when Codex/Gemini is active.
    this.pm.model = (initialProvider === "claude"
      ? (settings.defaultModel || "sonnet")
      : (PROVIDER_MODELS[initialProvider][0]?.id || "")) as ModelChoice;
    this.pm.onEvent = (e) => this.handleEvent(e);
    this.pm.onStateChange = (s) => this.updateUI();
    this.pm.onComplete = () => this.onResponseComplete();
    this.pm.onPermissionRequest = (info) => this.showPermissionPrompt(info);
    this.pm.onStderr = (text) => {
      const ignore = [
        "CPU lacks AVX", "warn:", "no stdin data", "Warning:", "deprecat",
        // Gemini stderr noise
        "Ripgrep is not available", "Falling back to GrepTool",
        "Reading prompt from stdin", "Loaded cached credentials",
        "Reading additional input from stdin",
        // Codex stderr noise (status lines + transient MCP/auth errors
        // that don't actually break the turn)
        "OpenAI Codex", "workdir:", "model:", "provider:", "approval:", "sandbox:",
        "User instructions:", "tokens used", "[202",
        "rmcp::", "TokenRefreshFailed", "Transport channel closed",
        "worker quit with fatal",
      ];
      // Surface a friendly 429 / capacity exhaustion message instead of
      // dumping a full GaxiosError stack into the chat.
      if (text.includes("MODEL_CAPACITY_EXHAUSTED") || text.includes("No capacity available for model")) {
        const m = text.match(/No capacity available for model (\S+)/);
        const modelName = m?.[1] || this.pm.model;
        this.showError(`${PROVIDER_LABELS[this.pm.providerId]}: model "${modelName}" is at capacity. Try switching to a different model from the picker (e.g. 2.5 Pro or 2.5 Flash) — Google rotates capacity for preview models.`);
        return;
      }
      if (text.includes("RESOURCE_EXHAUSTED") || text.includes("status: 429")) {
        this.showError(`${PROVIDER_LABELS[this.pm.providerId]}: rate-limited or quota exhausted. Wait a minute and retry, or switch to another model.`);
        return;
      }
      if (!ignore.some(w => text.includes(w))) {
        if (text.includes("not logged in") || text.includes("authenticate") || text.includes("API key") || text.includes("unauthorized")) {
          const loginCmd = this.pm.providerId === "claude" ? "claude" : this.pm.providerId === "gemini" ? "gemini" : this.pm.providerId === "antigravity" ? "agy" : "codex login";
          this.showError(`Not logged in. Run \`${loginCmd}\` in your terminal first, then reload this plugin.`);
        } else if (text.includes("Prompt is too long") || text.includes("prompt is too long") || text.includes("context_length_exceeded")) {
          this.showContextFullError();
        } else {
          console.error("[katmer-code] stderr:", text);
          this.showError(text);
        }
      }
    };
  }

  getViewType(): string { return VIEW_TYPE_CLAUDE; }
  getDisplayText(): string { return "KatmerCode"; }
  getIcon(): string { return "cat"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("claude-native-root");

    // ── Header ──
    const header = container.createDiv("claude-native-header");
    const titleRow = header.createDiv("claude-native-title-row");
    titleRow.createEl("h3", { cls: "claude-native-title", text: "KatmerCode" });
    // Provider badge is now display-only. Switching happens through the
    // unified picker in the bottom toolbar so there's a single source of
    // truth for "which model is this tab using".
    this.providerBadge = titleRow.createSpan({
      cls: "cc-provider-badge",
      text: PROVIDER_LABELS[this.settings.defaultProvider || "claude"],
    });
    this.providerBadge.dataset.provider = this.settings.defaultProvider || "claude";
    this.providerBadge.title = "Current provider for this tab — change it from the picker below";

    const controls = titleRow.createDiv("claude-native-controls");

    // History button
    const historyBtn = controls.createEl("button", {
      cls: "claude-native-btn",
      attr: { "aria-label": "Session history" },
    });
    setIcon(historyBtn, "history");
    historyBtn.addEventListener("click", () => {
      this.onShowSessionPicker?.();
    });

    // New session button
    this.newSessionBtn = controls.createEl("button", {
      cls: "claude-native-btn",
      attr: { "aria-label": "New session" },
    });
    setIcon(this.newSessionBtn, "plus");
    this.newSessionBtn.addEventListener("click", () => this.addNewTab());

    this.abortBtn = controls.createEl("button", {
      cls: "claude-native-btn claude-native-btn-abort",
      attr: { "aria-label": "Stop" },
    });
    setIcon(this.abortBtn, "square");
    this.abortBtn.addEventListener("click", () => this.pm.abort());

    // ── Tab bar ──
    this.tabBarEl = header.createDiv("cc-tab-bar");
    this.createInitialTab();
    this.renderTabBar();

    // ── Context bar + status (header) ──
    const contextRow = header.createDiv("claude-native-context-row");
    this.contextBar = contextRow.createDiv("claude-native-context-bar");
    this.contextBar.createDiv("claude-native-context-fill");
    this.contextLabel = contextRow.createSpan({ cls: "claude-native-context-label", text: "" });

    this.statusBar = header.createDiv("claude-native-status");
    this.statusBar.textContent = "Checking CLI…";

    // ── Chat area ──
    this.chatContainer = container.createDiv("claude-native-chat");

    // Live progress indicator (at bottom of chat, scrolls with content)
    this.liveProgressEl = this.chatContainer.createDiv("cc-live-progress");
    this.liveProgressEl.addClass("is-hidden");

    this.emptyState = this.chatContainer.createDiv("claude-native-empty");
    this.emptyState.empty();
    this.emptyState.createDiv({ cls: "claude-native-empty-title", text: "KatmerCode" });
    this.emptyState.createDiv({ cls: "claude-native-empty-subtitle", text: "Checking Claude Code CLI\u2026" });

    // ── Diff bar — above input, visible when pending changes exist ──
    this.diffBar = container.createDiv("cc-diff-bar");
    this.diffBar.addClass("is-hidden");
    {
      const prevBtn = this.diffBar.createEl("button", { cls: "cc-diffbar-btn", attr: { "aria-label": "Previous" } });
      setIcon(prevBtn, "chevron-left");
      prevBtn.addEventListener("click", () => {
        const cmView = this.getEditorForFile(this.diffBarFilePath);
        if (cmView) goToPreviousChange(cmView);
      });

      this.diffBarLabel = this.diffBar.createSpan({ cls: "cc-diffbar-label", text: "" });

      const nextBtn = this.diffBar.createEl("button", { cls: "cc-diffbar-btn", attr: { "aria-label": "Next" } });
      setIcon(nextBtn, "chevron-right");
      nextBtn.addEventListener("click", () => {
        const cmView = this.getEditorForFile(this.diffBarFilePath);
        if (cmView) goToNextChange(cmView);
      });

      this.diffBar.createDiv("cc-diffbar-spacer");

      const acceptBtn = this.diffBar.createEl("button", { cls: "cc-diffbar-btn cc-diffbar-accept", text: "✓ accept" });
      acceptBtn.addEventListener("click", () => {
        const cmView = this.getEditorForFile(this.diffBarFilePath);
        if (cmView) {
          // Accept the change nearest to cursor
          const changes = cmView.state.field(changeRegistry);
          const cursor = cmView.state.selection.main.head;
          const nearest = changes
            .filter(c => c.status === "pending")
            .sort((a, b) => Math.abs(a.from - cursor) - Math.abs(b.from - cursor))[0];
          if (nearest) cmView.dispatch({ effects: acceptChange.of(nearest.id) });
          this.refreshDiffBar();
        }
      });

      const rejectBtn = this.diffBar.createEl("button", { cls: "cc-diffbar-btn cc-diffbar-reject", text: "✕ undo" });
      rejectBtn.addEventListener("click", () => {
        const cmView = this.getEditorForFile(this.diffBarFilePath);
        if (cmView) {
          const changes = cmView.state.field(changeRegistry);
          const cursor = cmView.state.selection.main.head;
          const nearest = changes
            .filter(c => c.status === "pending")
            .sort((a, b) => Math.abs(a.from - cursor) - Math.abs(b.from - cursor))[0];
          if (nearest) rejectSingleChange(cmView, nearest.id);
          this.refreshDiffBar();
        }
      });

      const acceptAllBtn = this.diffBar.createEl("button", { cls: "cc-diffbar-btn cc-diffbar-accept-all", text: "✓ all" });
      acceptAllBtn.addEventListener("click", () => {
        const cmView = this.getEditorForFile(this.diffBarFilePath);
        if (cmView) { acceptAllChanges(cmView); this.refreshDiffBar(); }
      });
    }

    // ── Input area — single box like claude.ai ──
    const inputArea = container.createDiv("cc-input-area");
    const inputBox = inputArea.createDiv("cc-input-box");

    // Queue indicator (inside the box, top)
    this.queueIndicatorEl = inputBox.createDiv("cc-queue-indicator");
    this.queueIndicatorEl.addClass("is-hidden");

    // Context card (inside the box, top)
    this.contextCardEl = inputBox.createDiv("cc-context-slot");

    // Textarea
    this.inputEl = inputBox.createEl("textarea", {
      cls: "cc-textarea",
      attr: { placeholder: "Type / for skills", rows: "1" },
    });

    // Bottom row inside the box: [+] ........... [Sonnet ∨] [↑]
    const bottomRow = inputBox.createDiv("cc-bottom-row");

    // Attach file (any type — images, docs, etc.)
    const attachBtn = bottomRow.createEl("button", { cls: "cc-icon-btn", attr: { "aria-label": "Attach file" } });
    setIcon(attachBtn, "paperclip");
    attachBtn.addEventListener("click", () => this.pickFile());

    // Skills button — opens the skill popup like typing /
    const skillBtn = bottomRow.createEl("button", { cls: "cc-icon-btn", attr: { "aria-label": "Commands" } });
    setIcon(skillBtn, "slash");
    skillBtn.addEventListener("click", () => {
      this.inputEl.value = "/";
      this.inputEl.focus();
      this.updateSkillPopup();
    });

    bottomRow.createDiv("cc-spacer");

    // Unified provider+model trigger — two stacked lines: provider on top,
    // model below. Single source of truth for "what's powering this tab".
    const modelTrigger = bottomRow.createDiv("cc-model-trigger");
    const triggerInner = modelTrigger.createDiv("cc-trigger-inner");
    const triggerProvider = triggerInner.createDiv({ cls: "cc-trigger-provider" });
    const triggerModel = triggerInner.createDiv({ cls: "cc-trigger-model", text: "" });
    this.triggerProviderEl = triggerProvider;
    this.modelTriggerLabel = triggerModel;
    const modelChevron = modelTrigger.createSpan("cc-chevron");
    setIcon(modelChevron, "chevron-down");

    // Stop button (visible when running)
    this._stopBtn = bottomRow.createEl("button", { cls: "cc-stop-btn", attr: { "aria-label": "Stop" } });
    setIcon(this._stopBtn, "square");
    this._stopBtn.addEventListener("click", () => this.pm.abort());

    // Send button
    this.sendBtn = bottomRow.createEl("button", { cls: "cc-send-btn", attr: { "aria-label": "Send" } });
    setIcon(this.sendBtn, "arrow-up");

    // ── Unified popup: provider tabs on top, model list below, effort
    // at bottom (when supported). Rebuilt on every open so detection and
    // active states stay fresh.
    const popup = inputArea.createDiv("cc-popup");
    popup.addClass("is-hidden");
    this.modelPopup = popup;
    this.providerTabsContainer = popup.createDiv("cc-popup-provider-tabs");
    popup.createDiv("cc-popup-divider");
    this.modelListContainer = popup.createDiv("cc-popup-models");
    this.modelBtns = {} as Record<ModelChoice, HTMLElement>;
    this.effortContainer = popup.createDiv("cc-popup-effort-wrap");
    this.effortBtns = {} as Record<EffortLevel, HTMLElement>;
    this.renderUnifiedPicker();

    // Toggle — refresh contents on open. Also invalidate the CLI probe
    // cache so the user sees fresh auth status (handy after they just
    // ran a login flow).
    modelTrigger.addEventListener("click", () => {
      const wasHidden = popup.hasClass("is-hidden");
      popup.toggleClass("is-hidden", !wasHidden);
      if (wasHidden) {
        this.cliProbeCache.clear();
        this.renderUnifiedPicker();
      }
    });
    document.addEventListener("click", (e) => {
      if (!inputArea.contains(e.target as Node)) popup.addClass("is-hidden");
    });

    // Skill autocomplete popup (positioned above input)
    this.skillPopup = inputBox.createDiv("cc-skill-popup");
    this.skillPopup.addClass("is-hidden");

    // Auto-resize textarea + skill autocomplete
    this.inputEl.addEventListener("input", () => {
      this.autoResizeInput();
      this.updateSkillPopup();
    });

    this.inputEl.addEventListener("keydown", (e) => {
      // Skill popup navigation
      if (this.skillPopup && !this.skillPopup.hasClass("is-hidden")) {
        const items = this.skillPopup.querySelectorAll(".cc-skill-item");
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.skillSelectedIdx = Math.min(this.skillSelectedIdx + 1, items.length - 1);
          this.highlightSkillItem(items);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this.skillSelectedIdx = Math.max(this.skillSelectedIdx - 1, 0);
          this.highlightSkillItem(items);
          return;
        }
        if ((e.key === "Enter" || e.key === "Tab") && items.length > 0) {
          e.preventDefault();
          const selected = items[this.skillSelectedIdx] as HTMLElement | undefined;
          if (selected?.dataset.skill) this.applySkillCompletion(selected.dataset.skill);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.skillPopup.addClass("is-hidden");
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // ESC to abort — listen on the whole view container so it works without input focus
    this.containerEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.pm.isRunning) {
        e.preventDefault();
        this.pm.abort();
      }
    });

    // Paste handler — images from clipboard
    this.inputEl.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) continue;
          // Save to temp file
          const ext = item.type.split("/")[1] || "png";
          const tmpName = `paste-${Date.now()}.${ext}`;
          const tmpPath = join(tmpdir(), tmpName);
          void blob.arrayBuffer().then((ab: ArrayBuffer) => {
            const buffer = Buffer.from(ab);
            writeFileSync(tmpPath, buffer);
            this.attachedImages.push({ path: tmpPath, name: tmpName });
            this.renderAttachmentCards();
          });
        }
      }
    });

    // Drag & drop files/images onto input box
    inputBox.addEventListener("dragover", (e) => {
      e.preventDefault();
      inputBox.addClass("cc-dragover");
    });
    inputBox.addEventListener("dragleave", () => {
      inputBox.removeClass("cc-dragover");
    });
    inputBox.addEventListener("drop", (e) => {
      e.preventDefault();
      inputBox.removeClass("cc-dragover");
      const files = e.dataTransfer?.files;
      if (!files) return;

      for (const file of Array.from(files)) {
        const filePath = getFilePathFromFile(file);
        if (!filePath) continue;
        this.attachedImages.push({ path: filePath, name: file.name });
      }
      this.renderAttachmentCards();
      this.inputEl.focus();
    });

    this.sendBtn.addEventListener("click", () => this.sendMessage());
    this.updateUI();

    // Auto-attach editor selection — use mousedown (fires BEFORE focus change)
    // Track last attached selection to avoid re-attaching the same text
    let lastAttachedText = "";

    this.inputEl.addEventListener("mousedown", () => {
      if (this.attachedContext) return;

      // 1. Try Obsidian editor API (editing/live-preview mode)
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      for (const leaf of leaves) {
        const view = leaf.view as { editor?: { getSelection(): string }; file?: TFile };
        if (view.editor) {
          const sel = view.editor.getSelection();
          if (sel && sel.length > 0 && sel !== lastAttachedText) {
            lastAttachedText = sel;
            this.attachedContext = { fileName: view.file?.name || "", text: sel };
            setTimeout(() => this.renderContextCard(), 0);
            return;
          }
        }
      }

      // 2. Fallback: DOM selection (reading mode)
      const domSel = window.getSelection();
      const domText = domSel?.toString().trim() || "";
      if (domText.length > 0 && domText !== lastAttachedText) {
        lastAttachedText = domText;
        let fileName = "";
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) fileName = activeFile.name;
        this.attachedContext = { fileName, text: domText };
        setTimeout(() => this.renderContextCard(), 0);
      }
    });

    // Check CLI availability + pre-warm query
    void this.checkCli().then(() => this.preWarmQuery());
  }

  /** Start SDK query early so first message is instant */
  private preWarmQuery(): void {
    const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
    const cwd = this.settings.workingDirectory || vaultPath || undefined;
    this.pm.warmUp(cwd);
  }

  private async checkCli(): Promise<void> {
    // Ask the active provider whether its CLI is reachable. Cached at the
    // view level so opening the picker / switching tabs doesn't re-probe.
    const probe = this.probeCli(this.pm.providerId);
    if (probe.found) {
      if (this.emptyState) {
        this.emptyState.empty();
        this.emptyState.createDiv({ cls: "claude-native-empty-title", text: "KatmerCode" });
        this.emptyState.createDiv({ cls: "claude-native-empty-subtitle", text: this.emptyStateSubtitle() });
      }
      if (this.statusBar) this.statusBar.textContent = "Ready";
      return;
    }
    // Fall through to the not-found branch below.
    try {
      throw new Error("not found");
    } catch {
      // CLI not found — show provider-specific install hints.
      const pid = this.pm.providerId;
      const labels = {
        claude: { name: "Claude Code CLI", install: "npm install -g @anthropic-ai/claude-code", login: "claude" },
        gemini: { name: "Gemini CLI", install: "npm install -g @google/gemini-cli", login: "gemini" },
        codex: { name: "Codex CLI", install: "npm install -g @openai/codex", login: "codex login" },
        antigravity: { name: "Antigravity CLI", install: "curl -fsSL https://antigravity.google/cli/install.sh | bash", login: "agy" },
      } as const;
      const info = labels[pid];
      if (this.emptyState) {
        this.emptyState.empty();
        this.emptyState.createDiv({ cls: "claude-native-empty-title", text: `${info.name} not found` });
        const setup = this.emptyState.createDiv("claude-native-empty-setup");
        setup.createEl("p").createEl("strong", { text: "Install the CLI" });
        const installPre = setup.createEl("pre");
        installPre.textContent = info.install;
        setup.createEl("p").createEl("strong", { text: "Log in (run once in terminal)" });
        const loginPre = setup.createEl("pre");
        loginPre.textContent = info.login;
        setup.createEl("p").createEl("strong", { text: "Reload this plugin" });
        setup.createEl("p", { cls: "claude-native-empty-hint", text: "If the CLI is installed but not found, set the full path in plugin settings" });
      }
      if (this.statusBar) {
        this.statusBar.textContent = `${info.name} not found`;
        this.statusBar.className = "claude-native-status";
      }
    }
  }

  // ── Skill Autocomplete ──

  /** Called when system init event arrives — fetch SDK commands */
  private async loadSdkCommands(): Promise<void> {
    if (this.sdkCommandsFetched) return;
    try {
      const cmds = await this.pm.getSupportedCommands();
      if (cmds && cmds.length > 0) {
        this.sdkCommands = cmds.map((c: { name: string; description?: string }) => ({
          name: "/" + c.name,
          description: c.description || "",
        }));
        this.sdkCommandsFetched = true;
      }
    } catch { /* ignore */ }
  }

  private updateSkillPopup(): void {
    if (!this.skillPopup) return;
    const text = this.inputEl.value;

    if (!text.startsWith("/")) {
      this.skillPopup.addClass("is-hidden");
      return;
    }

    // Hide if there's a space (command already selected, user typing args)
    if (text.includes(" ")) {
      this.skillPopup.addClass("is-hidden");
      return;
    }

    const query = text.slice(1).toLowerCase();
    const enabledSkills = this.settings.enabledSkills || [];

    // Filtered commands to skip in dropdown
    const FILTERED = new Set(["context", "cost", "init", "keybindings-help", "release-notes", "security-review", "extra-usage", "insights", "heapdump", "debug"]);

    // Build merged command list: our skills + SDK commands (deduplicated)
    const seenNames = new Set<string>();
    const items: Array<{ name: string; desc: string; source: "skill" | "sdk"; enabled: boolean }> = [];

    // 1. Our skills first
    for (const skill of SKILL_CATALOG) {
      if (query && !skill.name.toLowerCase().includes(query) && !skill.description.toLowerCase().includes(query)) continue;
      seenNames.add(skill.name);
      items.push({
        name: skill.name,
        desc: skill.description,
        source: "skill",
        enabled: enabledSkills.includes(skill.id),
      });
    }

    // 2. SDK commands (compact, batch, review, etc.)
    for (const cmd of this.sdkCommands) {
      const cmdBase = cmd.name.replace("/", "");
      if (FILTERED.has(cmdBase)) continue;
      if (seenNames.has(cmd.name)) continue;
      if (query && !cmd.name.toLowerCase().includes(query) && !cmd.description.toLowerCase().includes(query)) continue;
      seenNames.add(cmd.name);
      items.push({
        name: cmd.name,
        desc: cmd.description,
        source: "sdk",
        enabled: true,
      });
    }

    // Sort: enabled first, then alphabetical
    items.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    if (items.length === 0) {
      this.skillPopup.addClass("is-hidden");
      return;
    }

    this.skillPopup.empty();
    this.skillSelectedIdx = 0;

    for (let i = 0; i < items.length; i++) {
      const cmd = items[i];
      const item = this.skillPopup.createDiv({
        cls: "cc-skill-item" + (i === 0 ? " is-selected" : "") + (!cmd.enabled ? " is-disabled" : ""),
      });
      item.dataset.skill = cmd.name;
      item.createSpan({ cls: "cc-skill-name", text: cmd.name });
      item.createSpan({ cls: "cc-skill-desc", text: cmd.desc });
      if (cmd.source === "sdk") {
        item.createSpan({ cls: "cc-skill-badge cc-skill-badge-sdk", text: "CLI" });
      } else if (!cmd.enabled) {
        item.createSpan({ cls: "cc-skill-badge", text: "off" });
      } else if (this.pm.providerId !== "claude") {
        // KatmerCode skill running on non-Claude provider — we'll inject
        // the markdown into the prompt. Label it so the user knows.
        item.createSpan({ cls: "cc-skill-badge cc-skill-badge-inject", text: "inject" });
      }
      item.addEventListener("click", () => {
        if (cmd.enabled) this.applySkillCompletion(cmd.name);
      });
    }

    this.skillPopup.removeClass("is-hidden");
  }

  private highlightSkillItem(items: NodeListOf<Element>): void {
    items.forEach((el, i) => {
      el.toggleClass("is-selected", i === this.skillSelectedIdx);
    });
    // Scroll into view
    const selected = items[this.skillSelectedIdx] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }

  private applySkillCompletion(skillName: string): void {
    // Replace the "/..." with the skill name + a trailing space
    this.inputEl.value = skillName + " ";
    this.inputEl.focus();
    if (this.skillPopup) this.skillPopup.addClass("is-hidden");
    // Move cursor to end
    this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
  }

  /** Update progress indicator — both status bar and inline chat */
  private updateProgress(toolName: string, input: Record<string, unknown>, isSubagent = false): void {
    let detail = "";
    let icon = "loader";

    if (toolName === "Read" && typeof input.file_path === "string") {
      detail = input.file_path.split("/").pop() || input.file_path;
      icon = "file-text";
    } else if (toolName === "Edit" && typeof input.file_path === "string") {
      detail = input.file_path.split("/").pop() || input.file_path;
      icon = "pencil";
    } else if (toolName === "Write" && typeof input.file_path === "string") {
      detail = input.file_path.split("/").pop() || input.file_path;
      icon = "file-plus";
    } else if (toolName === "Bash" && typeof input.command === "string") {
      detail = input.command.slice(0, 50);
      icon = "terminal";
    } else if (toolName === "WebFetch" && typeof input.url === "string") {
      try {
        detail = new URL(input.url).hostname;
      } catch {
        detail = input.url.slice(0, 30);
      }
      icon = "globe";
    } else if (toolName === "WebSearch" && typeof input.query === "string") {
      detail = input.query.slice(0, 40);
      icon = "search";
    } else if (toolName === "Grep" && typeof input.pattern === "string") {
      detail = `"${input.pattern.slice(0, 25)}"`;
      icon = "search";
    } else if (toolName === "Agent" && typeof input.description === "string") {
      detail = input.description.slice(0, 40);
      icon = "cpu";
    } else if (toolName === "Thinking") {
      // Don't override subagent progress with "Thinking..."
      if (!this.currentActivity.startsWith("Subagent")) {
        this.currentActivity = "Thinking…";
        this.showLiveProgress("cat", "Thinking…");
        this.updateUI();
      }
      return;
    }

    const prefix = isSubagent ? "Subagent " : "";
    this.currentActivity = detail ? `${prefix}${toolName}: ${detail}` : `${prefix}${toolName}`;
    this.showLiveProgress(icon, this.currentActivity);
    this.updateUI();
  }

  private progressStartTime: number = 0;
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  /** Show/update the live progress element in chat stream */
  private showLiveProgress(icon: string, text: string): void {
    if (!this.liveProgressEl) return;
    this.liveProgressEl.empty();
    this.liveProgressEl.removeClass("is-hidden");

    // Start timer if not already running
    if (!this.progressStartTime) this.progressStartTime = Date.now();

    const iconEl = this.liveProgressEl.createSpan("cc-live-progress-icon");
    setIcon(iconEl, icon);

    this.liveProgressEl.createSpan({ cls: "cc-live-progress-text", text });
    const timerEl = this.liveProgressEl.createSpan({ cls: "cc-live-progress-timer" });

    // Live elapsed timer
    if (this.progressTimer) clearInterval(this.progressTimer);
    const updateTimer = () => {
      const elapsed = Math.floor((Date.now() - this.progressStartTime) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      timerEl.textContent = min > 0
        ? `(esc to interrupt · ${min}m ${sec}s)`
        : `(esc to interrupt · ${sec}s)`;
    };
    updateTimer();
    this.progressTimer = setInterval(updateTimer, 1000);

    // Move to end of chat
    this.chatContainer.appendChild(this.liveProgressEl);
    this.scrollToBottom();
  }

  /** Hide the live progress element */
  private hideLiveProgress(): void {
    if (this.liveProgressEl) {
      this.liveProgressEl.addClass("is-hidden");
    }
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    this.progressStartTime = 0;
  }

  /** Open native file picker — accepts any file type */
  private pickFile(): void {
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.multiple = true;
    fileInput.addClass("cc-offscreen-input");
    document.body.appendChild(fileInput);

    fileInput.addEventListener("change", () => {
      const files = fileInput.files;
      if (!files) return;

      for (const file of Array.from(files)) {
        const filePath = getFilePathFromFile(file);
        if (!filePath) continue;
        this.attachedImages.push({ path: filePath, name: file.name });
      }
      this.renderAttachmentCards();
      this.inputEl.focus();
      document.body.removeChild(fileInput);
    });

    fileInput.click();
  }

  /** Render attachment cards (images + files) in context slot */
  private renderAttachmentCards(): void {
    if (!this.contextCardEl) return;
    this.contextCardEl.querySelectorAll(".cc-image-card").forEach(el => el.remove());
    for (const file of this.attachedImages) {
      const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(file.name);
      const card = this.contextCardEl.createDiv("cc-image-card");
      const icon = card.createSpan("cc-context-card-icon");
      setIcon(icon, isImage ? "image" : "file-text");
      card.createSpan({ cls: "cc-context-card-file", text: file.name });
      const removeBtn = card.createEl("button", {
        cls: "cc-context-card-remove",
        attr: { "aria-label": "Remove" },
      });
      setIcon(removeBtn, "x");
      removeBtn.addEventListener("click", () => {
        this.attachedImages = this.attachedImages.filter(i => i.path !== file.path);
        this.renderAttachmentCards();
      });
    }
  }

  // (selection is now auto-attached on input focus — no manual button needed)

  private renderContextCard(): void {
    if (!this.contextCardEl) return;
    this.contextCardEl.empty();

    if (!this.attachedContext) return;

    const card = this.contextCardEl.createDiv("cc-context-card");

    const icon = card.createSpan("cc-context-card-icon");
    setIcon(icon, "file-text");

    const info = card.createDiv("cc-context-card-info");
    info.createDiv({ cls: "cc-context-card-file", text: this.attachedContext.fileName });

    const preview = this.attachedContext.text.length > 120
      ? this.attachedContext.text.slice(0, 120) + "…"
      : this.attachedContext.text;
    info.createDiv({ cls: "cc-context-card-preview", text: preview });

    const removeBtn = card.createEl("button", {
      cls: "cc-context-card-remove",
      attr: { "aria-label": "Remove" },
    });
    setIcon(removeBtn, "x");
    removeBtn.addEventListener("click", () => {
      this.attachedContext = null;
      this.renderContextCard();
    });
  }

  async onClose(): Promise<void> {
    // Destroy ALL tab PMs
    for (const tab of this.tabs) {
      tab.pm.destroy();
    }
  }

  updateSettings(settings: ClaudeNativeSettings): void {
    this.settings = settings;
    // Settings change can affect CLI paths — toss the cache.
    this.cliProbeCache.clear();
    // Each tab keeps its OWN provider. Settings update is just config
    // propagation (CLI path overrides, permission mode, etc.).
    for (const tab of this.tabs) {
      tab.pm.updateSettings(settings);
    }
    this.refreshProviderBadge();
  }

  // ── Model & Thinking selectors ──

  private selectModel(model: string): void {
    const fromModel = this.pm.model;
    if (fromModel === model) return;

    // Active tab only. modelByProvider remembers the choice for new tabs.
    this.pm.model = model as ModelChoice;
    this.modelByProvider[this.pm.providerId] = model;
    void this.pm.setModelRuntime(model as ModelChoice);
    this.refreshModelTrigger();
    if (this.modelListContainer) {
      this.modelListContainer.querySelectorAll(".cc-popup-item").forEach((el) => {
        el.toggleClass("is-active", (el as HTMLElement).dataset.modelId === model);
      });
    }
    // Same-provider model swap preserves context (the adapter's session
    // continues); mark it so the user can see when capabilities changed.
    if (this.messages.length > 0) {
      this.pushSwitchMarker({
        kind: "model",
        fromProvider: this.pm.providerId,
        fromModel: fromModel as string,
        toProvider: this.pm.providerId,
        toModel: model,
        contextLost: false,
      });
    }
  }

  /** Append a "switched to X" divider message to the chat. */
  private pushSwitchMarker(meta: NonNullable<ChatMessage["switchMeta"]>): void {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "system",
      content: "",
      timestamp: Date.now(),
      switchMeta: meta,
    };
    this.messages.push(msg);
    this.renderSwitchMarker(msg);
  }

  /** Render the switch divider inline. */
  private renderSwitchMarker(msg: ChatMessage): void {
    const meta = msg.switchMeta!;
    const wrap = this.chatContainer.createDiv("cc-switch-marker");
    wrap.dataset.kind = meta.kind;
    wrap.dataset.toProvider = meta.toProvider;

    const fromModels = PROVIDER_MODELS[meta.fromProvider] || [];
    const toModels = PROVIDER_MODELS[meta.toProvider] || [];
    const fromLabel = fromModels.find((m) => m.id === meta.fromModel)?.label || meta.fromModel;
    const toLabel = toModels.find((m) => m.id === meta.toModel)?.label || meta.toModel;

    const line = wrap.createDiv("cc-switch-line");
    const text = line.createSpan("cc-switch-text");
    const arrow = " → ";
    if (meta.kind === "provider") {
      text.textContent = `Switched to ${PROVIDER_LABELS[meta.toProvider]} · ${toLabel}${arrow}from ${PROVIDER_LABELS[meta.fromProvider]} · ${fromLabel}`;
    } else {
      text.textContent = `Switched model · ${fromLabel}${arrow}${toLabel}`;
    }

    if (meta.contextLost) {
      const warn = wrap.createDiv("cc-switch-warn");
      warn.textContent = "⚠ Previous conversation context isn't carried over to the new provider.";
    }
    this.scrollToBottom();
  }

  /**
   * Build the unified picker popup: provider tabs across the top, model
   * list in the middle, optional effort selector at the bottom.
   * Called when the popup opens and when the active tab/provider changes.
   */
  private renderUnifiedPicker(): void {
    this.renderProviderTabs();
    this.renderModelList();
    this.renderEffortSection();
    this.refreshModelTrigger();
  }

  /** Cached CLI probe — first call spawns, subsequent calls return memoized. */
  private probeCli(id: ProviderId): { found: boolean; path?: string; authenticated?: boolean; loginHint?: string } {
    let cached = this.cliProbeCache.get(id);
    if (!cached) {
      cached = createProvider(id, this.settings).detectCli();
      this.cliProbeCache.set(id, cached);
    }
    return cached;
  }

  /** Top section: provider tabs with CLI + auth detection status. */
  private renderProviderTabs(): void {
    if (!this.providerTabsContainer) return;
    this.providerTabsContainer.empty();
    const activeProvider = this.pm?.providerId || "claude";
    const providerIds: ProviderId[] = ["claude", "gemini", "codex", "antigravity"];
    for (const pid of providerIds) {
      const probe = this.probeCli(pid);
      const status: "ready" | "no-auth" | "no-cli" =
        !probe.found ? "no-cli" :
        probe.authenticated === false ? "no-auth" :
        "ready";

      const tab = this.providerTabsContainer.createDiv(
        "cc-provider-tab" +
        (pid === activeProvider ? " is-active" : "") +
        (status === "no-cli" ? " is-unavailable" : "") +
        (status === "no-auth" ? " is-needs-login" : "")
      );
      tab.dataset.provider = pid;
      tab.dataset.status = status;
      const dot = tab.createSpan({ cls: "cc-provider-tab-dot" });
      dot.dataset.provider = pid;
      dot.dataset.status = status;
      tab.createSpan({ cls: "cc-provider-tab-name", text: PROVIDER_LABELS_SHORT[pid] });
      if (status === "no-cli") {
        tab.createSpan({ cls: "cc-provider-tab-warn", text: "install" });
        tab.title = `${PROVIDER_LABELS[pid]} CLI not found.\n\n${probe.loginHint || ""}`;
      } else if (status === "no-auth") {
        tab.createSpan({ cls: "cc-provider-tab-warn cc-provider-tab-warn-auth", text: "login" });
        tab.title = `${PROVIDER_LABELS[pid]}: not logged in.\n\nRun in your terminal:\n  ${probe.loginHint}`;
      }
      tab.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pid === activeProvider) return;
        if (status !== "ready") {
          // Show a copyable Notice with the install/login command.
          this.showCliSetupNotice(pid, status, probe.loginHint);
          return;
        }
        this.switchProvider(pid);
        this.renderUnifiedPicker();
      });
    }
  }

  /**
   * Setup hint. For "no-auth" we try to trigger the provider's own login
   * flow (Claude/Codex spawn directly, Gemini/Antigravity open Terminal).
   * For "no-cli" we just give the install command to copy.
   */
  private async showCliSetupNotice(pid: ProviderId, status: "no-cli" | "no-auth", hint?: string): Promise<void> {
    const label = PROVIDER_LABELS[pid];

    if (status === "no-cli") {
      const message = `Install ${label}:\n\n${hint || ""}\n\n(Click to copy)`;
      const n = new Notice(message, 9000);
      if (hint && n.noticeEl) {
        n.noticeEl.style.cursor = "pointer";
        n.noticeEl.addEventListener("click", () => {
          void navigator.clipboard.writeText(hint).then(() => {
            new Notice("Install command copied — paste into your terminal.", 2500);
          }).catch(() => {});
        });
      }
      return;
    }

    // status === "no-auth" → try in-plugin login.
    const adapter = createProvider(pid, this.settings);
    if (!adapter.triggerLogin) {
      // Fallback to copy-paste notice.
      const n = new Notice(`Log in to ${label}:\n\n${hint || ""}\n\n(Click to copy)`, 9000);
      if (hint && n.noticeEl) {
        n.noticeEl.style.cursor = "pointer";
        n.noticeEl.addEventListener("click", () => {
          void navigator.clipboard.writeText(hint).then(() => {
            new Notice("Login command copied.", 2500);
          });
        });
      }
      return;
    }

    const progress = new Notice(`Starting ${label} login… browser should open shortly. Plugin polls every 3s for completion.\n\n(Click here to recheck manually)`, 0);
    if (progress.noticeEl) {
      progress.noticeEl.style.cursor = "pointer";
      progress.noticeEl.addEventListener("click", () => {
        this.cliProbeCache.delete(pid);
        const fresh = this.probeCli(pid);
        if (fresh.authenticated === true) {
          progress.hide();
          new Notice(`✓ ${label} is now logged in.`, 3500);
          this.renderUnifiedPicker();
        } else {
          new Notice(`Still not detected as logged in — keep the browser flow going.`, 3000);
        }
      });
    }
    try {
      const result = await adapter.triggerLogin();
      progress.hide();
      if (result.manual) {
        new Notice(`${label}: terminal opened. Complete login there, then click any provider tab again to retry.`, 8000);
        // Manual flows can't be auto-detected — invalidate the cache so
        // the next picker render re-probes.
        this.cliProbeCache.delete(pid);
        return;
      }
      if (result.success) {
        this.cliProbeCache.delete(pid);
        new Notice(`✓ Logged in to ${label}.`, 3500);
        this.renderUnifiedPicker();
      } else {
        new Notice(`${label} login failed: ${result.reason || "unknown error"}`, 6000);
      }
    } catch (err) {
      progress.hide();
      new Notice(`${label} login error: ${err instanceof Error ? err.message : String(err)}`, 6000);
    }
  }

  /** Middle section: model list for the active provider. */
  private renderModelList(): void {
    if (!this.modelListContainer) return;
    this.modelListContainer.empty();
    this.modelBtns = {} as Record<ModelChoice, HTMLElement>;
    const provId = this.pm.providerId;
    const models = PROVIDER_MODELS[provId] || [];
    const current = this.pm.model || this.modelByProvider[provId] || (models[0]?.id ?? "");
    if (models.length === 0) {
      this.modelListContainer.createDiv({
        cls: "cc-popup-empty",
        text: "No model selection for this provider.",
      });
      return;
    }
    for (const m of models) {
      const item = this.modelListContainer.createDiv("cc-popup-item" + (m.id === current ? " is-active" : ""));
      item.dataset.modelId = m.id;
      // Single-line layout — just the model name. Tooltip carries the
      // longer description so it's still discoverable on hover but
      // doesn't fight for visual space.
      item.createDiv({ cls: "cc-popup-item-name", text: m.label });
      if (m.desc) item.title = m.desc;
      item.addEventListener("click", () => {
        this.selectModel(m.id);
        this.modelPopup?.addClass("is-hidden");
      });
      this.modelBtns[m.id as ModelChoice] = item;
    }
  }

  /** Bottom section: effort pills — only shown for providers that honor it. */
  private renderEffortSection(): void {
    if (!this.effortContainer) return;
    this.effortContainer.empty();
    this.effortBtns = {} as Record<EffortLevel, HTMLElement>;

    // Provider support matrix for reasoning effort:
    //   Claude   — native SDK option (low/medium/high/max)
    //   Codex    — model_reasoning_effort config (minimal/low/medium/high/xhigh)
    //   Gemini   — thinking_level exists per Gemini 3.x API but no CLI flag
    //              exposed yet (github.com/google-gemini/gemini-cli/issues/25122)
    //   Antigrav — agy v1.0.2 has no reasoning control
    const supportsEffort = this.pm.providerId === "claude" || this.pm.providerId === "codex";
    if (!supportsEffort) return;

    this.effortContainer.createDiv("cc-popup-divider");
    const section = this.effortContainer.createDiv("cc-popup-effort");
    const titleRow = section.createDiv("cc-popup-effort-title");
    titleRow.textContent = "Reasoning effort";
    if (this.pm.providerId === "codex") {
      const sub = section.createSpan({ cls: "cc-popup-effort-sub" });
      sub.textContent = "max → high (xhigh only on select models)";
    }
    const row = section.createDiv("cc-popup-effort-row");
    const effortKeys: EffortLevel[] = ["low", "medium", "high", "max"];
    for (const key of effortKeys) {
      const pill = row.createEl("button", {
        cls: "cc-pill" + (key === this.pm.effort ? " is-active" : ""),
        text: EFFORT_LABELS[key],
      });
      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectEffort(key);
        row.querySelectorAll(".cc-pill").forEach(el => el.removeClass("is-active"));
        pill.addClass("is-active");
      });
      this.effortBtns[key] = pill;
    }
  }

  /** Update the trigger (provider name + model label) to reflect the active tab. */
  private refreshModelTrigger(): void {
    if (!this.modelTriggerLabel) return;
    const provId = this.pm.providerId;
    const models = PROVIDER_MODELS[provId] || [];
    let current: string = this.pm.model || this.modelByProvider[provId];
    let found = models.find((m) => m.id === current);
    // Self-heal: if the active model id doesn't belong to the current
    // provider (e.g. legacy "opus[1m]" stored while Codex is active),
    // snap to the provider's first model so the trigger never shows a
    // mismatched label.
    if (!found && models.length > 0) {
      const stored = this.modelByProvider[provId];
      const fallback = (stored && models.some((m) => m.id === stored)) ? stored : models[0].id;
      this.pm.model = fallback as ModelChoice;
      this.modelByProvider[provId] = fallback;
      current = fallback;
      found = models.find((m) => m.id === current);
    }
    this.modelTriggerLabel.textContent = found?.label || current || "—";
    if (this.triggerProviderEl) {
      this.triggerProviderEl.textContent = PROVIDER_LABELS[provId] || provId;
      this.triggerProviderEl.dataset.provider = provId;
      const trigger = this.triggerProviderEl.closest(".cc-model-trigger") as HTMLElement | null;
      if (trigger) trigger.dataset.provider = provId;
    }
  }

  private selectEffort(level: EffortLevel): void {
    this.pm.effort = level;
    for (const [key, btn] of Object.entries(this.effortBtns)) {
      btn.toggleClass("is-active", key === level);
    }
    if (this.pm.query) {
      new Notice("Effort change applies on next session", 2000);
    }
  }

  private updateContextBar(): void {
    if (!this.session || !this.contextBar || !this.contextLabel) return;

    const contextTokens = this.session.inputTokens
      + (this.session.cacheCreationTokens || 0)
      + (this.session.cacheReadTokens || 0);
    // Prefer the catalog window (per-model truth) over whatever default
    // was stamped on the session object — Claude's SDK reports the real
    // window via modelUsage and overrides this, but for Gemini/Codex/Antigrav
    // we never had it on the session, so the lookup is the source of truth.
    const catalogWindow = lookupContextWindow(this.pm.providerId, this.pm.model);
    const contextWindow = Math.max(this.session.contextWindow || 0, catalogWindow);
    const pct = Math.round(Math.min((contextTokens / contextWindow) * 100, 100));
    const warning = pct > 80;

    const fmtK = (n: number) => n >= 1_000_000 ? (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1000 ? Math.round(n / 1000) + "K" : String(n);
    this.contextLabel.textContent = `${fmtK(contextTokens)} / ${fmtK(contextWindow)} (${pct}%)`;
    this.contextLabel.toggleClass("cc-warning-text", warning);

    // Tooltip with compact suggestion (Claude only — other providers
    // don't have /compact natively).
    const compactHint = this.pm.providerId === "claude" ? " — run /compact to continue" : " — start a new tab to free room";
    const tooltip = warning
      ? `${fmtK(contextTokens)} / ${fmtK(contextWindow)}${compactHint}`
      : `${fmtK(contextTokens)} / ${fmtK(contextWindow)}`;
    this.contextBar.parentElement?.setAttribute("title", tooltip);
  }

  // ── Actions ──

  private sendMessage(): void {
    const text = this.inputEl.value.trim();
    if (!text) return;

    // Queue message if Claude is still responding
    if (this.pm.isRunning) {
      if (this.queuedMessage) {
        this.queuedMessage += "\n\n" + text;
      } else {
        this.queuedMessage = text;
      }
      this.inputEl.value = "";
      this.resetInputHeight();
      this.updateQueueIndicator();
      return;
    }

    // Slash commands: Claude CLI knows them natively via
    // ~/.claude/commands/. For other providers we inline the skill
    // markdown ourselves so /peer-review etc. work everywhere.
    const isSlashCommand = text.startsWith("/");
    const skillInjection = isSlashCommand ? this.maybeInjectSkill(text) : null;

    // Build full message with context
    let fullMessage = skillInjection ?? text;

    if (!isSlashCommand) {
      // Attached selection context
      if (this.attachedContext) {
        fullMessage = `[Selected text from ${this.attachedContext.fileName}]:\n${this.attachedContext.text}\n\n${text}`;
      }

      // Auto-include active file path (if user didn't explicitly attach selection)
      if (!this.attachedContext) {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath || "";
          const absPath = vaultPath + "/" + activeFile.path;
          fullMessage = `[Active file: ${absPath}]\n\n${text}`;
        }
      }

      // Attached images
      if (this.attachedImages.length > 0) {
        for (const img of this.attachedImages) {
          fullMessage += `\n\n[Image: ${img.path}]`;
        }
      }
    }

    // Hide empty state
    if (this.emptyState) this.emptyState.addClass("is-hidden");

    // Build attachment metadata for display
    const attachments: ChatMessage["attachments"] = [];
    if (this.attachedContext) {
      const preview = this.attachedContext.text.length > 80
        ? this.attachedContext.text.slice(0, 80) + "…"
        : this.attachedContext.text;
      attachments.push({ type: "selection", name: this.attachedContext.fileName, preview });
    }
    for (const file of this.attachedImages) {
      attachments.push({ type: "file", name: file.name });
    }

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      timestamp: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    this.messages.push(userMsg);
    this.renderUserMessage(userMsg);

    // Clear input + context + images
    this.inputEl.value = "";
    this.resetInputHeight();
    this.attachedContext = null;
    this.attachedImages = [];
    this.renderContextCard();
    this.renderAttachmentCards();

    // Reset streaming state
    this.currentAssistantMsg = null;
    this.currentStreamingEl = null;
    this.streamingTextEl = null;
    this.streamingText = "";
    this._renderedToolIds.clear(); this._renderedTextHashes.clear(); this._renderedThinkingCount = 0;
    this._lastAssistantMsgId = "";

    // Track first message for session naming
    if (!this.firstMessageText) {
      this.firstMessageText = text.slice(0, 80);
    }

    // Send via CLI
    const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
    const cwd = this.settings.workingDirectory || vaultPath || undefined;
    this.pm.send(fullMessage, cwd);

    // Visible "is thinking…" at the bottom of the scroll viewport. The
    // existing live-progress strip lives at the top of the chat and the
    // user can't see it while reading the latest reply.
    this.showThinkingPlaceholder();
    this.showLiveProgress("cat", "Thinking…");
    this.scrollToBottom();
  }

  /** Resume a saved session by ID */
  resumeSession(sessionId: string, savedMessages?: ChatMessage[]): void {
    this.pm.newSession();
    this.pm.setSessionId(sessionId);
    this.session = null;
    this.firstMessageText = "";
    this.turnCount = 0;
    this.currentAssistantMsg = null;
    this.currentStreamingEl = null;
    this.chatContainer.empty();
    if (this.emptyState) this.emptyState.addClass("is-hidden");

    // Restore saved messages — suppress inline diffs during replay
    this._isLiveSession = false;
    this.messages = savedMessages || [];
    for (const msg of this.messages) {
      if (msg.role === "user") {
        this.renderUserMessage(msg);
        if (!this.firstMessageText) this.firstMessageText = msg.content.slice(0, 80);
      } else if (msg.role === "assistant") {
        this.renderAssistantMessage(msg);
      }
      this.turnCount++;
    }
    this._isLiveSession = true;

    this.updateUI();
  }

  // ── PM wiring helpers ──

  /**
   * If the user typed `/skillName ...` on a non-Claude provider, inline the
   * skill markdown so providers that don't share Claude's commands
   * directory can still run it. Claude tabs pass through (the CLI knows).
   * Returns the rewritten prompt, or null when no rewrite is needed.
   */
  private maybeInjectSkill(text: string): string | null {
    if (this.pm.providerId === "claude") return null;
    const match = text.match(/^\/([a-zA-Z0-9_-]+)\s*([\s\S]*)$/);
    if (!match) return null;
    const skillId = match[1];
    const skillArgs = match[2].trim();
    if (!this.settings.enabledSkills.includes(skillId)) return null;
    const content = this.loadSkillMarkdown(skillId);
    if (!content) return null;

    // Pre-load report-template if the skill (likely) renders an HTML report.
    let extras = "";
    if (this.settings.enabledSkills.includes("report-template") && skillId !== "report-template") {
      const tpl = this.loadSkillMarkdown("report-template");
      if (tpl) extras = `\n\n## Shared report template\n\n${tpl}`;
    }

    const argsLine = skillArgs ? `\n\nArguments: ${skillArgs}` : "";
    return `# Skill: ${skillId}\n\n${content}${extras}${argsLine}`;
  }

  /** Read a skill's markdown body from ~/.claude/commands/<file>.md. */
  private loadSkillMarkdown(skillId: string): string | null {
    const def = SKILL_CATALOG.find((s) => s.id === skillId);
    if (!def) return null;
    const path = join(homedir(), ".claude", "commands", def.fileName);
    try {
      const raw = readFileSync(path, "utf-8");
      // Strip the KatmerCode header line so it doesn't end up in the prompt.
      return raw.replace(/^<!-- KatmerCode skill:.*?-->\s*/, "");
    } catch {
      return null;
    }
  }

  /** djb2 string hash — collision-resistant for the deduper. */
  private hashString(s: string): string {
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h) ^ s.charCodeAt(i);
    }
    return (h >>> 0).toString(36) + ":" + s.length;
  }

  /** Empty-state subtitle showing the active provider + model. */
  private emptyStateSubtitle(): string {
    const provId = this.pm?.providerId || "claude";
    const provider = PROVIDER_LABELS[provId] || provId;
    const models = PROVIDER_MODELS[provId] || [];
    const current = this.pm?.model || this.modelByProvider[provId];
    const model = models.find((m) => m.id === current)?.label || current || "";
    return model ? `${provider} · ${model} — send a message to start` : `${provider} — send a message to start`;
  }

  /** Refresh the provider badge text to match the ACTIVE tab. */
  private refreshProviderBadge(): void {
    if (!this.providerBadge) return;
    const id = this.pm?.providerId || this.settings.defaultProvider || "claude";
    this.providerBadge.textContent = PROVIDER_LABELS[id];
    this.providerBadge.dataset.provider = id;
  }

  /**
   * Attach footer actions to a completed assistant message: compact
   * Copy + "ask another model" icon buttons. They sit on the right of
   * the duration line and take minimal horizontal space.
   */
  private attachMessageActions(footer: HTMLElement, msg: ChatMessage): void {
    if (!msg.content && !(msg.segments && msg.segments.some((s) => s.type === "text"))) return;
    const actions = footer.createSpan({ cls: "cc-msg-actions" });

    // Copy button
    const copyBtn = actions.createEl("button", { cls: "cc-msg-action-btn", attr: { "aria-label": "Copy reply" } });
    copyBtn.title = "Copy reply";
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void navigator.clipboard.writeText(this.extractAssistantText(msg))
        .then(() => {
          setIcon(copyBtn, "check");
          copyBtn.addClass("is-confirmed");
          setTimeout(() => {
            setIcon(copyBtn, "copy");
            copyBtn.removeClass("is-confirmed");
          }, 1200);
        })
        .catch(() => new Notice("Copy failed.", 2000));
    });

    // Consult another model — INLINE: doesn't open a new tab. Each item
    // shows the model that'll be used and lets the user expand a submenu
    // to pick a different one.
    const askWrap = actions.createSpan({ cls: "cc-ask-wrap" });
    const askBtn = askWrap.createEl("button", { cls: "cc-msg-action-btn", attr: { "aria-label": "Consult another model" } });
    askBtn.title = "Consult another model (in this tab)";
    setIcon(askBtn, "messages-square");
    const menu = askWrap.createDiv({ cls: "cc-ask-menu is-hidden" });
    const providers: ProviderId[] = ["claude", "gemini", "codex", "antigravity"];
    let hasAnyConsult = false;
    for (const pid of providers) {
      if (pid === this.pm.providerId) continue;
      hasAnyConsult = true;

      const item = menu.createDiv({ cls: "cc-ask-item" });
      item.dataset.provider = pid;
      const main = item.createDiv("cc-ask-row");
      const dot = main.createSpan({ cls: "cc-ask-dot" });
      dot.dataset.provider = pid;
      main.createSpan({ cls: "cc-ask-name", text: `Consult ${PROVIDER_LABELS[pid]}` });

      const models = PROVIDER_MODELS[pid] || [];
      const currentId = this.modelByProvider[pid] || models[0]?.id || "";
      const currentLabel = models.find((m) => m.id === currentId)?.label || currentId || "—";

      const badge = main.createSpan({ cls: "cc-ask-model-badge" });
      badge.createSpan({ cls: "cc-ask-model-label", text: currentLabel });
      const canPick = models.length > 1;
      if (canPick) {
        badge.createSpan({ cls: "cc-ask-model-chev", text: "▾" });
      }

      // Inline submenu — hidden until the model badge chev is clicked.
      const submenu = item.createDiv("cc-ask-submenu is-hidden");
      for (const model of models) {
        const subItem = submenu.createDiv({
          cls: "cc-ask-sub-item" + (model.id === currentId ? " is-active" : ""),
        });
        subItem.createSpan({ cls: "cc-ask-sub-name", text: model.label });
        if (model.id === currentId) {
          subItem.createSpan({ cls: "cc-ask-sub-check", text: "✓" });
        }
        subItem.addEventListener("click", (e) => {
          e.stopPropagation();
          menu.addClass("is-hidden");
          this.modelByProvider[pid] = model.id;
          void this.consultProvider(pid, msg, model.id);
        });
      }

      main.addEventListener("click", (e) => {
        e.stopPropagation();
        // Click on the chev → toggle inline model picker. Click anywhere
        // else on the row → consult with current default.
        const target = e.target as HTMLElement;
        if (canPick && target.closest(".cc-ask-model-badge")) {
          submenu.toggleClass("is-hidden", !submenu.hasClass("is-hidden"));
          return;
        }
        menu.addClass("is-hidden");
        void this.consultProvider(pid, msg);
      });
    }

    if (hasAnyConsult) {
      menu.createDiv({ cls: "cc-ask-divider" });
    }
    const newTabSub = menu.createDiv({ cls: "cc-ask-item cc-ask-item-sub" });
    newTabSub.createSpan({ cls: "cc-ask-name", text: "↗ Open in a new tab instead…" });
    newTabSub.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.addClass("is-hidden");
      this.showForwardChoice(msg);
    });

    askBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.toggleClass("is-hidden", !menu.hasClass("is-hidden"));
    });
    document.addEventListener("click", (e) => {
      if (!askWrap.contains(e.target as Node)) menu.addClass("is-hidden");
    });
  }

  /** Secondary dropdown to pick a provider for "open in new tab" forwarding. */
  private showForwardChoice(msg: ChatMessage): void {
    const providers: ProviderId[] = ["claude", "gemini", "codex", "antigravity"];
    const options = providers
      .filter((p) => p !== this.pm.providerId)
      .map((p) => PROVIDER_LABELS[p])
      .join(", ");
    const choice = window.prompt(`Open new tab with which provider?\n\nOptions: ${options}`, PROVIDER_LABELS[providers.find((p) => p !== this.pm.providerId)!]);
    if (!choice) return;
    const target = providers.find((p) => PROVIDER_LABELS[p].toLowerCase() === choice.trim().toLowerCase());
    if (target) this.forwardToProvider(target, msg);
  }

  private extractAssistantText(msg: ChatMessage): string {
    if (msg.segments && msg.segments.length > 0) {
      return msg.segments
        .filter((s): s is { type: "text"; text: string; fromStream?: boolean } => s.type === "text")
        .map((s) => s.text)
        .join("\n\n")
        .trim();
    }
    return (msg.content || "").trim();
  }

  /**
   * Consult another provider INLINE — no new tab, no context switch.
   * Spawns a background PM on `target`, sends a focused consultation
   * prompt, renders the response as a consultation card in the current
   * conversation, then asks the active provider to synthesize the input.
   *
   * Failure modes are isolated: if the consult fails, we surface a
   * Notice and skip the follow-up so the chat doesn't drift into a
   * broken state.
   */
  private async consultProvider(target: ProviderId, msg: ChatMessage, modelOverride?: string): Promise<void> {
    if (this.pm.isRunning) {
      new Notice("Wait for the current reply to finish before consulting another model.", 4000);
      return;
    }
    const replyText = this.extractAssistantText(msg);
    if (!replyText) {
      new Notice("Nothing to consult about — the reply is empty.", 3000);
      return;
    }
    const probe = this.probeCli(target);
    if (!probe.found) {
      this.showCliSetupNotice(target, "no-cli", probe.loginHint);
      return;
    }
    if (probe.authenticated === false) {
      this.showCliSetupNotice(target, "no-auth", probe.loginHint);
      return;
    }
    // Resolve the model — explicit override > remembered default > first available.
    const chosenModelId = modelOverride
      || this.modelByProvider[target]
      || PROVIDER_MODELS[target][0]?.id
      || "";
    const chosenModelLabel = (PROVIDER_MODELS[target] || []).find((m) => m.id === chosenModelId)?.label || chosenModelId;

    // Build a one-shot prompt for the target provider.
    const consultPrompt = `I'm working through a conversation with another AI model and I'd like your independent take on its last answer.\n\nLast answer to evaluate:\n\n> ${replyText.split("\n").join("\n> ")}\n\nPlease respond concisely (a few paragraphs max). Focus on: do you agree, what would you add, where do you disagree or see risks, and any concrete improvements. You don't need to repeat the answer — your reviewer voice is what matters.`;

    // Render a placeholder consultation card in the chat.
    const card = this.chatContainer.createDiv("cc-consultation is-loading");
    card.dataset.provider = target;
    const header = card.createDiv("cc-consultation-header");
    const dot = header.createSpan("cc-consultation-dot");
    dot.dataset.provider = target;
    header.createSpan({ cls: "cc-consultation-label", text: `Consulting ${PROVIDER_LABELS[target]}…` });
    header.createSpan({ cls: "cc-consultation-model", text: chosenModelLabel });
    const body = card.createDiv("cc-consultation-body");
    body.textContent = "…";
    this.scrollToBottom();

    // Spawn a temporary PM and wait for one result.
    const tmpPm = new ProcessManager(this.settings, target);
    tmpPm.model = chosenModelId as ModelChoice;
    tmpPm.effort = this.pm.effort;

    let consultText = "";
    let consultError: string | null = null;

    const done = new Promise<void>((resolve) => {
      tmpPm.onEvent = (e) => {
        if (e.type === "stream_delta") {
          const delta = (e as StreamDeltaEvent).text;
          if (delta) consultText += delta;
          body.textContent = consultText;
        } else if (e.type === "assistant") {
          const aMsg = e as AssistantMessageEvent;
          for (const block of aMsg.message?.content || []) {
            if (block.type === "text" && block.text) {
              consultText = block.text;
              body.textContent = consultText;
            }
          }
        }
      };
      tmpPm.onStderr = (text) => {
        if (text.includes("MODEL_CAPACITY_EXHAUSTED") || text.includes("RESOURCE_EXHAUSTED")) {
          consultError = `${PROVIDER_LABELS[target]} is at capacity right now. Try a different model.`;
        } else if (text.includes("not logged in") || text.includes("authenticate")) {
          consultError = `${PROVIDER_LABELS[target]} is not authenticated. Run its CLI login command in your terminal first.`;
        }
      };
      tmpPm.onComplete = () => {
        resolve();
      };
    });

    const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
    const cwd = this.settings.workingDirectory || vaultPath || undefined;
    tmpPm.send(consultPrompt, cwd);
    await done;
    tmpPm.destroy();

    // Finalize the consultation card.
    card.removeClass("is-loading");
    header.empty();
    const dot2 = header.createSpan("cc-consultation-dot");
    dot2.dataset.provider = target;
    header.createSpan({ cls: "cc-consultation-label", text: `${PROVIDER_LABELS[target]} consulted` });
    header.createSpan({ cls: "cc-consultation-model", text: chosenModelLabel });

    if (consultError || !consultText.trim()) {
      card.addClass("is-error");
      body.empty();
      body.textContent = consultError || "No response from the consulted model.";
      return;
    }

    // Replace plaintext with rendered markdown.
    body.empty();
    try {
      MarkdownRenderer.render(this.app, consultText, body, "", this);
    } catch {
      body.textContent = consultText;
    }

    // Compose the follow-up prompt for the active model. Claude doesn't
    // see the consultation card (that's UI-only), so the quoted text
    // must be in the prompt itself.
    const followup = `[Cross-model synthesis] I just consulted ${PROVIDER_LABELS[target]} about your previous reply. Here is its take:\n\n> ${consultText.split("\n").join("\n> ")}\n\nHow does this change or refine your answer? Briefly: where do you agree, where do you push back, and anything you'd integrate?`;

    // Render a COMPACT synthesis pill — not a full user bubble — so the
    // chat doesn't read like the user typed a wall of quoted text.
    const synthMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: followup,
      timestamp: Date.now(),
      synthesisMeta: {
        consultedProvider: target,
        consultedLabel: `${PROVIDER_LABELS[target]} (${chosenModelLabel})`,
      },
    };
    this.messages.push(synthMsg);
    this.renderUserMessage(synthMsg);

    // Reset streaming state so the next assistant event opens a fresh bubble.
    this.currentAssistantMsg = null;
    this.currentStreamingEl = null;
    this.streamingTextEl = null;
    this.streamingText = "";
    this._renderedToolIds.clear();
    this._renderedTextHashes.clear();
    this._renderedThinkingCount = 0;
    this._lastAssistantMsgId = "";

    // Send to the active PM directly — bypass sendMessage so we don't
    // get the default user-bubble rendering.
    this.pm.send(followup, cwd);
    // Visible thinking indicator while the active model digests the
    // consultation. Disappears when the first reply event arrives.
    this.showThinkingPlaceholder();
  }

  /** Open a new tab on `target` with the previous reply seeded as context. */
  private forwardToProvider(target: ProviderId, msg: ChatMessage): void {
    const replyText = this.extractAssistantText(msg);
    const fromLabel = PROVIDER_LABELS[this.pm.providerId] || this.pm.providerId;
    const prompt = `Another model (${fromLabel}) gave me this answer:\n\n> ${replyText.split("\n").join("\n> ")}\n\nWhat's your take? Anything you'd add, dispute, or do differently?`;

    this.saveActiveTabState();
    const newPm = new ProcessManager(this.settings, target);
    newPm.model = (this.modelByProvider[target] || PROVIDER_MODELS[target][0]?.id || "") as ModelChoice;
    newPm.effort = this.pm.effort;
    const tab: TabState = {
      id: crypto.randomUUID(),
      title: `Second opinion · ${PROVIDER_LABELS[target]}`,
      messages: [],
      session: null,
      sessionId: null,
      firstMessageText: "",
      turnCount: 0,
      pm: newPm,
      pendingPermissions: [],
    };
    this.tabs.push(tab);
    this.switchToTab(tab.id);
    this.renderTabBar();
    if (this.inputEl) {
      this.inputEl.value = prompt;
      this.inputEl.focus();
      this.autoResizeInput();
    }
  }

  /**
   * Switch the ACTIVE tab's provider. Other tabs keep theirs — this is the
   * point of having tabs at all (Codex in one tab while Claude runs in
   * another).
   *
   * Important: we do NOT touch `settings.defaultProvider` here. The default
   * only controls what new tabs spawn with; flipping a tab mid-conversation
   * shouldn't rewrite the global preference. Use Settings to change the
   * default for new tabs.
   */
  private switchProvider(id: ProviderId): void {
    if (this.pm.providerId === id) return;

    const fromProvider = this.pm.providerId;
    const fromModel = this.pm.model;

    // Only swap the ACTIVE tab's adapter. Other tabs are independent.
    const targetModel = this.modelByProvider[id] || PROVIDER_MODELS[id][0]?.id;
    this.pm.setProvider(id);
    if (targetModel) this.pm.model = targetModel as ModelChoice;

    // Mark the switch in the conversation so the user can see it. Only
    // bother once there's actual history — empty tabs don't need a
    // divider since the first message starts fresh anyway.
    if (this.messages.length > 0) {
      this.pushSwitchMarker({
        kind: "provider",
        fromProvider,
        fromModel,
        toProvider: id,
        toModel: targetModel || "",
        contextLost: true,
      });
    }

    this.refreshProviderBadge();
    this.renderUnifiedPicker();
    void this.checkCli();
  }

  /**
   * Create a new ProcessManager for a tab.
   * Inherits the active tab's provider+model so opening a new tab while
   * chatting with (say) Codex doesn't reset you to Claude.
   */
  private createPM(): ProcessManager {
    const inheritProvider = this.pm?.providerId || this.settings.defaultProvider || "claude";
    const inheritModel = this.pm?.model || this.modelByProvider[inheritProvider] || "sonnet";
    const pm = new ProcessManager(this.settings, inheritProvider);
    pm.model = inheritModel as ModelChoice;
    pm.effort = this.pm?.effort || "high";
    return pm;
  }

  /** Wire PM as the active foreground PM — events render to DOM */
  private wirePM(pm: ProcessManager): void {
    pm.onEvent = (e) => this.handleEvent(e);
    pm.onStateChange = () => this.updateUI();
    pm.onComplete = () => this.onResponseComplete();
    pm.onPermissionRequest = (info) => this.showPermissionPrompt(info);
    pm.onStderr = (text) => {
      const ignore = [
        "CPU lacks AVX", "warn:", "no stdin data", "Warning:", "deprecat",
        // Gemini stderr noise
        "Ripgrep is not available", "Falling back to GrepTool",
        "Reading prompt from stdin", "Loaded cached credentials",
        "Reading additional input from stdin",
        // Codex stderr noise (status lines and transient MCP/auth errors
        // that don't actually break the turn)
        "OpenAI Codex", "workdir:", "model:", "provider:", "approval:", "sandbox:",
        "User instructions:", "tokens used", "[202",
        "rmcp::", "TokenRefreshFailed", "Transport channel closed",
        "worker quit with fatal",
      ];
      if (!ignore.some(w => text.includes(w))) {
        if (text.includes("not logged in") || text.includes("authenticate") || text.includes("API key") || text.includes("unauthorized")) {
          const loginCmd = pm.providerId === "claude" ? "claude" : pm.providerId === "gemini" ? "gemini" : pm.providerId === "antigravity" ? "agy" : "codex login";
          this.showError(`Not logged in. Run \`${loginCmd}\` in your terminal first, then reload this plugin.`);
        } else if (text.includes("Prompt is too long") || text.includes("prompt is too long") || text.includes("context_length_exceeded")) {
          this.showContextFullError();
        } else {
          console.error("[katmer-code] stderr:", text);
          this.showError(text);
        }
      }
    };
  }

  /** Wire PM as a background PM — accumulates messages in tab state but doesn't touch DOM */
  private wireBackgroundPM(pm: ProcessManager, tab: TabState): void {
    pm.onEvent = (e) => {
      // Accumulate assistant messages into tab.messages (minimal handling)
      if (e.type === "assistant") {
        const aEvent = e as AssistantMessageEvent;
        if (aEvent.parent_tool_use_id) return; // skip subagent
        const content = aEvent.message?.content;
        if (!content || !Array.isArray(content)) return;

        // Find or create the current assistant message in tab.messages
        let lastMsg = tab.messages[tab.messages.length - 1];
        if (!lastMsg || lastMsg.role !== "assistant") {
          lastMsg = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: "",
            toolCalls: [],
            segments: [],
            timestamp: Date.now(),
            isStreaming: true,
          };
          tab.messages.push(lastMsg);
        }
        // Accumulate text content
        for (const block of content) {
          if (block.type === "text" && block.text) {
            // Only set (not append) — SDK sends cumulative content
            lastMsg.content = block.text;
          }
        }
      } else if (e.type === "result") {
        // Mark last assistant message as done
        const lastMsg = tab.messages[tab.messages.length - 1];
        if (lastMsg && lastMsg.role === "assistant") {
          lastMsg.isStreaming = false;
        }
        // Update session cost/usage
        const rEvent = e as ResultEvent;
        if (tab.session) {
          tab.session.totalCost += rEvent.total_cost_usd || 0;
        }
        tab.turnCount++;
      } else if (e.type === "system") {
        const sEvent = e as SystemInitEvent;
        if (sEvent.subtype === "init") {
          tab.session = {
            sessionId: sEvent.session_id,
            model: sEvent.model || "unknown",
            mcpServers: sEvent.mcp_servers || [],
            cliVersion: sEvent.claude_code_version || "",
            totalCost: 0,
            inputTokens: 0,
            outputTokens: 0,
            contextWindow: lookupContextWindow(tab.pm.providerId, tab.pm.model),
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
          };
          tab.sessionId = sEvent.session_id;
        }
      }
    };
    pm.onStateChange = () => this.renderTabBar(); // update running indicator
    pm.onComplete = () => this.renderTabBar();
    pm.onStderr = null;
    // Permission requests: queue them for when tab becomes active
    pm.onPermissionRequest = (info) => {
      return new Promise<"allow" | "deny" | "always">((resolve) => {
        tab.pendingPermissions.push({ info, resolve });
        // Show a notice so user knows
        new Notice(`Tab "${tab.title}" needs permission for ${info.toolName}`, 5000);
      });
    };
  }

  /** Unwire all handlers from a PM */
  private unwirePM(pm: ProcessManager): void {
    pm.onEvent = null;
    pm.onStateChange = null;
    pm.onComplete = null;
    pm.onPermissionRequest = null;
    pm.onStderr = null;
  }

  // ── Tab management ──

  private createInitialTab(): void {
    const tab: TabState = {
      id: crypto.randomUUID(),
      title: "New chat",
      messages: [],
      session: null,
      sessionId: null,
      firstMessageText: "",
      turnCount: 0,
      pm: this.pm,
      pendingPermissions: [],
    };
    this.tabs = [tab];
    this.activeTabId = tab.id;
  }

  private addNewTab(): void {
    // Save current tab state
    this.saveActiveTabState();

    // Create a new PM for this tab
    const newPm = this.createPM();

    const tab: TabState = {
      id: crypto.randomUUID(),
      title: "New chat",
      messages: [],
      session: null,
      sessionId: null,
      firstMessageText: "",
      turnCount: 0,
      pm: newPm,
      pendingPermissions: [],
    };
    this.tabs.push(tab);
    this.switchToTab(tab.id);
    this.renderTabBar();
  }

  private switchToTab(tabId: string): void {
    if (tabId === this.activeTabId) return;

    // Save current tab
    this.saveActiveTabState();

    // Wire old tab's PM as background (keeps running but doesn't touch DOM)
    const oldTab = this.tabs.find(t => t.id === this.activeTabId);
    if (oldTab) {
      this.wireBackgroundPM(oldTab.pm, oldTab);
    }

    // Load new tab
    this.activeTabId = tabId;
    const tab = this.tabs.find(t => t.id === tabId);
    if (!tab) return;

    this.messages = tab.messages;
    this.session = tab.session;
    this.firstMessageText = tab.firstMessageText;
    this.turnCount = tab.turnCount;
    this.currentAssistantMsg = null;
    this.currentStreamingEl = null;
    this.streamingTextEl = null;
    this.streamingText = "";
    this._renderedToolIds.clear();
    this._renderedTextHashes.clear();
    this._renderedThinkingCount = 0;
    this._lastAssistantMsgId = "";

    // Switch to new tab's PM
    this.pm = tab.pm;
    this.wirePM(this.pm);

    // Reflect the tab's provider + model in the header and model picker.
    this.refreshProviderBadge();
    this.renderUnifiedPicker();

    // Pre-warm if this PM has no active query yet
    if (!this.pm.query && !tab.sessionId) {
      const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
      const cwd = this.settings.workingDirectory || vaultPath || undefined;
      this.pm.warmUp(cwd);
    }

    // Process any pending permission requests from background execution
    if (tab.pendingPermissions.length > 0) {
      const pending = tab.pendingPermissions.shift()!;
      void this.showPermissionPrompt(pending.info).then(pending.resolve);
    }

    // Re-render chat
    this.chatContainer.empty();
    // Recreate live progress element
    this.liveProgressEl = this.chatContainer.createDiv("cc-live-progress");
    this.liveProgressEl.addClass("is-hidden");

    if (this.messages.length === 0) {
      this.emptyState = this.chatContainer.createDiv("claude-native-empty");
      this.emptyState.empty();
      this.emptyState.createDiv({ cls: "claude-native-empty-title", text: "KatmerCode" });
      this.emptyState.createDiv({ cls: "claude-native-empty-subtitle", text: "Send a message to start" });
    } else {
      // CRITICAL: suppress inline-diff replay during tab re-render. Without
      // this, every Edit tool in the history re-triggers showEditInEditor,
      // pushing already-accepted diffs back into the open file's editor.
      // (restoreSession does the same thing — keep both paths in sync.)
      this._isLiveSession = false;
      this.editDiffShown.clear();
      for (const msg of this.messages) {
        if (msg.role === "user") this.renderUserMessage(msg);
        else if (msg.role === "assistant") this.renderAssistantMessage(msg);
        else if (msg.role === "system" && msg.switchMeta) this.renderSwitchMarker(msg);
      }
      this._isLiveSession = true;
    }

    // If the tab's PM is running, show progress indicator
    if (this.pm.isRunning) {
      this.showLiveProgress("cat", this.currentActivity || "Thinking...");
    }

    this.renderTabBar();
    this.updateUI();
    this.updateContextBar();
  }

  private closeTab(tabId: string): void {
    if (this.tabs.length <= 1) return; // can't close last tab

    const idx = this.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

    // Destroy the tab's PM (kills subprocess)
    const closingTab = this.tabs[idx];
    if (closingTab.pm !== this.pm) {
      closingTab.pm.destroy();
    }
    // Reject any pending permissions
    for (const p of closingTab.pendingPermissions) {
      p.resolve("deny");
    }

    this.tabs.splice(idx, 1);

    // If closing active tab, switch to adjacent
    if (tabId === this.activeTabId) {
      const newIdx = Math.min(idx, this.tabs.length - 1);
      this.switchToTab(this.tabs[newIdx].id);
    }

    this.renderTabBar();
  }

  private saveActiveTabState(): void {
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (!tab) return;
    tab.messages = this.messages;
    tab.session = this.session;
    tab.sessionId = this.pm.sessionId;
    tab.firstMessageText = this.firstMessageText;
    tab.turnCount = this.turnCount;
    // Update title from first message
    if (this.firstMessageText && tab.title === "New chat") {
      tab.title = this.firstMessageText.slice(0, 30) + (this.firstMessageText.length > 30 ? "…" : "");
    }
  }

  private renderTabBar(): void {
    if (!this.tabBarEl) return;
    this.tabBarEl.empty();

    // Only show tab bar if more than 1 tab
    if (this.tabs.length <= 1) {
      this.tabBarEl.addClass("is-hidden");
      return;
    }
    this.tabBarEl.removeClass("is-hidden");

    for (const tab of this.tabs) {
      const isActive = tab.id === this.activeTabId;
      const isRunning = tab.pm?.isRunning || false;
      const tabEl = this.tabBarEl.createDiv(
        "cc-tab" + (isActive ? " is-active" : "") + (isRunning ? " is-running" : "")
      );

      // Colored dot indicating which provider this tab is using.
      const providerDot = tabEl.createSpan({ cls: "cc-tab-provider-dot" });
      providerDot.dataset.provider = tab.pm?.providerId || "claude";
      providerDot.title = PROVIDER_LABELS[tab.pm?.providerId || "claude"];

      tabEl.createSpan({ cls: "cc-tab-title", text: tab.title });

      const closeBtn = tabEl.createSpan({ cls: "cc-tab-close" });
      setIcon(closeBtn, "x");
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.closeTab(tab.id);
      });

      tabEl.addEventListener("click", () => this.switchToTab(tab.id));
    }
  }

  /** Start a new session (public — called from command palette too) */
  startNewSession(): void { this.addNewTab(); }

  private newSession(): void {
    this.pm.newSession();
    this.messages = [];
    this.session = null;
    this.firstMessageText = "";
    this.turnCount = 0;
    this.currentAssistantMsg = null;
    this.currentStreamingEl = null;
    this.chatContainer.empty();

    // Re-create empty state
    this.emptyState = this.chatContainer.createDiv("claude-native-empty");
    this.emptyState.createDiv({ cls: "claude-native-empty-title", text: "KatmerCode" });
    this.emptyState.createDiv({ cls: "claude-native-empty-subtitle", text: "Send a message to start" });
    this.updateUI();
  }

  // ── Event handling ──

  private handleEvent(event: ClaudeEvent): void {
    switch (event.type) {
      case "system":
        this.handleSystemEvent(event as SystemInitEvent);
        break;
      case "assistant":
        this.handleAssistantEvent(event as AssistantMessageEvent);
        break;
      case "result":
        this.handleResultEvent(event as ResultEvent);
        break;
      case "stream_delta":
        this.handleStreamDelta(event as StreamDeltaEvent);
        break;
    }
  }

  private handleSystemEvent(event: SystemInitEvent): void {
    // Compact boundary — show separator in chat
    if ((event as { subtype: string }).subtype === "compact_boundary") {
      const divider = this.chatContainer.createDiv("cc-compact-divider");
      divider.createDiv("cc-compact-line");
      divider.createSpan({ cls: "cc-compact-label", text: "Context compacted" });
      divider.createDiv("cc-compact-line");
      this.scrollToBottom();
      return;
    }

    if (event.subtype === "init") {
      // Seed the context window from the per-model catalog. Claude's
      // SDK will override this with the true value via modelUsage on the
      // first result event; other providers don't carry that data so
      // the catalog stays authoritative.
      const model = event.model || "unknown";
      const contextWindow = lookupContextWindow(this.pm.providerId, this.pm.model);

      this.session = {
        sessionId: event.session_id,
        model,
        mcpServers: event.mcp_servers || [],
        cliVersion: event.claude_code_version || "",
        totalCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        contextWindow,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      };
      this.updateUI();
      // Fetch SDK commands for dropdown (lazy, once)
      void this.loadSdkCommands();
    }
  }

  /**
   * Handle streaming text deltas — render text character by character.
   * When the full assistant message arrives, it replaces this streaming text.
   */
  private handleStreamDelta(event: StreamDeltaEvent): void {
    // First content has arrived — drop the "is thinking" placeholder.
    this.hideThinkingPlaceholder();
    this.streamingText += event.text;

    // Ensure we have a streaming container
    if (!this.currentStreamingEl) {
      if (this.emptyState) this.emptyState.addClass("is-hidden");
      this.currentStreamingEl = this.chatContainer.createDiv(
        "claude-native-msg claude-native-msg-assistant is-streaming"
      );
      this.currentStreamingEl.dataset.provider = this.pm.providerId;
      this.currentStreamingEl.createDiv({ cls: "claude-native-msg-label", text: PROVIDER_LABELS[this.pm.providerId] || "Assistant" });
      this.streamingTextEl = this.currentStreamingEl.createDiv("claude-native-msg-body cc-streaming-body");
    }

    if (!this.streamingTextEl) {
      this.streamingTextEl = this.currentStreamingEl!.createDiv("claude-native-msg-body cc-streaming-body");
    }

    // CRITICAL: persist streaming text into the chat message so it survives
    // a tab switch. Without this, providers that only emit stream_delta
    // events (no final assistant envelope) lose their reply when the user
    // navigates away and back.
    if (!this.currentAssistantMsg) {
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        toolCalls: [],
        segments: [],
        timestamp: Date.now(),
        isStreaming: true,
      };
      this.currentAssistantMsg = msg;
      this.messages.push(msg);
    }
    // Keep the streaming text on the last text segment so re-render after
    // tab-switch shows the in-progress reply. We mark it so a real
    // assistant text block (if it ever arrives) replaces this stub
    // instead of double-rendering.
    const segs = this.currentAssistantMsg.segments!;
    const last = segs[segs.length - 1];
    if (last && last.type === "text" && last.fromStream) {
      last.text = this.streamingText;
    } else {
      segs.push({ type: "text", text: this.streamingText, fromStream: true });
    }
    this.currentAssistantMsg.content = this.streamingText;

    // Render streaming text (use textContent for speed, markdown on complete)
    this.streamingTextEl.textContent = this.streamingText;
    this.scrollToBottom();
  }

  private handleAssistantEvent(event: AssistantMessageEvent): void {
    // First content has arrived — drop the "is thinking" placeholder.
    this.hideThinkingPlaceholder();
    // Subagent messages — don't render in chat, but show tool calls in progress indicator
    if (event.parent_tool_use_id) {
      const content = event.message?.content;
      if (content && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use" && block.name) {
            this.updateProgress(block.name, block.input || {}, true);
          }
        }
      }
      return;
    }

    // Update context usage from each main-agent assistant message
    // contextTokens = input + cache_creation + cache_read (all consume context window)
    if (this.session && event.message?.usage) {
      const u = event.message.usage;
      this.session.inputTokens = u.input_tokens || 0;
      this.session.outputTokens = u.output_tokens || 0;
      this.session.cacheReadTokens = u.cache_read_input_tokens || 0;
      this.session.cacheCreationTokens = u.cache_creation_input_tokens || 0;
      this.updateContextBar();
    }

    const content = event.message?.content;
    if (!content || !Array.isArray(content)) return;

    // Detect new API call within agentic loop (message.id changes between API calls)
    const msgId = event.message?.id || "";
    if (this.currentAssistantMsg && msgId && msgId !== this._lastAssistantMsgId) {
      // New API call in agentic loop — reset counter so new blocks render
      this._renderedToolIds.clear(); this._renderedTextHashes.clear(); this._renderedThinkingCount = 0;
    }
    this._lastAssistantMsgId = msgId;

    // Ensure container exists
    if (!this.currentStreamingEl) {
      if (this.emptyState) this.emptyState.addClass("is-hidden");
      this.currentStreamingEl = this.chatContainer.createDiv(
        "claude-native-msg claude-native-msg-assistant is-streaming"
      );
      this.currentStreamingEl.dataset.provider = this.pm.providerId;
      this.currentStreamingEl.createDiv({ cls: "claude-native-msg-label", text: PROVIDER_LABELS[this.pm.providerId] || "Assistant" });
    }
    if (!this.currentAssistantMsg) {
      const msg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
        toolCalls: [],
        segments: [],
        timestamp: Date.now(),
        isStreaming: true,
      };
      this.currentAssistantMsg = msg;
      this.messages.push(msg);
      this._renderedToolIds.clear(); this._renderedTextHashes.clear(); this._renderedThinkingCount = 0;
    }

    const el = this.currentStreamingEl;

    // APPEND-ONLY: skip already-rendered blocks using content-based dedup
    for (let i = 0; i < content.length; i++) {
      const block = content[i];

      if (block.type === "thinking" && block.thinking) {
        // Dedup: count-based (thinking blocks don't have IDs)
        const thinkIdx = content.slice(0, i).filter(b => b.type === "thinking").length;
        if (thinkIdx < this._renderedThinkingCount) continue;
        this._renderedThinkingCount = thinkIdx + 1;

        const tc: ToolCallInfo = {
          id: `thinking-${thinkIdx}`,
          name: "Thinking",
          input: {},
          result: block.thinking,
          startTime: Date.now(),
        };
        this.currentAssistantMsg.toolCalls!.push(tc);
        this.currentAssistantMsg.segments!.push({ type: "tool", tool: tc });
        this.renderToolCall(el, tc);
      } else if (block.type === "text" && block.text) {
        // Dedup: exact text match (SDK sends cumulative — same text appears in multiple events)
        // Hash that won't false-positive when two different responses
        // happen to share the same first 100 chars AND length.
        const textHash = this.hashString(block.text);
        if (this._renderedTextHashes.has(textHash)) continue;
        this._renderedTextHashes.add(textHash);

        // Remove streaming body if exists (stream_delta showed this as plain text)
        if (this.streamingTextEl) {
          this.streamingTextEl.remove();
          this.streamingTextEl = null;
          this.streamingText = "";
        }

        // If the previous segment was a streaming stub, finalize it in place
        // instead of pushing a duplicate (otherwise the final text gets
        // rendered twice and msg.content doubles up).
        const segsArr = this.currentAssistantMsg.segments!;
        const lastSeg = segsArr[segsArr.length - 1];
        if (lastSeg && lastSeg.type === "text" && lastSeg.fromStream) {
          lastSeg.text = block.text;
          lastSeg.fromStream = false;
          this.currentAssistantMsg.content = block.text;
        } else {
          this.currentAssistantMsg.content += block.text;
          segsArr.push({ type: "text", text: block.text });
        }
        const body = el.createDiv("claude-native-msg-body");
        MarkdownRenderer.render(this.app, block.text, body, "", this);
        this.enhanceCodeBlocks(body);
      } else if (block.type === "tool_use" && block.name) {
        // Dedup: tool_use ID (stable across cumulative events)
        const toolId = block.id || crypto.randomUUID();
        if (this._renderedToolIds.has(toolId)) continue;
        this._renderedToolIds.add(toolId);

        const tc: ToolCallInfo = {
          id: toolId,
          name: block.name,
          input: block.input || {},
          startTime: Date.now(),
        };
        this.currentAssistantMsg.toolCalls!.push(tc);
        this.currentAssistantMsg.segments!.push({ type: "tool", tool: tc });
        if (tc.name === "Edit" || this.settings.showToolCalls) {
          this.renderToolCall(el, tc);
        }
        this.updateProgress(block.name, block.input || {});
      } else if (block.type === "tool_result") {
        const resultText = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c: { text?: string }) => c.text || "").join("")
            : "";
        const targetTool = [...this.currentAssistantMsg.toolCalls!].reverse().find(t => !t.result && t.name !== "Thinking");
        if (targetTool) {
          targetTool.result = resultText;
          targetTool.isError = block.is_error;
          // Update tool status in DOM
          const toolEl: HTMLElement | null = el.querySelector(`[data-tool-id="${targetTool.id}"] .cc-tool-status.is-running`);
          if (toolEl) {
            toolEl.removeClass("is-running");
            toolEl.addClass("is-done");
            toolEl.empty();
            setIcon(toolEl, "check");
          }
        }
      }
    }

    this.scrollToBottom();
  }

  private handleResultEvent(event: ResultEvent): void {
    // Note: streaming finalization is handled in onResponseComplete()
    // (called by ProcessManager when result event arrives)

    // Update cost/usage
    if (this.session) {
      this.session.totalCost += event.total_cost_usd || 0;
      // Context = latest turn's tokens (NOT cumulative — each turn includes full conversation)
      if (event.usage) {
        this.session.inputTokens = event.usage.input_tokens || 0;
        this.session.outputTokens = event.usage.output_tokens || 0;
        this.session.cacheReadTokens = event.usage.cache_read_input_tokens || 0;
        this.session.cacheCreationTokens = event.usage.cache_creation_input_tokens || 0;
      }
      // Extract context window size from modelUsage (attached by process-manager)
      const raw = event as ResultEvent & { modelUsage?: Record<string, { contextWindow?: number }> };
      if (raw.modelUsage) {
        for (const m of Object.values(raw.modelUsage)) {
          if (m.contextWindow) this.session.contextWindow = m.contextWindow;
        }
      }
      this.updateContextBar();
    }
  }

  private onResponseComplete(): void {
    this.hideLiveProgress();
    this.hideThinkingPlaceholder();

    // Dismiss any pending permission prompt (e.g. on abort)
    this._activePermissionCleanup?.();

    if (this.pm.state === "error" && !this.currentAssistantMsg) {
      const providerName = PROVIDER_LABELS[this.pm.providerId] || this.pm.providerId;
      this.showError(`${providerName} exited with an error. Check Obsidian console (Cmd+Opt+I) for details.`);
    }
    // Finalize streaming state — also kill the blinking cursor on the
    // streaming body so old messages don't keep animating.
    if (this.currentAssistantMsg) {
      this.currentAssistantMsg.isStreaming = false;
      // Mark any tools still showing "Running" as done — they're stranded
      // if the turn ended without their result event (e.g. provider 429,
      // process killed, agent loop aborted).
      for (const tc of this.currentAssistantMsg.toolCalls || []) {
        if (!tc.result && tc.name !== "Thinking") {
          tc.result = "";
          const toolEl = this.currentStreamingEl?.querySelector(
            `[data-tool-id="${tc.id}"] .cc-tool-status.is-running`
          ) as HTMLElement | null;
          if (toolEl) {
            toolEl.removeClass("is-running");
            toolEl.addClass("is-stalled");
            toolEl.empty();
            toolEl.textContent = "—";
          }
        }
      }
    }
    // If the stream finished without a proper assistant text block (Gemini
    // sometimes only emits deltas), the streaming element is still showing
    // raw plaintext. Re-render it as markdown so the user sees the polished
    // version immediately — not after a tab switch.
    if (this.streamingTextEl && this.streamingText) {
      this.streamingTextEl.empty();
      this.streamingTextEl.removeClass("cc-streaming-body");
      try {
        MarkdownRenderer.render(this.app, this.streamingText, this.streamingTextEl, "", this);
        this.enhanceCodeBlocks(this.streamingTextEl);
      } catch { /* fallback — leave as-is */ }
    } else if (this.streamingTextEl) {
      this.streamingTextEl.removeClass("cc-streaming-body");
    }
    if (this.currentStreamingEl) {
      this.currentStreamingEl.removeClass("is-streaming");
      this.currentStreamingEl.querySelectorAll(".cc-streaming-body").forEach((el) => {
        el.removeClass("cc-streaming-body");
      });
      // Footer row — duration + "Ask another model" forwarding action.
      const footer = this.currentStreamingEl.createDiv("cc-response-footer");
      if (this.currentAssistantMsg?.timestamp) {
        const elapsed = Math.floor((Date.now() - this.currentAssistantMsg.timestamp) / 1000);
        if (elapsed > 1) {
          const min = Math.floor(elapsed / 60);
          const sec = elapsed % 60;
          const timeStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
          footer.createSpan({ cls: "cc-response-time", text: `* Responded in ${timeStr}` });
        }
      }
      if (this.currentAssistantMsg) {
        this.attachMessageActions(footer, this.currentAssistantMsg);
      }
    }
    this.currentAssistantMsg = null;
    this.currentStreamingEl = null;
    this.streamingTextEl = null;
    this.streamingText = "";
    this._renderedToolIds.clear(); this._renderedTextHashes.clear(); this._renderedThinkingCount = 0;
    this._lastAssistantMsgId = "";
    this.editDiffShown.clear();
    this.turnCount++;

    // Update tab title from first message
    this.saveActiveTabState();
    this.renderTabBar();

    // Save session for later resume
    if (this.session?.sessionId && this.onSaveSession) {
      // Save messages without toolCalls (too large for storage)
      const savedMessages = this.messages.map(m => ({
        ...m,
        toolCalls: undefined,
        isStreaming: undefined,
      }));
      this.onSaveSession({
        sessionId: this.session.sessionId,
        firstMessage: this.firstMessageText || "New session",
        model: this.session.model,
        timestamp: Date.now(),
        messageCount: this.turnCount,
        messages: savedMessages,
      });
    }
    this.updateUI();

    // Process queued message if any
    this.processQueuedMessage();
  }

  private updateQueueIndicator(): void {
    if (!this.queueIndicatorEl) return;
    if (this.queuedMessage) {
      const preview = this.queuedMessage.length > 40
        ? this.queuedMessage.slice(0, 40) + "…"
        : this.queuedMessage;
      this.queueIndicatorEl.textContent = `Queued: ${preview}`;
      this.queueIndicatorEl.removeClass("is-hidden");
    } else {
      this.queueIndicatorEl.addClass("is-hidden");
    }
  }

  private processQueuedMessage(): void {
    if (!this.queuedMessage) return;
    const msg = this.queuedMessage;
    this.queuedMessage = null;
    this.updateQueueIndicator();
    // Put back in input and send on next tick
    this.inputEl.value = msg;
    setTimeout(() => this.sendMessage(), 0);
  }

  /** Active permission prompt cleanup — called on abort to prevent dangling promises */
  private _activePermissionCleanup: (() => void) | null = null;

  /** Inline permission prompt — replaces input area temporarily */
  private showPermissionPrompt(info: {
    toolName: string;
    input: Record<string, unknown>;
    title?: string;
    displayName?: string;
    description?: string;
  }): Promise<"allow" | "deny" | "always"> {
    return new Promise((resolve) => {
      // Create inline prompt in chat stream (not overlay — stays in flow)
      const overlay = this.chatContainer.createDiv("cc-permission-overlay");

      const card = overlay.createDiv("cc-permission-card");

      // Header
      const header = card.createDiv("cc-permission-header");
      const iconEl = header.createSpan("cc-permission-icon");
      setIcon(iconEl, "shield");
      header.createSpan({ cls: "cc-permission-title", text: info.title || `Allow ${info.displayName || info.toolName}?` });

      // Description
      if (info.description) {
        card.createDiv({ cls: "cc-permission-desc", text: info.description });
      }

      // Tool details (collapsible)
      const detailSummary = card.createDiv("cc-permission-detail-summary");
      detailSummary.createSpan({ text: info.toolName, cls: "cc-permission-tool-name" });
      const inputPreview = JSON.stringify(info.input, null, 2);
      if (inputPreview.length > 10) {
        const detailPre = card.createEl("pre", { cls: "cc-permission-input" });
        detailPre.textContent = inputPreview.length > 300 ? inputPreview.slice(0, 300) + "…" : inputPreview;
        detailPre.addClass("is-hidden");
        detailSummary.addEventListener("click", () => {
          detailPre.toggleClass("is-hidden", !detailPre.hasClass("is-hidden"));
        });
      }

      // Buttons
      const btns = card.createDiv("cc-permission-buttons");

      const denyBtn = btns.createEl("button", { cls: "cc-permission-btn cc-permission-btn-deny", text: "Deny" });
      const allowBtn = btns.createEl("button", { cls: "cc-permission-btn cc-permission-btn-allow", text: "Allow" });
      const alwaysBtn = btns.createEl("button", { cls: "cc-permission-btn cc-permission-btn-always", text: "Always allow" });

      let resolved = false;
      const cleanup = (result: "allow" | "deny" | "always") => {
        if (resolved) return;
        resolved = true;
        this._activePermissionCleanup = null;
        overlay.remove();
        resolve(result);
      };

      // Register cleanup so abort() can dismiss the prompt
      this._activePermissionCleanup = () => cleanup("deny");

      denyBtn.addEventListener("click", () => cleanup("deny"));
      allowBtn.addEventListener("click", () => cleanup("allow"));
      alwaysBtn.addEventListener("click", () => cleanup("always"));

      this.scrollToBottom();
    });
  }

  private showContextFullError(): void {
    if (!this.chatContainer) return;
    const wrapper = this.chatContainer.createDiv("claude-native-msg claude-native-msg-error");
    wrapper.createDiv({ cls: "claude-native-msg-label", text: "Context full" });
    const body = wrapper.createDiv("claude-native-msg-body");
    body.createEl("p", { text: "Context window is full. Start a new session to continue." });
    const btn = body.createEl("button", {
      cls: "katmer-report-notice-btn katmer-report-notice-btn-primary",
      text: "New session",
    });
    btn.addEventListener("click", () => this.newSession());
    this.scrollToBottom();
  }

  private showError(text: string): void {
    if (!this.chatContainer) return;
    const wrapper = this.chatContainer.createDiv("claude-native-msg claude-native-msg-error");
    wrapper.createDiv({ cls: "claude-native-msg-label", text: "Error" });
    const body = wrapper.createDiv("claude-native-msg-body");
    body.createEl("pre", { text, cls: "claude-native-error-text" });
    this.scrollToBottom();
  }

  // ── Rendering ──

  private renderUserMessage(msg: ChatMessage): void {
    // Compact synthesis pill instead of a full user bubble when this
    // wasn't actually typed by the user — keeps cross-model consult
    // flows readable.
    if (msg.synthesisMeta) {
      this.renderSynthesisPill(msg);
      return;
    }

    const wrapper = this.chatContainer.createDiv("claude-native-msg claude-native-msg-user");
    wrapper.createDiv({ cls: "claude-native-msg-label", text: "You" });

    // Show attachments (files, selections) above the message text
    if (msg.attachments && msg.attachments.length > 0) {
      const attachRow = wrapper.createDiv("cc-user-attachments");
      for (const att of msg.attachments) {
        const chip = attachRow.createDiv("cc-user-attachment");
        const icon = chip.createSpan("cc-user-attachment-icon");
        if (att.type === "file") {
          const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(att.name);
          setIcon(icon, isImage ? "image" : "file-text");
          chip.createSpan({ cls: "cc-user-attachment-name", text: att.name });
        } else {
          setIcon(icon, "quote");
          chip.createSpan({ cls: "cc-user-attachment-name", text: att.name || "Selection" });
          if (att.preview) {
            chip.createDiv({ cls: "cc-user-attachment-preview", text: att.preview });
          }
        }
      }
    }

    const body = wrapper.createDiv("claude-native-msg-body");
    MarkdownRenderer.render(this.app, msg.content, body, "", this);
  }

  /**
   * Show a small "model is thinking" placeholder right after the user's
   * (or synthesis) message goes out. Disappears as soon as the first
   * streaming/assistant event arrives.
   */
  private showThinkingPlaceholder(): void {
    this.hideThinkingPlaceholder();
    const provId = this.pm.providerId;
    const wrap = this.chatContainer.createDiv("cc-thinking-placeholder");
    wrap.dataset.provider = provId;
    const dot = wrap.createSpan({ cls: "cc-thinking-dot" });
    dot.dataset.provider = provId;
    wrap.createSpan({
      cls: "cc-thinking-text",
      text: `${PROVIDER_LABELS[provId]} is thinking`,
    });
    const dots = wrap.createSpan({ cls: "cc-thinking-dots" });
    dots.createSpan({ text: "·" });
    dots.createSpan({ text: "·" });
    dots.createSpan({ text: "·" });
    this.thinkingPlaceholder = wrap;
    this.scrollToBottom();
  }

  private hideThinkingPlaceholder(): void {
    if (this.thinkingPlaceholder) {
      this.thinkingPlaceholder.remove();
      this.thinkingPlaceholder = null;
    }
  }

  /** Compact pill for auto-synthesis follow-ups (Faz 8 consult flow). */
  private renderSynthesisPill(msg: ChatMessage): void {
    const meta = msg.synthesisMeta!;
    const pill = this.chatContainer.createDiv("cc-synthesis-pill");
    pill.dataset.consulted = meta.consultedProvider;
    const dot = pill.createSpan("cc-synthesis-pill-dot");
    dot.dataset.provider = meta.consultedProvider;
    pill.createSpan({
      cls: "cc-synthesis-pill-text",
      text: `Synthesis requested based on ${meta.consultedLabel}'s input`,
    });
    const toggle = pill.createSpan({ cls: "cc-synthesis-pill-toggle", text: "view prompt" });
    const detail = this.chatContainer.createDiv("cc-synthesis-detail is-hidden");
    detail.createEl("pre").textContent = msg.content;
    toggle.addEventListener("click", () => {
      const open = !detail.hasClass("is-hidden");
      detail.toggleClass("is-hidden", open);
      toggle.textContent = open ? "view prompt" : "hide prompt";
    });
  }

  private renderAssistantMessage(msg: ChatMessage): HTMLElement {
    const wrapper = this.chatContainer.createDiv(
      "claude-native-msg claude-native-msg-assistant" + (msg.isStreaming ? " is-streaming" : "")
    );
    wrapper.dataset.provider = this.pm.providerId;
    wrapper.createDiv({ cls: "claude-native-msg-label", text: PROVIDER_LABELS[this.pm.providerId] || "Assistant" });
    this.renderAssistantContent(wrapper, msg);
    // Restored historical messages get the same "ask another model" affordance.
    if (!msg.isStreaming) {
      const footer = wrapper.createDiv("cc-response-footer");
      this.attachMessageActions(footer, msg);
    }
    return wrapper;
  }

  private rerenderAssistant(msg: ChatMessage, el: HTMLElement): void {
    if (!msg.segments || msg.segments.length === 0) {
      // Full re-render for non-segment messages
      el.empty();
      el.createDiv({ cls: "claude-native-msg-label", text: PROVIDER_LABELS[this.pm.providerId] || "Assistant" });
      this.renderAssistantContent(el, msg);
      return;
    }

    const segments = msg.segments;

    // If segment count grew, append new segments (don't re-render old ones)
    if (segments.length > this.renderedSegmentCount) {
      for (let i = this.renderedSegmentCount; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.type === "text" && seg.text) {
          const body = el.createDiv("claude-native-msg-body");
          body.dataset.segIdx = String(i);
          MarkdownRenderer.render(this.app, seg.text, body, "", this);
        } else if (seg.type === "tool" && this.settings.showToolCalls) {
          this.renderToolCall(el, seg.tool);
        }
      }
      this.renderedSegmentCount = segments.length;
    }

    // Update the LAST text segment (streaming text grows incrementally)
    const lastSeg = segments[segments.length - 1];
    if (lastSeg?.type === "text" && lastSeg.text && lastSeg.text !== this.lastRenderedText) {
      // Find the last text body element
      const bodies = el.querySelectorAll(".claude-native-msg-body");
      const lastBody = bodies[bodies.length - 1] as HTMLElement | undefined;
      if (lastBody) {
        lastBody.empty();
        MarkdownRenderer.render(this.app, lastSeg.text, lastBody, "", this);
      }
      this.lastRenderedText = lastSeg.text;
    }
  }

  /** Render content in original order: text → tool → text → tool → text */
  private renderAssistantContent(container: HTMLElement, msg: ChatMessage): void {
    if (msg.segments && msg.segments.length > 0) {
      for (const seg of msg.segments) {
        if (seg.type === "text" && seg.text) {
          const body = container.createDiv("claude-native-msg-body");
          MarkdownRenderer.render(this.app, seg.text, body, "", this);
          this.enhanceCodeBlocks(body);
        } else if (seg.type === "tool") {
          if (seg.tool.name === "Edit" || this.settings.showToolCalls) {
            this.renderToolCall(container, seg.tool);
          }
        }
      }
    } else {
      if (msg.toolCalls && this.settings.showToolCalls) {
        for (const tc of msg.toolCalls) {
          this.renderToolCall(container, tc);
        }
      }
      if (msg.content) {
        const body = container.createDiv("claude-native-msg-body");
        MarkdownRenderer.render(this.app, msg.content, body, "", this);
      }
    }
  }

  private renderToolCall(parent: HTMLElement, tc: ToolCallInfo): void {
    // Edit tool gets special inline diff view
    if (tc.name === "Edit" && tc.input.old_string && tc.input.new_string) {
      this.renderEditDiff(parent, tc);
      return;
    }

    // Thinking block — special compact render with timer
    if (tc.name === "Thinking") {
      const panel = parent.createDiv("cc-thinking-block" + (tc.result ? " is-done" : " is-running"));
      const header = panel.createDiv("cc-thinking-header");
      const iconEl = header.createSpan("cc-thinking-icon");
      setIcon(iconEl, "cat");

      const label = header.createSpan("cc-thinking-label");
      if (tc.result) {
        // Finished — show duration
        label.textContent = tc.startTime
          ? `Thought for ${Math.floor((Date.now() - tc.startTime) / 1000)}s`
          : "Thinking";
      } else {
        // Running — live timer
        label.textContent = "Thinking 0s…";
        const start = tc.startTime || Date.now();
        const interval = setInterval(() => {
          if (tc.result || !document.contains(panel)) {
            clearInterval(interval);
            label.textContent = `Thought for ${Math.floor((Date.now() - start) / 1000)}s`;
            panel.removeClass("is-running");
            panel.addClass("is-done");
            return;
          }
          label.textContent = `Thinking ${Math.floor((Date.now() - start) / 1000)}s…`;
        }, 1000);
      }

      // Collapsible content
      if (tc.result) {
        const chevron = header.createSpan("cc-thinking-chevron");
        setIcon(chevron, "chevron-right");
        const content = panel.createDiv("cc-thinking-content");
        content.addClass("is-hidden");
        content.createEl("pre", { text: tc.result.slice(0, 2000) + (tc.result.length > 2000 ? "\n…" : "") });
        header.addEventListener("click", () => {
          const open = !content.hasClass("is-hidden");
          content.toggleClass("is-hidden", open);
          chevron.empty();
          setIcon(chevron, open ? "chevron-right" : "chevron-down");
        });
      }
      return;
    }

    const isRunning = !tc.result;
    const isAgent = tc.name === "Agent";

    const panel = parent.createDiv("claude-native-tool" + (isRunning ? " is-running" : " is-done"));
    panel.dataset.toolId = tc.id;
    const header = panel.createDiv("claude-native-tool-header");

    const iconSpan = header.createSpan("claude-native-tool-icon");
    setIcon(iconSpan, this.getToolIcon(tc.name));

    header.createSpan({ text: this.formatToolName(tc.name), cls: "claude-native-tool-name" });

    const summary = this.formatToolInput(tc.name, tc.input);
    if (summary) {
      header.createSpan({ text: summary, cls: "claude-native-tool-summary" });
    }

    // Status badge: running spinner or done checkmark
    const statusBadge = header.createSpan("cc-tool-status");
    if (isRunning) {
      statusBadge.addClass("is-running");
      statusBadge.textContent = "Running";
      // Elapsed timer for long-running tools (Agent, Bash)
      if (tc.startTime && (isAgent || tc.name === "Bash")) {
        const timerSpan = header.createSpan("cc-tool-timer");
        const updateTimer = () => {
          const elapsed = Math.floor((Date.now() - (tc.startTime || 0)) / 1000);
          if (elapsed < 60) {
            timerSpan.textContent = `${elapsed}s`;
          } else {
            const min = Math.floor(elapsed / 60);
            const sec = elapsed % 60;
            timerSpan.textContent = `${min}m ${sec}s`;
          }
        };
        updateTimer();
        const interval = setInterval(() => {
          if (tc.result || !document.contains(panel)) {
            clearInterval(interval);
            return;
          }
          updateTimer();
        }, 1000);
      }
    } else {
      statusBadge.addClass("is-done");
      setIcon(statusBadge, "check");
      // Show duration if we have startTime
      if (tc.startTime) {
        const elapsed = Math.floor((Date.now() - tc.startTime) / 1000);
        if (elapsed > 2) {
          const timerSpan = header.createSpan("cc-tool-timer");
          if (elapsed < 60) {
            timerSpan.textContent = `${elapsed}s`;
          } else {
            const min = Math.floor(elapsed / 60);
            const sec = elapsed % 60;
            timerSpan.textContent = `${min}m ${sec}s`;
          }
        }
      }
    }

    const chevron = header.createSpan("claude-native-tool-chevron");
    setIcon(chevron, "chevron-right");

    const details = panel.createDiv("claude-native-tool-details");
    details.addClass("is-hidden");

    const inputPre = details.createEl("pre", { cls: "claude-native-tool-input" });
    inputPre.createEl("code", { text: JSON.stringify(tc.input, null, 2) });

    if (tc.result) {
      const resultEl = details.createDiv("claude-native-tool-result");
      const text = tc.result.length > 2000 ? tc.result.slice(0, 2000) + "\n…" : tc.result;
      resultEl.createEl("pre").createEl("code", { text });
      if (tc.isError) resultEl.addClass("is-error");
    }

    header.addEventListener("click", () => {
      const isOpen = !details.hasClass("is-hidden");
      details.toggleClass("is-hidden", isOpen);
      chevron.empty();
      setIcon(chevron, isOpen ? "chevron-right" : "chevron-down");
    });
  }

  /**
   * Edit is auto-applied (acceptEdits). Show compact card in chat + inline diff in editor.
   * Navigation and bulk actions live in the diff bar (above input), not per-card.
   */
  private renderEditDiff(parent: HTMLElement, tc: ToolCallInfo): void {
    const filePath = typeof tc.input.file_path === "string" ? tc.input.file_path : "";
    const fileName = filePath.split("/").pop() || "unknown";
    const oldStr = typeof tc.input.old_string === "string" ? tc.input.old_string : "";
    const newStr = typeof tc.input.new_string === "string" ? tc.input.new_string : "";

    // Compact card — just file name + status, no nav buttons
    const panel = parent.createDiv("claude-native-diff");
    panel.dataset.toolId = tc.id;
    const header = panel.createDiv("claude-native-diff-header");
    const iconSpan = header.createSpan("claude-native-tool-icon");
    setIcon(iconSpan, "pencil");
    header.createSpan({ text: fileName, cls: "claude-native-diff-title" });
    const statusSpan = header.createSpan({ cls: "claude-native-diff-status is-accepted", text: "Applied" });

    // Only trigger showEditInEditor for LIVE edits (not resumed/re-rendered ones)
    if (!this.editDiffShown.has(tc.id) && this._isLiveSession) {
      this.editDiffShown.add(tc.id);
      void this.showEditInEditor(filePath, oldStr, newStr, tc.id, panel, statusSpan);
    }
  }

  /** Get CM6 EditorView for a given file path (if open) */
  private getEditorForFile(filePath: string): EditorView | null {
    const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath || "";
    let relativePath = filePath;
    if (filePath.startsWith(vaultPath)) {
      relativePath = filePath.slice(vaultPath.length).replace(/^\//, "");
    }
    const leaf = this.app.workspace.getLeavesOfType("markdown")
      .find(l => (l.view as { file?: TFile }).file?.path === relativePath);
    if (!leaf) return null;
    const obsEditor = (leaf.view as { editor?: { cm?: EditorView } }).editor;
    return obsEditor?.cm || null;
  }

  /** Open file, show inline diff with CM6 position-tracked decorations. */
  private async showEditInEditor(
    filePath: string, oldStr: string, newStr: string,
    toolUseId: string, chatPanel: HTMLElement, statusSpan: HTMLElement
  ): Promise<void> {
    const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath || "";
    let relativePath = filePath;
    if (filePath.startsWith(vaultPath)) {
      relativePath = filePath.slice(vaultPath.length).replace(/^\//, "");
    }

    const file = this.app.vault.getAbstractFileByPath(relativePath);
    if (!file || !(file instanceof TFile)) return;

    // Reuse existing tab or open new
    let leaf = this.app.workspace.getLeavesOfType("markdown")
      .find(l => (l.view as { file?: TFile }).file?.path === relativePath);
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.openFile(file);
    }

    // Ensure file is in editing mode (reading mode has no editor)
    const leafView = leaf.view as ItemView & { getMode?: () => string };
    if (leafView?.getMode?.() === "preview") {
      const state = leaf.getViewState();
      state.state = { ...state.state, mode: "source" };
      await leaf.setViewState(state);
    }

    // Retry with increasing delay — file/editor might not be synced yet
    const tryShowDiff = (attempt: number) => {
      const obsEditor = (leaf!.view as { editor?: { cm?: EditorView } }).editor;
      if (!obsEditor?.cm) {
        if (attempt < 5) setTimeout(() => tryShowDiff(attempt + 1), 500);
        return;
      }
      const cmView = obsEditor.cm;

      const content = cmView.state.doc.toString();
      const idx = content.indexOf(newStr);
      if (idx === -1) {
        if (attempt < 8) setTimeout(() => tryShowDiff(attempt + 1), 800);
        return;
      }

      const from = idx;
      const to = idx + newStr.length;
      const changeId = `change-${toolUseId}-${from}`;

      // Track file for diff bar
      this.diffBarFilePath = filePath;

      // Scroll to the edit
      cmView.dispatch({
        effects: EditorView.scrollIntoView(from, { y: "center" }),
      });

      // Add position-tracked change to registry
      cmView.dispatch({
        effects: addChange.of({
          id: changeId,
          from,
          to,
          originalText: oldStr,
          newText: newStr,
          status: "pending",
          filePath,
          toolUseId,
        }),
      });

      // Update chat panel with change count
      this.updateDiffSummary(cmView, statusSpan);

      // Poll registry for status changes (accept/reject from editor buttons)
      const pollInterval = setInterval(() => {
        if (!document.contains(chatPanel)) {
          clearInterval(pollInterval);
          return;
        }
        // Guard: editor may have been closed/reopened — field might not exist
        try {
          const changes = cmView.state.field(changeRegistry);
          const thisChange = changes.find(c => c.id === changeId);
          if (!thisChange) {
            clearInterval(pollInterval);
            return;
          }
          if (thisChange.status === "accepted") {
            statusSpan.textContent = "Accepted";
            statusSpan.className = "claude-native-diff-status is-accepted";
            clearInterval(pollInterval);
          } else if (thisChange.status === "rejected") {
            statusSpan.textContent = "Undone";
            statusSpan.className = "claude-native-diff-status is-rejected";
            chatPanel.addClass("is-rejected");
            clearInterval(pollInterval);
          }
          this.updateDiffSummary(cmView, statusSpan);
        } catch {
          // Editor closed or extension not present — stop polling
          clearInterval(pollInterval);
        }
      }, 500);
    };
    setTimeout(() => tryShowDiff(0), 400);
  }

  /** Update the status span with change summary */
  private updateDiffSummary(cmView: EditorView, statusSpan: HTMLElement): void {
    const summary = getChangeSummary(cmView);
    if (summary.pending > 0) {
      statusSpan.textContent = `${summary.pending} pending`;
      statusSpan.className = "claude-native-diff-status is-pending";
    } else if (summary.total > 0) {
      statusSpan.textContent = "Done";
      statusSpan.className = "claude-native-diff-status is-accepted";
    }
    this.refreshDiffBar();
  }

  /** Show/hide/update the diff bar above input */
  private refreshDiffBar(): void {
    if (!this.diffBar) return;
    const cmView = this.getEditorForFile(this.diffBarFilePath);
    if (!cmView) {
      this.diffBar.addClass("is-hidden");
      return;
    }
    const summary = getChangeSummary(cmView);
    if (summary.pending === 0) {
      this.diffBar.addClass("is-hidden");
      return;
    }
    this.diffBar.removeClass("is-hidden");
    const fileName = this.diffBarFilePath.split("/").pop() || "";
    this.diffBarLabel.textContent = `${fileName} · ${summary.pending} change${summary.pending > 1 ? "s" : ""}`;
  }

  // (word-level diff now handled by editor-extension.ts via commonPrefix/commonSuffix)

  /** Add language labels + copy buttons to rendered code blocks */
  private enhanceCodeBlocks(container: HTMLElement): void {
    const codeBlocks = container.querySelectorAll("pre > code");
    for (const code of Array.from(codeBlocks)) {
      const pre = code.parentElement;
      if (!pre || pre.querySelector(".cc-code-header")) continue;

      // Detect language from class (e.g. "language-typescript")
      const langClass = Array.from(code.classList).find(c => c.startsWith("language-"));
      const lang = langClass ? langClass.replace("language-", "") : "";

      // Header bar
      const header = document.createElement("div");
      header.className = "cc-code-header";

      if (lang) {
        const langLabel = document.createElement("span");
        langLabel.className = "cc-code-lang";
        langLabel.textContent = lang;
        header.appendChild(langLabel);
      }

      const copyBtn = document.createElement("button");
      copyBtn.className = "cc-code-copy";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", () => {
        void navigator.clipboard.writeText(code.textContent || "");
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      });
      header.appendChild(copyBtn);

      pre.insertBefore(header, pre.firstChild);
    }
  }

  // ── UI state ──

  private updateUI(): void {
    const running = this.pm.isRunning;

    // Header buttons — abort only when running, new tab always visible
    if (this.abortBtn) this.abortBtn.toggleClass("is-hidden", !running);

    // Bottom row: toggle send/stop buttons
    if (this.sendBtn) this.sendBtn.toggleClass("is-hidden", running);
    if (this._stopBtn) this._stopBtn.toggleClass("is-hidden", !running);

    // Status bar
    if (!this.statusBar) return;
    if (running) {
      this.statusBar.textContent = this.currentActivity || "Thinking…";
      this.statusBar.className = "claude-native-status is-thinking";
      return;
    }
    this.currentActivity = "";

    const parts: string[] = [];
    if (this.session) {
      const modelShort = this.session.model.replace("claude-", "").replace("[1m]", "");
      parts.push(modelShort);

      const connected = this.session.mcpServers.filter((s) => s.status === "connected");
      if (connected.length > 0) parts.push(`${connected.length} MCP`);

      if (this.settings.showCostInfo && this.session.totalCost > 0) {
        parts.push(`$${this.session.totalCost.toFixed(3)}`);
      }
    }

    this.statusBar.textContent = parts.length > 0 ? parts.join(" · ") : "Ready";
    this.statusBar.className = "claude-native-status" + (this.session ? " is-connected" : "");
  }

  /** Reset textarea height to auto (used after sending) */
  private resetInputHeight(): void {
    this.inputEl.setCssProps({ "--cc-input-height": "auto" });
  }

  /** Auto-resize textarea to fit content */
  private autoResizeInput(): void {
    this.inputEl.setCssProps({ "--cc-input-height": "auto" });
    this.inputEl.setCssProps({ "--cc-input-height": Math.min(this.inputEl.scrollHeight, 160) + "px" });
  }

  /**
   * Sticky-bottom auto-scroll: only forces the chat to the bottom if the
   * user was already pinned there. If they've scrolled up to read an older
   * message, leave them alone (and surface a "↓ new" indicator separately
   * — TODO once the message renderer is split out).
   */
  private scrollToBottom(): void {
    const el = this.chatContainer;
    if (!el) return;
    const threshold = 80; // px from bottom counts as "at bottom"
    const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    const userAtBottom = distanceFromBottom <= threshold;
    if (!userAtBottom) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }

  // ── Helpers ──

  private getToolIcon(name: string): string {
    if (name === "Read") return "file-text";
    if (name === "Edit") return "pencil";
    if (name === "Write") return "file-plus";
    if (name === "Bash") return "terminal";
    if (name === "Glob" || name === "Grep") return "search";
    if (name.startsWith("mcp__")) return "plug";
    return "wrench";
  }

  private formatToolName(name: string): string {
    if (name.startsWith("mcp__")) {
      const parts = name.split("__");
      return parts.length >= 3 ? `${parts[1]}.${parts.slice(2).join(".")}` : name;
    }
    return name;
  }

  private formatToolInput(name: string, input: Record<string, unknown>): string {
    if ((name === "Read" || name === "Edit" || name === "Write") && typeof input.file_path === "string") {
      return input.file_path.split("/").pop() || "";
    }
    if (name === "Bash" && typeof input.command === "string") {
      return input.command.length > 50 ? input.command.slice(0, 50) + "…" : input.command;
    }
    if (name === "Grep" && typeof input.pattern === "string") return `/${input.pattern}/`;
    if (name === "Glob" && typeof input.pattern === "string") return input.pattern;
    return "";
  }
}
