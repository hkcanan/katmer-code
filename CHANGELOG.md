# Changelog

## 0.5.0 — Multi-provider

Plugin is no longer Claude-only. Pick a provider per tab, run them
side-by-side, and forward a reply to another model with one click.

### Providers
- **Claude Code** — original SDK integration, unchanged.
- **Gemini** — drives the `gemini` CLI (v0.11+ for stream-json output).
  Tested with Gemini 3.1 Pro Preview, 3 Flash Preview, 3.1 Flash Lite
  Preview, and the stable 2.5 family. Subscription auth via `gemini`
  login.
- **Codex** — drives `codex exec --json`. Uses ChatGPT subscription
  auth via `codex login`. `model_reasoning_effort` wired to the
  existing effort selector.
- **Antigravity** — drives `agy --print`. Plain-text only for now
  (agy v1.0.2 has no structured output); included so users migrating
  off Gemini CLI before June 18 2026 still have a path.

### Per-tab provider
- Each chat tab tracks its own provider + model. Switching providers
  affects only the active tab; new tabs inherit the active tab's
  choice.
- Tab strip now shows a small colored dot per provider.
- Header badge is display-only; switching happens through the unified
  picker in the bottom toolbar.

### Unified picker (bottom toolbar)
- Single dropdown: provider segmented control at top (with sliding
  underline indicator), model list below, effort pills at the bottom
  (only for providers that honour effort).
- Trigger shows provider + model on one line with a brand-color rail.

### Shared instructions (CLAUDE.md mirror)
- New setting: "Auto-mirror CLAUDE.md to other providers".
- Mirrors both global (`~/CLAUDE.md` → `~/.gemini/GEMINI.md` +
  `~/.codex/AGENTS.md`) and vault scope
  (`<vault>/CLAUDE.md` → `<vault>/GEMINI.md` + `<vault>/AGENTS.md`).
- Watches sources with `fs.watch` and re-syncs on change.
- Files written by hand are left alone; only mirrors tagged with the
  KatmerCode header are overwritten.

### Skills
- Skills (`/peer-review`, `/cite-verify`, etc.) now run on every
  provider, not just Claude. Non-Claude tabs inject the skill markdown
  into the prompt as system context.
- Skill autocomplete shows an `inject` badge on non-Claude tabs so the
  mechanism is visible.

### Cross-model
- Each completed assistant message gets a compact action bar in the
  footer: **Copy** and **Ask another model**.
- "Ask another model" opens a new tab on the chosen provider with the
  original reply prefilled as a quoted prompt ("What's your take?").

### UI redesign (Modern Sharp)
- Header brand: mono uppercase `◐ KATMERCODE`.
- Tab strip: segmented control inside a cream-deep frame, active tab
  on white card with subtle shadow.
- Context strip: thin progress bar + token count + model id.
- User message: right-aligned bordered chip.
- Assistant message: provider-colored mono tag + dot.
- Tool call: 3px provider-colored left rail + body + status badge.
- Model picker popup: Raycast Compact — segmented header with sliding
  brand-color underline indicator, single-line model rows with
  trailing check.

### Performance
- CLI detection cached at the view level so opening the picker /
  switching tabs no longer spawns four `which` subprocesses each time.
- Hot-path transitions tightened to 80ms (was 240ms).
- Sticky-bottom auto-scroll — don't yank the user down while they're
  reading earlier messages.
- Message fade animation only on actively-streaming messages (history
  re-renders instantly on tab switch).

### Bug fixes
- Gemini's `[Thought: true]` reasoning markers stripped from text.
- Tool calls that never receive a result event (e.g. provider 429
  mid-turn) now display as `—` instead of stuck on "Running".
- 429 / `MODEL_CAPACITY_EXHAUSTED` responses surface a friendly hint
  ("switch to 2.5 Pro / 2.5 Flash") instead of dumping a Gaxios stack
  trace.
- Gemini stream renders as markdown immediately on completion (no
  more raw `**bold**` showing until tab switch).
- Antigravity CLI no longer hangs in "Thinking" — stdin is closed
  immediately and `TERM=dumb` set so output flushes.
- Codex now uses `--json` (the correct flag) and `--config web_search`
  instead of the non-existent `--search` on `codex exec`.
- Codex receives `--sandbox workspace-write` when permission mode is
  "Accept Edits" so edits actually apply.
- Gemini's `replace` tool name aliased to `Edit` so inline diff
  triggers correctly.
- Tab close button is now always visible on the active tab, right-
  aligned, with a clear red hover state.
- Duplicate active-state checkmark in the model picker removed.
- Provider tab labels in the picker shortened to fit on one line.

### Architecture
- New `src/providers/` directory with one adapter per backend, a
  shared path-detection helper, and per-provider event normalizers.
- `process-manager.ts` reduced to a thin facade that delegates to the
  active `ProviderAdapter` for the current tab.
- `ProviderId`, `PROVIDER_LABELS`, `PROVIDER_MODELS`, and
  `PROVIDER_INSTALL_HINTS` introduced in `types.ts` as the single
  source of truth.

### Known limitations
- Antigravity adapter is text-only (no tool events, no inline diff,
  no streaming) until `agy` exposes structured output.
- Gemini reasoning effort UI is hidden — the API supports it but
  Gemini CLI hasn't exposed the flag yet
  (see google-gemini/gemini-cli#25122).
- xhigh effort on Codex is reachable only by editing
  `~/.codex/config.toml` directly; the plugin maps "max" to "high"
  for broad model compatibility.

### Same-tab consult
- Replaces the original "open in new tab" forwarding as the default
  cross-model action. Each completed assistant message gets a compact
  `Consult` button.
- Clicking a provider in the menu spawns the target adapter in the
  background, renders the response as a consultation card with a
  provider-colored rail, then auto-feeds it back to the active model
  for synthesis — all in the same tab.
- Synthesis follow-up renders as a small dashed pill with `view
  prompt` toggle (not a full user bubble), so the chat doesn't
  duplicate the quoted reply.
- Each consult menu item shows the model that'll be used and a `▾`
  to pick a different model inline. The choice becomes the new
  default for that provider.
- Pre-flight check on the consult target — if the CLI isn't
  installed or not logged in, the in-plugin setup notice fires
  instead of spinning up an immediate red error.
- Old "↗ Open in a new tab instead" path kept as a secondary option
  in the menu.

### In-plugin login
- Provider chips in the picker show one of three states: ✓ ready,
  ⚠ login required (amber), ✗ not installed (faint red).
- Clicking a chip with status ⚠ runs the provider's login flow:
  - Claude / Codex — plugin spawns `claude auth login` / `codex
    login`, browser opens, plugin polls `auth status` every 3s and
    flips the chip when the flag changes. Click the progress toast
    at any time to manually recheck.
  - Gemini / Antigravity — plugin opens Terminal.app with the
    appropriate CLI command (these are interactive TUIs without a
    headless login subcommand).
- Auth detection uses each CLI's canonical command (`claude auth
  status`, `codex login status`) rather than guessing at file
  paths. Falls back to `~/.codex/auth.json` for Codex when the
  status command returns empty stdout (which happens in Electron's
  non-TTY context).

### Mid-conversation switch markers
- When the user changes provider or model in an existing
  conversation, a horizontal divider documents the swap inline.
- Provider switches additionally show a context-loss warning since
  CLIs don't share session state.

### Thinking placeholder
- After every user message (and every consult synthesis), a small
  bottom-anchored pill — `● Model is thinking · · ·` with animated
  dots — sits where the user is actually looking. Disappears as soon
  as the first stream/assistant event arrives.

### Per-model context tracking
- New `contextWindow` field on every model entry in
  `PROVIDER_MODELS`. Picker, context strip, and tooltip all read
  from the same catalog.
- Real numbers: Claude 200K-1M, Gemini 2.5/3.x ≈1M, Codex GPT-5.x
  400K (mini 128K), Antigravity 3.5 Flash 1M.
- Catalog acts as the authoritative source unless Claude's SDK
  reports a higher value via `modelUsage` (in which case the SDK
  wins — model windows occasionally grow with provider updates).

### Mid-tab diff stability
- `switchToTab` was re-running `showEditInEditor` for every Edit
  tool in the history during re-render, pushing already-accepted
  diffs back into the open file's editor. Fixed by setting
  `_isLiveSession = false` around the message replay loop, matching
  what `restoreSession` already did.
- `changeRegistry` StateField now dedupes by id when `addChange`
  fires — defense-in-depth so even if a higher layer dispatches the
  same change twice, the registry stays clean.

### Polish
- Long Gemini context windows render with `M` suffix (`50K / 1M`),
  not the cramped `50K / 1048576`.
- Tooltip on the context bar hints `/compact` only on Claude, "start
  a new tab to free room" elsewhere.

## 0.3.0 — Last single-provider release

(see git log for prior changes)
