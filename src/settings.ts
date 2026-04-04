import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type ClaudeNativePlugin from "./main";
import { SKILL_CATALOG, CATEGORY_LABELS, type ModelChoice, type PermissionMode } from "./types";

export class ClaudeNativeSettingTab extends PluginSettingTab {
  plugin: ClaudeNativePlugin;

  constructor(app: App, plugin: ClaudeNativePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("CLI path")
      .setDesc("Path to the claude code CLI executable.")
      .addText((text) =>
        text
          .setPlaceholder("/usr/local/bin/claude")
          .setValue(this.plugin.settings.cliPath)
          .onChange((value) => {
            this.plugin.settings.cliPath = value;
            void this.plugin.saveSettings();
          })
      );

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
