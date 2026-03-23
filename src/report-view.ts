import { ItemView, WorkspaceLeaf } from "obsidian";
import { readFileSync } from "fs";

export const VIEW_TYPE_REPORT = "katmer-report-view";

export class ReportView extends ItemView {
  filePath = "";
  fileName = "";
  private frameEl: HTMLIFrameElement | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_REPORT; }
  getDisplayText(): string { return this.fileName || "Report"; }
  getIcon(): string { return "file-chart"; }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("katmer-report-root");
    this.frameEl = container.createEl("iframe", {
      cls: "katmer-report-frame",
      attr: { sandbox: "allow-scripts allow-same-origin", frameborder: "0" },
    });
    if (this.filePath) this.loadReport(this.filePath);
  }

  async loadReport(filePath: string): Promise<void> {
    this.filePath = filePath;
    this.fileName = filePath.split("/").pop() || "Report";
    (this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
    try {
      const content = readFileSync(filePath, "utf-8");
      if (this.frameEl) this.frameEl.srcdoc = content;
    } catch {
      const container = this.containerEl.children[1] as HTMLElement;
      container.empty();
      container.createEl("div", {
        cls: "katmer-report-error",
        text: "Could not load: " + filePath,
      });
    }
  }

  async onClose(): Promise<void> { /* no-op */ }
}
