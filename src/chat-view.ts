import { ItemView, MarkdownRenderer, WorkspaceLeaf, setIcon, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import { addInlineDiff, clearInlineDiff } from "./editor-extension";
import { ProcessManager } from "./process-manager";
import type {
  ClaudeEvent,
  AssistantMessageEvent,
  SystemInitEvent,
  ResultEvent,
  StreamDeltaEvent,
  ChatMessage,
  ContentSegment,
  ToolCallInfo,
  SessionInfo,
  ClaudeNativeSettings,
  ModelChoice,
  EffortLevel,
  SavedSession,
} from "./types";
import { MODEL_LABELS, EFFORT_LABELS, SKILL_CATALOG } from "./types";

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
  private contextLabel!: HTMLElement;
  private modelBtns!: Record<ModelChoice, HTMLElement>;
  private effortBtns!: Record<EffortLevel, HTMLElement>;
  private _stopBtn!: HTMLElement;

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

  // Pending edit proposals
  private pendingEdits: Array<{
    filePath: string;
    oldString: string;
    newString: string;
    banner: HTMLElement | null;
  }> = [];

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
  private _lastAssistantMsgId: string = "";
  private firstMessageText: string = "";
  private turnCount: number = 0;

  // Callbacks to plugin
  onSaveSession: ((session: SavedSession) => void) | null = null;
  onShowSessionPicker: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, settings: ClaudeNativeSettings) {
    super(leaf);
    this.settings = settings;
    this.pm = new ProcessManager(settings);
    this.pm.model = settings.defaultModel as any || "sonnet";
    this.pm.onEvent = (e) => this.handleEvent(e);
    this.pm.onStateChange = (s) => this.updateUI();
    this.pm.onComplete = () => this.onResponseComplete();
    this.pm.onPermissionRequest = (info) => this.showPermissionPrompt(info);
    this.pm.onStderr = (text) => {
      // Only show real errors, not CLI warnings
      const ignore = ["CPU lacks AVX", "warn:", "no stdin data", "Warning:", "deprecat"];
      if (!ignore.some(w => text.includes(w))) {
        // Check for auth/login errors
        if (text.includes("not logged in") || text.includes("authenticate") || text.includes("API key") || text.includes("unauthorized")) {
          this.showError("Not logged in. Please run `claude` in your terminal first to authenticate, then reload this plugin.");
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
    this.liveProgressEl.style.display = "none";

    this.emptyState = this.chatContainer.createDiv("claude-native-empty");
    this.emptyState.empty();
    this.emptyState.createDiv({ cls: "claude-native-empty-title", text: "KatmerCode" });
    this.emptyState.createDiv({ cls: "claude-native-empty-subtitle", text: "Checking Claude Code CLI\u2026" });

    // ── Input area — single box like claude.ai ──
    const inputArea = container.createDiv("cc-input-area");
    const inputBox = inputArea.createDiv("cc-input-box");

    // Queue indicator (inside the box, top)
    this.queueIndicatorEl = inputBox.createDiv("cc-queue-indicator");
    this.queueIndicatorEl.style.display = "none";

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

    // Model selector trigger
    const modelTrigger = bottomRow.createDiv("cc-model-trigger");
    const modelLabel = modelTrigger.createSpan({ cls: "cc-model-text", text: MODEL_LABELS[this.pm.model] });
    const modelChevron = modelTrigger.createSpan("cc-chevron");
    setIcon(modelChevron, "chevron-down");

    // Stop button (visible when running)
    this._stopBtn = bottomRow.createEl("button", { cls: "cc-stop-btn", attr: { "aria-label": "Stop" } });
    setIcon(this._stopBtn, "square");
    this._stopBtn.addEventListener("click", () => this.pm.abort());

    // Send button
    this.sendBtn = bottomRow.createEl("button", { cls: "cc-send-btn", attr: { "aria-label": "Send" } });
    setIcon(this.sendBtn, "arrow-up");

    // ── Model/effort popup ──
    const popup = inputArea.createDiv("cc-popup");
    popup.style.display = "none";

    const MODEL_DESCS: Record<string, string> = {
      "opus[1m]": "Most capable, 1M extended context",
      opus: "Most capable, 200K context",
      sonnet: "Balanced for everyday tasks",
      haiku: "Fastest for quick answers",
    };

    this.modelBtns = {} as Record<ModelChoice, HTMLElement>;
    for (const key of ["opus[1m]", "opus", "sonnet", "haiku"] as ModelChoice[]) {
      const item = popup.createDiv("cc-popup-item" + (key === this.pm.model ? " is-active" : ""));
      item.createDiv({ cls: "cc-popup-item-name", text: MODEL_LABELS[key] });
      item.createDiv({ cls: "cc-popup-item-desc", text: MODEL_DESCS[key] });
      item.addEventListener("click", () => {
        this.selectModel(key);
        modelLabel.textContent = MODEL_LABELS[key];
        popup.querySelectorAll(".cc-popup-item").forEach(el => el.removeClass("is-active"));
        item.addClass("is-active");
        popup.style.display = "none";
      });
      this.modelBtns[key] = item;
    }

    popup.createDiv("cc-popup-divider");

    // Effort inside popup
    const effortSection = popup.createDiv("cc-popup-effort");
    effortSection.createDiv({ cls: "cc-popup-effort-title", text: "Effort level" });
    const effortRow = effortSection.createDiv("cc-popup-effort-row");

    this.effortBtns = {} as Record<EffortLevel, HTMLElement>;
    for (const key of ["low", "medium", "high", "max"] as EffortLevel[]) {
      const pill = effortRow.createEl("button", {
        cls: "cc-pill" + (key === this.pm.effort ? " is-active" : ""),
        text: EFFORT_LABELS[key],
      });
      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        this.selectEffort(key);
        effortRow.querySelectorAll(".cc-pill").forEach(el => el.removeClass("is-active"));
        pill.addClass("is-active");
      });
      this.effortBtns[key] = pill;
    }

    // Toggle
    modelTrigger.addEventListener("click", () => {
      popup.style.display = popup.style.display === "none" ? "block" : "none";
    });
    document.addEventListener("click", (e) => {
      if (!inputArea.contains(e.target as Node)) popup.style.display = "none";
    });

    // Skill autocomplete popup (positioned above input)
    this.skillPopup = inputBox.createDiv("cc-skill-popup");
    this.skillPopup.style.display = "none";

    // Auto-resize textarea + skill autocomplete
    this.inputEl.addEventListener("input", () => {
      this.inputEl.style.height = "auto";
      this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 160) + "px";
      this.updateSkillPopup();
    });

    this.inputEl.addEventListener("keydown", (e) => {
      // Skill popup navigation
      if (this.skillPopup && this.skillPopup.style.display !== "none") {
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
          const selected = items[this.skillSelectedIdx] as HTMLElement;
          if (selected) this.applySkillCompletion(selected.dataset.skill || "");
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.skillPopup.style.display = "none";
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
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
    this.inputEl.addEventListener("paste", async (e) => {
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
          const tmpDir = require("os").tmpdir();
          const tmpPath = require("path").join(tmpDir, tmpName);
          const buffer = Buffer.from(await blob.arrayBuffer());
          require("fs").writeFileSync(tmpPath, buffer);
          this.attachedImages.push({ path: tmpPath, name: tmpName });
          this.renderAttachmentCards();
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

      let getPath: (f: File) => string | undefined;
      try {
        const { webUtils } = require("electron");
        getPath = (f: File) => webUtils.getPathForFile(f);
      } catch {
        getPath = (f: File) => (f as any).path;
      }

      for (const file of Array.from(files)) {
        const filePath = getPath(file);
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
    this.checkCli().then(() => this.preWarmQuery());
  }

  /** Start SDK query early so first message is instant */
  private preWarmQuery(): void {
    const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
    const cwd = this.settings.workingDirectory || vaultPath || undefined;
    this.pm.warmUp(cwd);
  }

  private async checkCli(): Promise<void> {
    const { execFile } = require("child_process");
    const cliPath = this.settings.cliPath || "claude";

    // Build same env as ProcessManager
    const env = { ...process.env };
    const home = env.HOME || require("os").homedir();
    env.HOME = home;
    const { join } = require("path");
    const extraPaths = ["/usr/local/bin", "/opt/homebrew/bin", join(home, ".local", "bin"), "/usr/bin"];
    env.PATH = [env.PATH, ...extraPaths].filter(Boolean).join(":");

    try {
      await new Promise<string>((resolve, reject) => {
        execFile(cliPath, ["--version"], { env, timeout: 5000 }, (err: Error | null, stdout: string) => {
          if (err) reject(err);
          else resolve(stdout.trim());
        });
      });
      // CLI found
      if (this.emptyState) {
        this.emptyState.empty();
        this.emptyState.createDiv({ cls: "claude-native-empty-title", text: "KatmerCode" });
        this.emptyState.createDiv({ cls: "claude-native-empty-subtitle", text: "Send a message to start" });
      }
      if (this.statusBar) this.statusBar.textContent = "Ready";
    } catch {
      // CLI not found
      if (this.emptyState) {
        this.emptyState.empty();
        this.emptyState.createDiv({ cls: "claude-native-empty-title", text: "Claude Code CLI not found" });
        const setup = this.emptyState.createDiv("claude-native-empty-setup");
        setup.createEl("p").createEl("strong", { text: "Step 1: Install Claude Code" });
        setup.createEl("pre", { text: "npm install -g @anthropic-ai/claude-code" });
        setup.createEl("p").createEl("strong", { text: "Step 2: Log in (run once in terminal)" });
        setup.createEl("pre", { text: "claude" });
        setup.createEl("p").createEl("strong", { text: "Step 3: Reload this plugin" });
        setup.createEl("p", { cls: "claude-native-empty-hint", text: "If Claude is installed but not found, set the full path in plugin settings." });
      }
      if (this.statusBar) {
        this.statusBar.textContent = "CLI not found";
        this.statusBar.className = "claude-native-status";
      }
    }
  }

  // ── Skill Autocomplete ──

  /** Fetch SDK commands lazily (once, after first session starts) */
  private async fetchSdkCommands(): Promise<void> {
    if (this.sdkCommandsFetched) return;
    try {
      // Access the active query's supportedCommands — requires ProcessManager to expose it
      // For now, we'll populate from the SDK on first system init event
    } catch { /* ignore */ }
  }

  /** Called when system init event arrives — fetch SDK commands */
  private async loadSdkCommands(): Promise<void> {
    if (this.sdkCommandsFetched) return;
    try {
      const q = this.pm.query;
      if (!q) return;
      const cmds = await q.supportedCommands();
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
      this.skillPopup.style.display = "none";
      return;
    }

    // Hide if there's a space (command already selected, user typing args)
    if (text.includes(" ")) {
      this.skillPopup.style.display = "none";
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
      this.skillPopup.style.display = "none";
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
      }
      item.addEventListener("click", () => {
        if (cmd.enabled) this.applySkillCompletion(cmd.name);
      });
    }

    this.skillPopup.style.display = "block";
  }

  private highlightSkillItem(items: NodeListOf<Element>): void {
    items.forEach((el, i) => {
      el.toggleClass("is-selected", i === this.skillSelectedIdx);
    });
    // Scroll into view
    const selected = items[this.skillSelectedIdx] as HTMLElement;
    if (selected) selected.scrollIntoView({ block: "nearest" });
  }

  private applySkillCompletion(skillName: string): void {
    // Replace the "/..." with the skill name + a trailing space
    this.inputEl.value = skillName + " ";
    this.inputEl.focus();
    if (this.skillPopup) this.skillPopup.style.display = "none";
    // Move cursor to end
    this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
  }

  /** Update progress indicator — both status bar and inline chat */
  private updateProgress(toolName: string, input: Record<string, unknown>): void {
    let detail = "";
    let icon = "loader";

    if (toolName === "Read" && input.file_path) {
      const path = String(input.file_path);
      detail = path.split("/").pop() || path;
      icon = "file-text";
    } else if (toolName === "Edit" && input.file_path) {
      const path = String(input.file_path);
      detail = path.split("/").pop() || path;
      icon = "pencil";
    } else if (toolName === "Write" && input.file_path) {
      const path = String(input.file_path);
      detail = path.split("/").pop() || path;
      icon = "file-plus";
    } else if (toolName === "Bash" && input.command) {
      detail = String(input.command).slice(0, 50);
      icon = "terminal";
    } else if (toolName === "WebFetch" && input.url) {
      try {
        detail = new URL(String(input.url)).hostname;
      } catch {
        detail = String(input.url).slice(0, 30);
      }
      icon = "globe";
    } else if (toolName === "WebSearch" && input.query) {
      detail = String(input.query).slice(0, 40);
      icon = "search";
    } else if (toolName === "Grep" && input.pattern) {
      detail = `"${String(input.pattern).slice(0, 25)}"`;
      icon = "search";
    } else if (toolName === "Agent" && input.description) {
      detail = String(input.description).slice(0, 40);
      icon = "cpu";
    } else if (toolName === "Thinking") {
      this.currentActivity = "Thinking…";
      this.showLiveProgress("cat", "Thinking…");
      this.updateUI();
      return;
    }

    this.currentActivity = detail ? `${toolName}: ${detail}` : toolName;
    this.showLiveProgress(icon, this.currentActivity);
    this.updateUI();
  }

  private progressStartTime: number = 0;
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  /** Show/update the live progress element in chat stream */
  private showLiveProgress(icon: string, text: string): void {
    if (!this.liveProgressEl) return;
    this.liveProgressEl.empty();
    this.liveProgressEl.style.display = "flex";

    // Start timer if not already running
    if (!this.progressStartTime) this.progressStartTime = Date.now();

    const iconEl = this.liveProgressEl.createSpan("cc-live-progress-icon");
    setIcon(iconEl, icon);

    const textEl = this.liveProgressEl.createSpan({ cls: "cc-live-progress-text", text });
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
      this.liveProgressEl.style.display = "none";
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
    fileInput.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
    document.body.appendChild(fileInput);

    fileInput.addEventListener("change", () => {
      const files = fileInput.files;
      if (!files) return;

      // Electron 32+: file.path is removed, use webUtils.getPathForFile()
      let getPath: (f: File) => string | undefined;
      try {
        const { webUtils } = require("electron");
        getPath = (f: File) => webUtils.getPathForFile(f);
      } catch {
        getPath = (f: File) => (f as any).path;
      }

      for (const file of Array.from(files)) {
        const filePath = getPath(file);
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
    this.pm.destroy();
  }

  updateSettings(settings: ClaudeNativeSettings): void {
    this.settings = settings;
    this.pm.updateSettings(settings);
  }

  // ── Model & Thinking selectors ──

  private selectModel(model: ModelChoice): void {
    this.pm.model = model;
    // Notify SDK of model change at runtime (no restart needed)
    this.pm.setModelRuntime(model);
    for (const [key, btn] of Object.entries(this.modelBtns)) {
      btn.toggleClass("is-active", key === model);
    }
  }

  private selectEffort(level: EffortLevel): void {
    this.pm.effort = level;
    for (const [key, btn] of Object.entries(this.effortBtns)) {
      btn.toggleClass("is-active", key === level);
    }
    if (this.pm.query) {
      new (require("obsidian").Notice)("Effort change applies on next session", 2000);
    }
  }

  private updateContextBar(): void {
    if (!this.session || !this.contextBar || !this.contextLabel) return;

    const contextTokens = this.session.inputTokens
      + (this.session.cacheCreationTokens || 0)
      + (this.session.cacheReadTokens || 0);
    const contextWindow = this.session.contextWindow || 200000;
    const pct = Math.round(Math.min((contextTokens / contextWindow) * 100, 100));
    const warning = pct > 80;

    const fmtK = (n: number) => n >= 1000 ? Math.round(n / 1000) + "K" : String(n);
    this.contextLabel.textContent = `${fmtK(contextTokens)} / ${fmtK(contextWindow)} (${pct}%)`;
    this.contextLabel.style.color = warning ? "#E57373" : "";

    // Tooltip with compact suggestion
    const tooltip = warning
      ? `${fmtK(contextTokens)} / ${fmtK(contextWindow)} — run /compact to continue`
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
      this.inputEl.style.height = "auto";
      this.updateQueueIndicator();
      return;
    }

    // Slash commands (e.g. /compact, /citation-network) must be sent as-is
    // — the CLI subprocess handles them internally.
    // Do NOT wrap with context, or the CLI won't recognize them as commands.
    const isSlashCommand = text.startsWith("/");

    // Build full message with context
    let fullMessage = text;

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
    if (this.emptyState) this.emptyState.style.display = "none";

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
    this.inputEl.style.height = "auto";
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

    // Show "Thinking..." immediately — don't wait for first event
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
    if (this.emptyState) this.emptyState.style.display = "none";

    // Restore saved messages
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

    this.updateUI();
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
    };
    this.tabs = [tab];
    this.activeTabId = tab.id;
  }

  private addNewTab(): void {
    // Save current tab state
    this.saveActiveTabState();

    const tab: TabState = {
      id: crypto.randomUUID(),
      title: "New chat",
      messages: [],
      session: null,
      sessionId: null,
      firstMessageText: "",
      turnCount: 0,
    };
    this.tabs.push(tab);
    this.switchToTab(tab.id);
    this.renderTabBar();
  }

  private switchToTab(tabId: string): void {
    if (tabId === this.activeTabId) return;

    // Save current tab
    this.saveActiveTabState();

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

    // Switch SDK session
    this.pm.newSession();
    if (tab.sessionId) {
      this.pm.setSessionId(tab.sessionId);
    }

    // Re-render chat
    this.chatContainer.empty();
    if (this.messages.length === 0) {
      this.emptyState = this.chatContainer.createDiv("claude-native-empty");
      this.emptyState.empty();
      this.emptyState.createDiv({ cls: "claude-native-empty-title", text: "KatmerCode" });
      this.emptyState.createDiv({ cls: "claude-native-empty-subtitle", text: "Send a message to start" });
    } else {
      for (const msg of this.messages) {
        if (msg.role === "user") this.renderUserMessage(msg);
        else if (msg.role === "assistant") this.renderAssistantMessage(msg);
      }
    }

    this.renderTabBar();
    this.updateUI();
    this.updateContextBar();
  }

  private closeTab(tabId: string): void {
    if (this.tabs.length <= 1) return; // can't close last tab

    const idx = this.tabs.findIndex(t => t.id === tabId);
    if (idx === -1) return;

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
      this.tabBarEl.style.display = "none";
      return;
    }
    this.tabBarEl.style.display = "flex";

    for (const tab of this.tabs) {
      const tabEl = this.tabBarEl.createDiv(
        "cc-tab" + (tab.id === this.activeTabId ? " is-active" : "")
      );

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
    if ((event as any).subtype === "compact_boundary") {
      const divider = this.chatContainer.createDiv("cc-compact-divider");
      const line = divider.createDiv("cc-compact-line");
      const label = divider.createSpan({ cls: "cc-compact-label", text: "Context compacted" });
      const line2 = divider.createDiv("cc-compact-line");
      this.scrollToBottom();
      return;
    }

    if (event.subtype === "init") {
      // Fallback context window — will be updated from result event's modelUsage
      const model = event.model || "unknown";
      const contextWindow = 200000; // conservative default, real value comes from SDK result

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
      this.loadSdkCommands();
    }
  }

  /**
   * Handle streaming text deltas — render text character by character.
   * When the full assistant message arrives, it replaces this streaming text.
   */
  private handleStreamDelta(event: StreamDeltaEvent): void {
    this.streamingText += event.text;
    // (streaming text will be replaced by proper markdown when assistant event arrives)

    // Ensure we have a streaming container
    if (!this.currentStreamingEl) {
      if (this.emptyState) this.emptyState.style.display = "none";
      this.currentStreamingEl = this.chatContainer.createDiv(
        "claude-native-msg claude-native-msg-assistant is-streaming"
      );
      this.currentStreamingEl.createDiv({ cls: "claude-native-msg-label", text: "Claude" });
      this.streamingTextEl = this.currentStreamingEl.createDiv("claude-native-msg-body cc-streaming-body");
    }

    if (!this.streamingTextEl) {
      this.streamingTextEl = this.currentStreamingEl!.createDiv("claude-native-msg-body cc-streaming-body");
    }

    // Render streaming text (use textContent for speed, markdown on complete)
    this.streamingTextEl.textContent = this.streamingText;
    this.scrollToBottom();
  }

  private handleAssistantEvent(event: AssistantMessageEvent): void {
    // Skip subagent messages — only show main agent's output
    if (event.parent_tool_use_id) return;

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
      if (this.emptyState) this.emptyState.style.display = "none";
      this.currentStreamingEl = this.chatContainer.createDiv(
        "claude-native-msg claude-native-msg-assistant is-streaming"
      );
      this.currentStreamingEl.createDiv({ cls: "claude-native-msg-label", text: "Claude" });
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
        const textHash = block.text.slice(0, 100) + "|" + block.text.length;
        if (this._renderedTextHashes.has(textHash)) continue;
        this._renderedTextHashes.add(textHash);

        // Remove streaming body if exists (stream_delta showed this as plain text)
        if (this.streamingTextEl) {
          this.streamingTextEl.remove();
          this.streamingTextEl = null;
          this.streamingText = "";
        }

        this.currentAssistantMsg.content += block.text;
        this.currentAssistantMsg.segments!.push({ type: "text", text: block.text });
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
          input: (block.input as Record<string, unknown>) || {},
          startTime: Date.now(),
        };
        this.currentAssistantMsg.toolCalls!.push(tc);
        this.currentAssistantMsg.segments!.push({ type: "tool", tool: tc });
        if (tc.name === "Edit" || this.settings.showToolCalls) {
          this.renderToolCall(el, tc);
        }
        this.updateProgress(block.name, block.input as Record<string, unknown>);
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
          const toolEl = el.querySelector(`[data-tool-id="${targetTool.id}"] .cc-tool-status.is-running`) as HTMLElement;
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
      // Extract context window size from modelUsage (only window, NOT tokens — those are aggregate)
      const raw = event as unknown as Record<string, unknown>;
      if (raw.modelUsage && typeof raw.modelUsage === "object") {
        const models = raw.modelUsage as Record<string, { contextWindow?: number }>;
        for (const m of Object.values(models)) {
          if (m.contextWindow) this.session.contextWindow = m.contextWindow;
        }
      }
      this.updateContextBar();
    }
  }

  private onResponseComplete(): void {
    this.hideLiveProgress();

    if (this.pm.state === "error" && !this.currentAssistantMsg) {
      this.showError("Claude CLI exited with an error. Check Obsidian console (Cmd+Opt+I) for details.");
    }
    // Finalize streaming state
    if (this.currentAssistantMsg) {
      this.currentAssistantMsg.isStreaming = false;
    }
    if (this.currentStreamingEl) {
      this.currentStreamingEl.removeClass("is-streaming");
      // Duration footer with flavor word
      if (this.currentAssistantMsg?.timestamp) {
        const elapsed = Math.floor((Date.now() - this.currentAssistantMsg.timestamp) / 1000);
        if (elapsed > 1) {
          const verbs = ["Cogitated", "Ruminated", "Deliberated", "Pondered", "Synthesized", "Distilled", "Fermented", "Percolated", "Marinated", "Incubated", "Churned", "Concocted"];
          const verb = verbs[Math.floor(Math.random() * verbs.length)];
          const footer = this.currentStreamingEl.createDiv("cc-response-footer");
          const min = Math.floor(elapsed / 60);
          const sec = elapsed % 60;
          const timeStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
          footer.textContent = `* ${verb} for ${timeStr}`;
        }
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
      this.queueIndicatorEl.style.display = "block";
    } else {
      this.queueIndicatorEl.style.display = "none";
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
      detailSummary.createSpan({ text: `${info.toolName}`, cls: "cc-permission-tool-name" });
      const inputPreview = JSON.stringify(info.input, null, 2);
      if (inputPreview.length > 10) {
        const detailPre = card.createEl("pre", { cls: "cc-permission-input" });
        detailPre.textContent = inputPreview.length > 300 ? inputPreview.slice(0, 300) + "…" : inputPreview;
        detailPre.style.display = "none";
        detailSummary.addEventListener("click", () => {
          detailPre.style.display = detailPre.style.display === "none" ? "block" : "none";
        });
      }

      // Buttons
      const btns = card.createDiv("cc-permission-buttons");

      const denyBtn = btns.createEl("button", { cls: "cc-permission-btn cc-permission-btn-deny", text: "Deny" });
      const allowBtn = btns.createEl("button", { cls: "cc-permission-btn cc-permission-btn-allow", text: "Allow" });
      const alwaysBtn = btns.createEl("button", { cls: "cc-permission-btn cc-permission-btn-always", text: "Always allow" });

      const cleanup = (result: "allow" | "deny" | "always") => {
        overlay.remove();
        resolve(result);
      };

      denyBtn.addEventListener("click", () => cleanup("deny"));
      allowBtn.addEventListener("click", () => cleanup("allow"));
      alwaysBtn.addEventListener("click", () => cleanup("always"));

      this.scrollToBottom();
    });
  }

  private showContextFullError(): void {
    if (!this.chatContainer) return;
    const wrapper = this.chatContainer.createDiv("claude-native-msg claude-native-msg-error");
    wrapper.createDiv({ cls: "claude-native-msg-label", text: "Context Full" });
    const body = wrapper.createDiv("claude-native-msg-body");
    body.createEl("p", { text: "Context window is full. Start a new session to continue." });
    const btn = body.createEl("button", {
      cls: "katmer-report-notice-btn katmer-report-notice-btn-primary",
      text: "New Session",
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

  private renderAssistantMessage(msg: ChatMessage): HTMLElement {
    const wrapper = this.chatContainer.createDiv(
      "claude-native-msg claude-native-msg-assistant" + (msg.isStreaming ? " is-streaming" : "")
    );
    wrapper.createDiv({ cls: "claude-native-msg-label", text: "Claude" });
    this.renderAssistantContent(wrapper, msg);
    return wrapper;
  }

  private rerenderAssistant(msg: ChatMessage, el: HTMLElement): void {
    if (!msg.segments || msg.segments.length === 0) {
      // Full re-render for non-segment messages
      el.empty();
      el.createDiv({ cls: "claude-native-msg-label", text: "Claude" });
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
      const lastBody = bodies[bodies.length - 1] as HTMLElement | null;
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
        content.style.display = "none";
        content.createEl("pre", { text: tc.result.slice(0, 2000) + (tc.result.length > 2000 ? "\n…" : "") });
        header.addEventListener("click", () => {
          const open = content.style.display !== "none";
          content.style.display = open ? "none" : "block";
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
      statusBadge.textContent = "running";
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
    details.style.display = "none";

    const inputPre = details.createEl("pre", { cls: "claude-native-tool-input" });
    inputPre.createEl("code", { text: JSON.stringify(tc.input, null, 2) });

    if (tc.result) {
      const resultEl = details.createDiv("claude-native-tool-result");
      const text = tc.result.length > 2000 ? tc.result.slice(0, 2000) + "\n…" : tc.result;
      resultEl.createEl("pre").createEl("code", { text });
      if (tc.isError) resultEl.addClass("is-error");
    }

    header.addEventListener("click", () => {
      const isOpen = details.style.display !== "none";
      details.style.display = isOpen ? "none" : "block";
      chevron.empty();
      setIcon(chevron, isOpen ? "chevron-right" : "chevron-down");
    });
  }

  /**
   * Edit is auto-applied (acceptEdits). Show diff in chat + open file with undo banner.
   */
  private renderEditDiff(parent: HTMLElement, tc: ToolCallInfo): void {
    const filePath = String(tc.input.file_path || "");
    const fileName = filePath.split("/").pop() || "unknown";
    const oldStr = String(tc.input.old_string || "");
    const newStr = String(tc.input.new_string || "");

    // Compact indicator in chat
    const panel = parent.createDiv("claude-native-diff");
    const header = panel.createDiv("claude-native-diff-header");
    const iconSpan = header.createSpan("claude-native-tool-icon");
    setIcon(iconSpan, "pencil");
    header.createSpan({ text: fileName, cls: "claude-native-diff-title" });

    const statusSpan = header.createSpan({ cls: "claude-native-diff-status is-accepted", text: "Applied" });

    // Only trigger showEditInEditor ONCE per edit (cumulative re-renders would re-trigger)
    if (!this.editDiffShown.has(tc.id)) {
      this.editDiffShown.add(tc.id);
      this.showEditInEditor(filePath, oldStr, newStr, panel, statusSpan);
    }
  }

  /** Open file, show inline diff with CM6 decorations. Edit is already applied. */
  private async showEditInEditor(
    filePath: string, oldStr: string, newStr: string,
    chatPanel: HTMLElement, statusSpan: HTMLElement
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
    const leafView = leaf.view as any;
    if (leafView?.getMode?.() === "preview") {
      // Switch to editing mode
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
        // File might not be refreshed yet — retry with longer delay
        if (attempt < 8) setTimeout(() => tryShowDiff(attempt + 1), 800);
        return;
      }

      const from = idx;
      const to = idx + newStr.length;

      // Scroll to the edit
      cmView.dispatch({
        effects: EditorView.scrollIntoView(from, { y: "center" }),
      });

      // Add inline diff decorations
      cmView.dispatch({
        effects: addInlineDiff.of({
          from,
          to,
          oldText: oldStr,
          newText: newStr,
          onAccept: () => {
            statusSpan.textContent = "Accepted";
            statusSpan.className = "claude-native-diff-status is-accepted";
          },
          onReject: (view: EditorView) => {
            // Revert: replace new_string back with old_string
            const curContent = view.state.doc.toString();
            const curIdx = curContent.indexOf(newStr);
            if (curIdx !== -1) {
              view.dispatch({
                changes: { from: curIdx, to: curIdx + newStr.length, insert: oldStr },
              });
            }
            statusSpan.textContent = "Undone";
            statusSpan.className = "claude-native-diff-status is-rejected";
            chatPanel.addClass("is-rejected");
          },
        }),
      });
    };
    setTimeout(() => tryShowDiff(0), 400);
  }

  // ── Word-level diff ──

  /** Find words/phrases in newStr that don't exist in oldStr */
  private findChangedWords(oldStr: string, newStr: string): Array<{ start: number; end: number }> {
    // Split into words, find which segments in newStr are new
    const oldWords = new Set(oldStr.split(/(\s+)/).filter(w => w.trim()));
    const results: Array<{ start: number; end: number }> = [];

    // Simple approach: find contiguous new segments
    const newWords = newStr.split(/(\s+)/);
    let pos = 0;
    let inNew = false;
    let segStart = 0;

    for (const word of newWords) {
      const isWhitespace = !word.trim();
      const isOld = oldWords.has(word);

      if (!isWhitespace && !isOld) {
        if (!inNew) {
          segStart = pos;
          inNew = true;
        }
      } else if (inNew && !isWhitespace) {
        results.push({ start: segStart, end: pos });
        inNew = false;
      }
      pos += word.length;
    }
    if (inNew) {
      results.push({ start: segStart, end: pos });
    }

    return results;
  }

  /** Render text with highlighted spans for changed words */
  private renderWithHighlights(
    el: HTMLElement,
    text: string,
    highlights: Array<{ start: number; end: number }>
  ): void {
    let lastEnd = 0;
    for (const h of highlights) {
      // Text before highlight
      if (h.start > lastEnd) {
        el.appendText(text.slice(lastEnd, h.start));
      }
      // Highlighted span
      el.createSpan({
        cls: "claude-native-diff-word-new",
        text: text.slice(h.start, h.end),
      });
      lastEnd = h.end;
    }
    // Remaining text
    if (lastEnd < text.length) {
      el.appendText(text.slice(lastEnd));
    }
  }

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
        navigator.clipboard.writeText(code.textContent || "");
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

    // Header buttons
    if (this.abortBtn) this.abortBtn.style.display = running ? "flex" : "none";
    if (this.newSessionBtn) this.newSessionBtn.style.display = running ? "none" : "flex";

    // Bottom row: toggle send/stop buttons
    if (this.sendBtn) this.sendBtn.style.display = running ? "none" : "flex";
    if (this._stopBtn) this._stopBtn.style.display = running ? "flex" : "none";

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

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
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
    if ((name === "Read" || name === "Edit" || name === "Write") && input.file_path) {
      return String(input.file_path).split("/").pop() || "";
    }
    if (name === "Bash" && input.command) {
      const cmd = String(input.command);
      return cmd.length > 50 ? cmd.slice(0, 50) + "…" : cmd;
    }
    if (name === "Grep" && input.pattern) return `/${input.pattern}/`;
    if (name === "Glob" && input.pattern) return String(input.pattern);
    return "";
  }
}
