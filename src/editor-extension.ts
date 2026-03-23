import { StateField, StateEffect, RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, WidgetType, EditorView } from "@codemirror/view";
import * as DiffMatchPatchModule from "diff-match-patch";

const DiffMatchPatch = (DiffMatchPatchModule as unknown as { default: typeof DiffMatchPatchModule }).default || DiffMatchPatchModule;
const dmp = new DiffMatchPatch();

// ══════════════════════════════════════
//  Data Model
// ══════════════════════════════════════

export interface InlineChange {
  id: string;
  from: number;
  to: number;
  originalText: string;
  newText: string;
  status: "pending" | "accepted" | "rejected";
  filePath: string;
  toolUseId: string;
}

// ══════════════════════════════════════
//  State Effects
// ══════════════════════════════════════

export const addChange = StateEffect.define<InlineChange>();
export const acceptChange = StateEffect.define<string>();
export const rejectChange = StateEffect.define<string>();
export const clearAllChanges = StateEffect.define<void>();

// ══════════════════════════════════════
//  Semantic diff via diff-match-patch
// ══════════════════════════════════════

/** DIFF_DELETE = -1, DIFF_EQUAL = 0, DIFF_INSERT = 1 */
type DiffOp = [number, string];

/**
 * Compute a semantic diff between old and new text.
 * Returns operations: [-1, deleted], [0, equal], [1, inserted]
 * Cleaned up at word/sentence boundaries for readability.
 */
function semanticDiff(oldText: string, newText: string): DiffOp[] {
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);
  return diffs;
}

// ══════════════════════════════════════
//  Content-based re-anchoring
// ══════════════════════════════════════

function findNearest(doc: string, needle: string, hint: number): number {
  if (needle.length === 0) return -1;
  if (hint >= 0 && hint + needle.length <= doc.length) {
    if (doc.slice(hint, hint + needle.length) === needle) return hint;
  }
  const firstIdx = doc.indexOf(needle);
  if (firstIdx === -1) return -1;
  const secondIdx = doc.indexOf(needle, firstIdx + 1);
  if (secondIdx === -1) return firstIdx;
  let best = firstIdx;
  let bestDist = Math.abs(firstIdx - hint);
  let searchFrom = secondIdx;
  while (searchFrom !== -1) {
    const dist = Math.abs(searchFrom - hint);
    if (dist < bestDist) { best = searchFrom; bestDist = dist; }
    searchFrom = doc.indexOf(needle, searchFrom + 1);
  }
  return best;
}

function reanchorChanges(changes: InlineChange[], doc: string): InlineChange[] {
  const claimed = new Set<string>();
  return changes.map(c => {
    if (c.status !== "pending") return c;
    if (c.from >= 0 && c.to <= doc.length) {
      const slice = doc.slice(c.from, c.to);
      if (slice === c.newText) {
        claimed.add(`${c.from}:${c.to}`);
        return c;
      }
    }
    const idx = findNearest(doc, c.newText, c.from);
    if (idx === -1) return { ...c, status: "rejected" as const };
    const key = `${idx}:${idx + c.newText.length}`;
    if (claimed.has(key)) return { ...c, status: "rejected" as const };
    claimed.add(key);
    return { ...c, from: idx, to: idx + c.newText.length };
  });
}

// ══════════════════════════════════════
//  Widgets
// ══════════════════════════════════════

class DeletedTextWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: DeletedTextWidget) { return this.text === other.text; }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cc-deleted-inline";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() { return true; }
}

class ChangeHoverWidget extends WidgetType {
  constructor(private changeId: string) { super(); }
  eq(other: ChangeHoverWidget) { return this.changeId === other.changeId; }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cc-hover-actions";
    wrap.dataset.changeId = this.changeId;

    const accept = document.createElement("button");
    accept.className = "cc-hover-btn cc-hover-accept";
    accept.innerHTML = "✓";
    accept.title = "Accept";
    accept.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      view.dispatch({ effects: acceptChange.of(this.changeId) });
    });

    const reject = document.createElement("button");
    reject.className = "cc-hover-btn cc-hover-reject";
    reject.innerHTML = "✕";
    reject.title = "Undo";
    reject.addEventListener("click", (e) => {
      e.preventDefault(); e.stopPropagation();
      rejectSingleChange(view, this.changeId);
    });

    wrap.appendChild(accept);
    wrap.appendChild(reject);
    return wrap;
  }

  ignoreEvent() { return false; }
}

// ══════════════════════════════════════
//  Change Registry
// ══════════════════════════════════════

export const changeRegistry = StateField.define<InlineChange[]>({
  create() { return []; },

  update(changes, tr) {
    for (const effect of tr.effects) {
      if (effect.is(addChange)) {
        changes = [...changes, effect.value];
      }
      if (effect.is(acceptChange)) {
        changes = changes.map(c =>
          c.id === effect.value ? { ...c, status: "accepted" as const } : c
        );
      }
      if (effect.is(rejectChange)) {
        changes = changes.map(c =>
          c.id === effect.value ? { ...c, status: "rejected" as const } : c
        );
      }
      if (effect.is(clearAllChanges)) {
        changes = [];
      }
    }

    if (tr.docChanged && changes.some(c => c.status === "pending")) {
      const doc = tr.state.doc.toString();
      changes = reanchorChanges(changes, doc);
    }

    return changes;
  },
});

// ══════════════════════════════════════
//  Decorations — semantic diff powered
// ══════════════════════════════════════

const changeDecorations = StateField.define<DecorationSet>({
  create() { return Decoration.none; },

  update(_decos, tr) {
    const changes = tr.state.field(changeRegistry);
    const pending = changes.filter(c => c.status === "pending");
    if (pending.length === 0) return Decoration.none;

    const sorted = [...pending].sort((a, b) => a.from - b.from);
    const builder = new RangeSetBuilder<Decoration>();
    const docLen = tr.state.doc.length;

    for (const change of sorted) {
      const { from, to, originalText, newText, id } = change;
      if (from < 0 || to > docLen || from > to) continue;

      // Compute semantic diff between old and new
      const diffs = semanticDiff(originalText, newText);

      // Walk through diffs, mapping to document positions
      // `pos` tracks where we are inside newText (which is in the document at from..to)
      let pos = from;

      for (const [op, text] of diffs) {
        if (op === 0) {
          // EQUAL — skip forward in document
          pos += text.length;
        } else if (op === -1) {
          // DELETE — show as strikethrough widget at current position
          if (text.length > 0 && pos >= 0 && pos <= docLen) {
            builder.add(pos, pos, Decoration.widget({
              widget: new DeletedTextWidget(text),
              side: -1,
            }));
          }
          // Don't advance pos — deleted text isn't in the document
        } else if (op === 1) {
          // INSERT — mark the inserted text in the document
          const end = pos + text.length;
          if (text.length > 0 && pos >= 0 && end <= docLen) {
            builder.add(pos, end, Decoration.mark({
              class: "cc-inserted-inline",
            }));
          }
          pos = end;
        }
      }

      // Accept/reject buttons at end of change
      const endPos = Math.min(to, docLen);
      builder.add(endPos, endPos, Decoration.widget({
        widget: new ChangeHoverWidget(id),
        side: 1,
      }));
    }

    return builder.finish();
  },

  provide(field) {
    return EditorView.decorations.from(field);
  },
});

// ══════════════════════════════════════
//  Public API
// ══════════════════════════════════════

export function rejectSingleChange(view: EditorView, changeId: string): void {
  const changes = view.state.field(changeRegistry);
  const change = changes.find(c => c.id === changeId && c.status === "pending");
  if (!change) return;
  const doc = view.state.doc.toString();
  if (doc.slice(change.from, change.to) !== change.newText) {
    view.dispatch({ effects: rejectChange.of(changeId) });
    return;
  }
  view.dispatch({
    changes: { from: change.from, to: change.to, insert: change.originalText },
    effects: rejectChange.of(changeId),
  });
}

export function acceptAllChanges(view: EditorView): void {
  const changes = view.state.field(changeRegistry);
  const pending = changes.filter(c => c.status === "pending");
  if (pending.length === 0) return;
  view.dispatch({ effects: pending.map(c => acceptChange.of(c.id)) });
}

export function rejectAllChanges(view: EditorView): void {
  const changes = view.state.field(changeRegistry);
  const pending = changes.filter(c => c.status === "pending");
  if (pending.length === 0) return;
  const sorted = [...pending].sort((a, b) => b.from - a.from);
  const doc = view.state.doc.toString();
  const valid: typeof sorted = [];
  const effects: StateEffect<string>[] = [];
  for (const c of sorted) {
    if (doc.slice(c.from, c.to) === c.newText) valid.push(c);
    effects.push(rejectChange.of(c.id));
  }
  view.dispatch({
    changes: valid.map(c => ({ from: c.from, to: c.to, insert: c.originalText })),
    effects,
  });
}

export function goToNextChange(view: EditorView): boolean {
  const changes = view.state.field(changeRegistry);
  const pending = changes.filter(c => c.status === "pending").sort((a, b) => a.from - b.from);
  if (pending.length === 0) return false;
  const cursor = view.state.selection.main.head;
  const next = pending.find(c => c.from > cursor) || pending[0];
  view.dispatch({
    selection: { anchor: next.from },
    effects: EditorView.scrollIntoView(next.from, { y: "center" }),
  });
  return true;
}

export function goToPreviousChange(view: EditorView): boolean {
  const changes = view.state.field(changeRegistry);
  const pending = changes.filter(c => c.status === "pending").sort((a, b) => a.from - b.from);
  if (pending.length === 0) return false;
  const cursor = view.state.selection.main.head;
  const prev = [...pending].reverse().find(c => c.from < cursor) || pending[pending.length - 1];
  view.dispatch({
    selection: { anchor: prev.from },
    effects: EditorView.scrollIntoView(prev.from, { y: "center" }),
  });
  return true;
}

export function getChangeSummary(view: EditorView): {
  total: number; pending: number; accepted: number; rejected: number;
} {
  const changes = view.state.field(changeRegistry);
  return {
    total: changes.length,
    pending: changes.filter(c => c.status === "pending").length,
    accepted: changes.filter(c => c.status === "accepted").length,
    rejected: changes.filter(c => c.status === "rejected").length,
  };
}

export const inlineDiffExtensions = [changeRegistry, changeDecorations];
export const inlineDiffField = changeDecorations;
