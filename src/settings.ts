import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type ClaudeNativePlugin from "./main";
import {
  SKILL_CATALOG,
  CATEGORY_LABELS,
  PROVIDER_LABELS,
  PROVIDER_INSTALL_HINTS,
  type ModelChoice,
  type PermissionMode,
  type ProviderId,
} from "./types";
import { createProvider } from "./providers";

export class ClaudeNativeSettingTab extends PluginSettingTab {
  plugin: ClaudeNativePlugin;

  /**
   * CLI detection cache. `detectCli()` spawns `which` and friends — running
   * it for every provider on every settings re-render makes the Settings
   * tab visibly stutter when the user opens it. Cache for the lifetime of
   * the tab instance; reset on path overrides.
   */
  private cliProbeCache = new Map<ProviderId, { found: boolean; path?: string; authenticated?: boolean; loginHint?: string }>();

  constructor(app: App, plugin: ClaudeNativePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private probeCli(id: ProviderId): { found: boolean; path?: string; authenticated?: boolean; loginHint?: string } {
    let cached = this.cliProbeCache.get(id);
    if (!cached) {
      cached = createProvider(id, this.plugin.settings).detectCli();
      this.cliProbeCache.set(id, cached);
    }
    return cached;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Provider selection ──
    new Setting(containerEl).setName("AI provider").setHeading();
    containerEl.createEl("p", {
      text: "Choose which backend powers the chat. Each provider needs its own CLI installed and authenticated.",
      cls: "setting-item-description",
    });

    const PROVIDERS: ProviderId[] = ["claude", "gemini", "codex", "antigravity"];

    new Setting(containerEl)
      .setName("Default provider")
      .setDesc("New chat tabs start with this provider; existing tabs switch on save.")
      .addDropdown((dropdown) => {
        for (const id of PROVIDERS) {
          dropdown.addOption(id, PROVIDER_LABELS[id]);
        }
        dropdown
          .setValue(this.plugin.settings.defaultProvider || "claude")
          .onChange((value) => {
            this.plugin.settings.defaultProvider = value as ProviderId;
            void this.plugin.saveSettings();
            this.display();
          });
      });

    // Per-provider CLI path overrides + detection + auth status (cached).
    for (const id of PROVIDERS) {
      const cfg = this.plugin.settings.providers?.[id] || { cliPath: "" };
      const probe = this.probeCli(id);
      const statusText = !probe.found
        ? `✗ not found — ${PROVIDER_INSTALL_HINTS[id]}`
        : probe.authenticated === false
          ? `⚠ found but not logged in — run: ${probe.loginHint || "<login command>"}`
          : `✓ ready · ${probe.path}`;

      new Setting(containerEl)
        .setName(`${PROVIDER_LABELS[id]} CLI path`)
        .setDesc(statusText)
        .addText((text) =>
          text
            .setPlaceholder("auto-detect")
            .setValue(cfg.cliPath)
            .onChange((value) => {
              if (!this.plugin.settings.providers) {
                this.plugin.settings.providers = { claude: { cliPath: "" }, gemini: { cliPath: "" }, codex: { cliPath: "" }, antigravity: { cliPath: "" } };
              }
              this.plugin.settings.providers[id] = { cliPath: value };
              // Path override means re-probing is required next time.
              this.cliProbeCache.delete(id);
              void this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("")
      .addButton((btn) =>
        btn.setButtonText("Refresh CLI detection").onClick(() => {
          this.cliProbeCache.clear();
          this.display();
        })
      );

    // ── Shared instructions ──────────────────────────────────────
    new Setting(containerEl).setName("Shared instructions").setHeading();
    containerEl.createEl("p", {
      text: "Mirror CLAUDE.md to each provider's instructions file so the same rules reach every model. Both scopes are handled:",
      cls: "setting-item-description",
    });
    const scopeList = containerEl.createEl("ul");
    scopeList.style.cssText = "font-size:12px;color:var(--text-muted);margin:6px 0 12px 18px;line-height:1.6;";
    scopeList.createEl("li", { text: "Global: ~/CLAUDE.md → ~/.gemini/GEMINI.md + ~/.codex/AGENTS.md" });
    scopeList.createEl("li", { text: "Vault: <vault>/CLAUDE.md → <vault>/GEMINI.md + <vault>/AGENTS.md" });
    containerEl.createEl("p", {
      text: "Files you wrote by hand are left alone — only files tagged with the KatmerCode header are overwritten.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Auto-mirror CLAUDE.md to other providers")
      .setDesc("Copies on startup, watches both global and vault sources for changes, and re-syncs on edit.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.mirrorClaudeMd).onChange((value) => {
          this.plugin.settings.mirrorClaudeMd = value;
          void this.plugin.saveSettings();
          if (value) {
            this.plugin.startClaudeMdMirror();
            const r = this.plugin.mirrorClaudeMdNow();
            if (!r.sourceFound) {
              new Notice("No CLAUDE.md found at ~/CLAUDE.md, ~/.claude/CLAUDE.md, or <vault>/CLAUDE.md.", 6000);
            } else {
              const scopeStr = r.scopes.length > 1 ? "global + vault" : r.scopes[0];
              new Notice(`Mirrored ${scopeStr} CLAUDE.md → ${r.copied} file(s)${r.skipped.length ? ` (${r.skipped.length} skipped, user-owned)` : ""}.`, 5000);
            }
          } else {
            this.plugin.removeClaudeMdMirror();
            new Notice("Mirror disabled and KatmerCode-owned copies removed.", 4000);
          }
          this.display();
        })
      );

    if (this.plugin.settings.mirrorClaudeMd) {
      new Setting(containerEl)
        .setName("Sync now")
        .setDesc("Force a one-time re-copy in case a target file changed externally.")
        .addButton((btn) =>
          btn.setButtonText("Sync now").onClick(() => {
            const r = this.plugin.mirrorClaudeMdNow();
            if (!r.sourceFound) new Notice("No CLAUDE.md source found.", 4000);
            else {
              const scopeStr = r.scopes.length > 1 ? "global + vault" : r.scopes[0];
              new Notice(`Synced ${scopeStr} → ${r.copied} file(s)${r.skipped.length ? `, ${r.skipped.length} skipped.` : "."}`, 4000);
            }
          })
        );
    }

    new Setting(containerEl)
      .setName("Working directory")
      .setDesc("Default working directory for sessions (empty = vault root).")
      .addText((text) =>
        text
          .setPlaceholder("/path/to/project")
          .setValue(this.plugin.settings.workingDirectory)
          .onChange((value) => {
            this.plugin.settings.workingDirectory = value;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Default model")
      .setDesc("Model used for new sessions.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            "opus[1m]": "Opus 1M (most capable, extended context)",
            opus: "Opus (most capable, 200K context)",
            sonnet: "Sonnet (balanced, 200K context)",
            haiku: "Haiku (fast, 200K context)",
          })
          .setValue(this.plugin.settings.defaultModel)
          .onChange((value) => {
            this.plugin.settings.defaultModel = value as ModelChoice;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Permission mode")
      .setDesc("How tool approvals are handled. 'accept edits' auto-approves file changes only.")
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            default: "Default (ask for everything)",
            acceptEdits: "Accept edits (auto-approve file changes)",
            bypassPermissions: "Bypass all (auto-approve everything)",
          })
          .setValue(this.plugin.settings.permissionMode)
          .onChange((value) => {
            this.plugin.settings.permissionMode = value as PermissionMode;
            void this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Allow web requests")
      .setDesc("Auto-approve WebFetch, WebSearch, curl, python3, and open commands. Required for academic skills (/lit-search, /cite-verify, etc.).")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.allowWebRequests).onChange((value) => {
          this.plugin.settings.allowWebRequests = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show tool calls")
      .setDesc("Display tool call panels in the chat.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showToolCalls).onChange((value) => {
          this.plugin.settings.showToolCalls = value;
          void this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Show cost info")
      .setDesc("Display token usage and cost in the status bar")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showCostInfo).onChange((value) => {
          this.plugin.settings.showCostInfo = value;
          void this.plugin.saveSettings();
        })
      );

    // ── Skills ──
    new Setting(containerEl).setName("Academic skills").setHeading();
    containerEl.createEl("p", {
      text: "Enable skills to add slash commands. Enabled skills are installed to ~/.claude/commands/ and available in all sessions.",
      cls: "setting-item-description katmer-skills-desc",
    });

    // Bulk actions
    new Setting(containerEl)
      .setName("Bulk actions")
      .addButton((btn) =>
        btn.setButtonText("Enable all").onClick(() => {
          this.plugin.settings.enabledSkills = SKILL_CATALOG.map(s => s.id);
          if (!this.plugin.settings.allowWebRequests) {
            this.plugin.settings.allowWebRequests = true;
            new Notice(`${SKILL_CATALOG.length} skills enabled + web requests allowed`);
          } else {
            new Notice(`${SKILL_CATALOG.length} skills enabled`);
          }
          void this.plugin.saveSettings();
          this.plugin.syncSkills();
          this.display();
        })
      )
      .addButton((btn) =>
        btn.setButtonText("Disable all").onClick(() => {
          this.plugin.settings.enabledSkills = [];
          void this.plugin.saveSettings();
          this.plugin.syncSkills();
          new Notice("All skills disabled");
          this.display();
        })
      );

    // Group by category
    const categories = [...new Set(SKILL_CATALOG.map(s => s.category))];

    for (const cat of categories) {
      const skills = SKILL_CATALOG.filter(s => s.category === cat);
      const label = CATEGORY_LABELS[cat] || cat;

      new Setting(containerEl).setName(label).setHeading();

      for (const skill of skills) {
        const enabled = this.plugin.settings.enabledSkills.includes(skill.id);

        new Setting(containerEl)
          .setName(skill.name)
          .setDesc(skill.description)
          .addToggle((toggle) =>
            toggle.setValue(enabled).onChange((value) => {
              if (value) {
                if (!this.plugin.settings.enabledSkills.includes(skill.id)) {
                  this.plugin.settings.enabledSkills.push(skill.id);
                }
                // Warn if web access not enabled (most skills need it)
                if (!this.plugin.settings.allowWebRequests && skill.id !== "abstract" && skill.id !== "report-template") {
                  new Notice("This skill uses web APIs. Enable \"allow web requests\" above for it to work.", 8000);
                }
              } else {
                this.plugin.settings.enabledSkills =
                  this.plugin.settings.enabledSkills.filter(id => id !== skill.id);
              }
              void this.plugin.saveSettings();
              this.plugin.syncSkills();
            })
          );
      }
    }
  }
}
