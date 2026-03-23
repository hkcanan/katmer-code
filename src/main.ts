import { Plugin, FuzzySuggestModal, Notice, App } from "obsidian";
import { ClaudeChatView, VIEW_TYPE_CLAUDE } from "./chat-view";
import { ReportView, VIEW_TYPE_REPORT } from "./report-view";
import { ClaudeNativeSettingTab } from "./settings";
import { DEFAULT_SETTINGS, SKILL_CATALOG, type ClaudeNativeSettings, type SavedSession } from "./types";
import { inlineDiffExtensions } from "./editor-extension";
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync, readdirSync, watch } from "fs";
import { join } from "path";
import { homedir } from "os";
// Electron shell — accessed via window.require (Obsidian's Electron runtime)
const electronShell = (window as unknown as { require: (m: string) => Record<string, unknown> }).require("electron").shell as { openPath: (path: string) => Promise<string> };

// Skill contents bundled at build time (esbuild loader: { ".md": "text" })
// @ts-ignore
import skillPeerReview from "./skills/peer-review.md";
// @ts-ignore
import skillCiteVerify from "./skills/cite-verify.md";
// @ts-ignore
import skillLitSearch from "./skills/lit-search.md";
// @ts-ignore
import skillCitationNetwork from "./skills/citation-network.md";
// @ts-ignore
import skillAbstract from "./skills/abstract.md";
// @ts-ignore
import skillJournalMatch from "./skills/journal-match.md";
// @ts-ignore
import skillResearchGap from "./skills/research-gap.md";
// @ts-ignore
import skillReportTemplate from "./skills/report-template.md";

const BUNDLED_SKILLS: Record<string, string> = {
  "peer-review": skillPeerReview,
  "cite-verify": skillCiteVerify,
  "lit-search": skillLitSearch,
  "citation-network": skillCitationNetwork,
  "abstract": skillAbstract,
  "journal-match": skillJournalMatch,
  "research-gap": skillResearchGap,
  "report-template": skillReportTemplate,
};

const SKILLS_DIR = join(homedir(), ".claude", "commands");

export default class ClaudeNativePlugin extends Plugin {
  settings: ClaudeNativeSettings = DEFAULT_SETTINGS;

  // Skill file contents (bundled at build time or read from plugin dir)
  private skillContents: Record<string, string> = {};

  /** Get the active chat view via getLeavesOfType (avoids memory leak) */
  private getChatView(): ClaudeChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE);
    if (leaves.length > 0) return leaves[0].view as ClaudeChatView;
    return null;
  }

  async onload(): Promise<void> {
    await this.loadSettings();
    this.loadSkillContents();
    this.syncSkills();

    // Register the chat view
    this.registerView(VIEW_TYPE_CLAUDE, (leaf) => {
      const view = new ClaudeChatView(leaf, this.settings);
      // Wire up session saving
      view.onSaveSession = (session) => void this.saveSession(session);
      view.onShowSessionPicker = () => void this.showSessionPicker();
      return view;
    });

    // Ribbon icon
    this.addRibbonIcon("cat", "KatmerCode", () => {
      void this.activateView();
    });

    // Commands
    this.addCommand({
      id: "open-claude-chat",
      name: "Open Claude Code chat",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "new-claude-session",
      name: "New Claude Code session",
      callback: async () => {
        await this.activateView();
        this.getChatView()?.startNewSession();
      },
    });

    this.addCommand({
      id: "resume-claude-session",
      name: "Resume Claude Code session",
      callback: () => void this.showSessionPicker(),
    });

    // Register report viewer
    this.registerView(VIEW_TYPE_REPORT, (leaf) => new ReportView(leaf));

    this.addCommand({
      id: "open-report",
      name: "Open HTML report in viewer",
      callback: () => void this.pickAndOpenReport(),
    });

    // Watch reports/ for new HTML files
    this.setupReportWatcher();

    // CM6 inline diff extension
    this.registerEditorExtension(inlineDiffExtensions);

    // @codemirror/merge tested — incompatible with Obsidian's CM6 (DeletionWidget viewport crash).
    // Using custom StateField-based inline diff (editor-extension.ts).

    // Settings tab
    this.addSettingTab(new ClaudeNativeSettingTab(this.app, this));
  }

  private _reportWatcher: ReturnType<typeof watch> | null = null;

  onunload(): void {
    // Clean up persistent CLI process
    void this.getChatView()?.onClose();
    // Skills stay installed — they're global (~/.claude/commands/) and useful outside the plugin.
    // Removing them on every Obsidian quit would break the "available in all sessions" promise.
    // Skills are only removed when explicitly disabled in settings (syncSkills handles that).
    // Stop report watcher
    if (this._reportWatcher) {
      this._reportWatcher.close();
      this._reportWatcher = null;
    }
  }

  /** Remove all KatmerCode-owned skill files from ~/.claude/commands/ */
  private cleanupSkills(): void {
    for (const skill of SKILL_CATALOG) {
      const targetPath = join(SKILLS_DIR, skill.fileName);
      if (existsSync(targetPath)) {
        try {
          const existing = readFileSync(targetPath, "utf-8");
          if (existing.startsWith("<!-- KatmerCode skill:")) {
            unlinkSync(targetPath);
          }
        } catch { /* ignore */ }
      }
    }
  }

  // ── Report Viewer ──

  async openReport(filePath: string): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VIEW_TYPE_REPORT, active: true });
    const rv = leaf.view as unknown as ReportView;
    if (rv?.loadReport) await rv.loadReport(filePath);
    this.app.workspace.revealLeaf(leaf);
  }

  private pickAndOpenReport(): void {
    const reportsDir = join(
      (this.app.vault.adapter as { basePath?: string }).basePath || "", "reports"
    );
    try {
      const files = readdirSync(reportsDir)
        .filter(f => f.endsWith(".html"))
        .sort().reverse();
      if (files.length === 0) {
        new Notice("No reports found in reports/");
        return;
      }
      const modal = new ReportPickerModal(this.app, files, reportsDir, (fp) => void this.openReport(fp));
      modal.open();
    } catch {
      new Notice("Could not read reports/");
    }
  }

  private setupReportWatcher(): void {
    const reportsDir = join(
      (this.app.vault.adapter as { basePath?: string }).basePath || "", "reports"
    );
    try {
      if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
      const known = new Set<string>(
        readdirSync(reportsDir).filter(f => f.endsWith(".html"))
      );
      this._reportWatcher = watch(reportsDir, (_eventType: string, filename: string) => {
        if (!filename || !filename.endsWith(".html")) return;
        const fullPath = join(reportsDir, filename);
        if (!existsSync(fullPath) || known.has(filename)) return;
        known.add(filename);
        // Wait for file to be fully written
        setTimeout(() => {
          const label = filename.replace(".html", "").replace(/-/g, " ");
          const notice = new Notice("", 0);
          const el = notice.messageEl;
          el.empty();
          el.addClass("katmer-report-notice");
          el.createEl("div", { cls: "katmer-report-notice-title", text: "Report ready" });
          el.createEl("div", { cls: "katmer-report-notice-file", text: label });
          const btnRow = el.createDiv("katmer-report-notice-buttons");

          const openBtn = btnRow.createEl("button", {
            cls: "katmer-report-notice-btn katmer-report-notice-btn-primary",
            text: "Open in app",
          });
          openBtn.addEventListener("click", () => { void this.openReport(fullPath); notice.hide(); });

          const browserBtn = btnRow.createEl("button", {
            cls: "katmer-report-notice-btn",
            text: "Open in browser",
          });
          browserBtn.addEventListener("click", () => {
            void electronShell.openPath(fullPath);
            notice.hide();
          });

          const dismissBtn = btnRow.createEl("button", {
            cls: "katmer-report-notice-btn katmer-report-notice-btn-dismiss",
            text: "\u2715",
          });
          dismissBtn.addEventListener("click", () => { notice.hide(); });
        }, 1500);
      });
    } catch (err) {
      console.error("[katmer-code] Report watcher error:", err);
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.sessions) this.settings.sessions = [];
    if (!this.settings.enabledSkills) this.settings.enabledSkills = [];
  }

  /** Load skill contents from bundled imports (no filesystem dependency) */
  private loadSkillContents(): void {
    for (const skill of SKILL_CATALOG) {
      const content = BUNDLED_SKILLS[skill.id];
      if (content) {
        this.skillContents[skill.id] = content;
      } else {
        // Skill not bundled — skip
      }
    }
    // Skills loaded
  }

  /** Sync enabled skills to ~/.claude/commands/ */
  syncSkills(): void {
    try {
      // Ensure ~/.claude/commands/ exists
      if (!existsSync(SKILLS_DIR)) {
        mkdirSync(SKILLS_DIR, { recursive: true });
      }

      for (const skill of SKILL_CATALOG) {
        const targetPath = join(SKILLS_DIR, skill.fileName);
        const enabled = this.settings.enabledSkills.includes(skill.id);
        const content = this.skillContents[skill.id];

        if (enabled && content) {
          // Only write if file doesn't exist OR if it's ours (has our header)
          let canWrite = true;
          if (existsSync(targetPath)) {
            try {
              const existing = readFileSync(targetPath, "utf-8");
              if (!existing.startsWith("<!-- KatmerCode skill:")) {
                // File exists and belongs to user — don't overwrite
                // User-owned file exists — skip, Notice already shown
                new Notice(`Skill "${skill.name}" not installed: ~/.claude/commands/${skill.fileName} already exists (not owned by KatmerCode).`);
                canWrite = false;
              }
            } catch { /* if we can't read, try to write anyway */ }
          }
          if (canWrite) {
            const header = `<!-- KatmerCode skill: ${skill.id} -->\n`;
            writeFileSync(targetPath, header + content, "utf-8");
          }
        } else if (!enabled) {
          // Only delete if we created it (check for our header)
          if (existsSync(targetPath)) {
            try {
              const existing = readFileSync(targetPath, "utf-8");
              if (existing.startsWith("<!-- KatmerCode skill:")) {
                unlinkSync(targetPath);
              }
            } catch { /* ignore */ }
          }
        }
      }
    } catch (err) {
      console.error("[katmer-code] syncSkills error:", err);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.getChatView()?.updateSettings(this.settings);
  }

  /** Save or update a session in history */
  private async saveSession(session: SavedSession): Promise<void> {
    const idx = this.settings.sessions.findIndex(s => s.sessionId === session.sessionId);
    if (idx >= 0) {
      this.settings.sessions[idx] = session;
    } else {
      this.settings.sessions.unshift(session);
    }
    // Keep max 50 sessions
    if (this.settings.sessions.length > 50) {
      this.settings.sessions = this.settings.sessions.slice(0, 50);
    }
    await this.saveData(this.settings);
  }

  /** Show fuzzy picker to resume a session */
  private async showSessionPicker(): Promise<void> {
    // Open session picker
    await this.activateView();

    if (!this.settings.sessions || this.settings.sessions.length === 0) {
      new Notice("No saved sessions yet.");
      return;
    }

    const modal = new SessionPickerModal(this.app, this.settings.sessions, (session) => {
      this.getChatView()?.resumeSession(session.sessionId, session.messages);
    });
    modal.open();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CLAUDE)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        await rightLeaf.setViewState({
          type: VIEW_TYPE_CLAUDE,
          active: true,
        });
        leaf = rightLeaf;
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }
}

/** Fuzzy search modal for session history */
class SessionPickerModal extends FuzzySuggestModal<SavedSession> {
  private sessions: SavedSession[];
  private onChoose: (session: SavedSession) => void;

  constructor(app: import("obsidian").App, sessions: SavedSession[], onChoose: (s: SavedSession) => void) {
    super(app);
    this.sessions = sessions;
    this.onChoose = onChoose;
    this.setPlaceholder("Search sessions…");
  }

  getItems(): SavedSession[] {
    return this.sessions;
  }

  getItemText(session: SavedSession): string {
    const date = new Date(session.timestamp).toLocaleDateString();
    return `${session.firstMessage} — ${session.model} · ${date}`;
  }

  onChooseItem(session: SavedSession): void {
    this.onChoose(session);
  }
}

/** Fuzzy search modal for report files */
class ReportPickerModal extends FuzzySuggestModal<string> {
  private files: string[];
  private dir: string;
  private onChooseFn: (path: string) => void;

  constructor(app: App, files: string[], dir: string, onChoose: (path: string) => void) {
    super(app);
    this.files = files;
    this.dir = dir;
    this.onChooseFn = onChoose;
    this.setPlaceholder("Select a report\u2026");
  }

  getItems() { return this.files; }
  getItemText(file: string) { return file.replace(".html", "").replace(/-/g, " "); }
  onChooseItem(file: string) { this.onChooseFn(join(this.dir, file)); }
}
