# dsh-suggestion-chips

<p align="center"><a href="README.md">中文</a> · English</p>

Clickable **suggestion chips** under every reply in DeepSeek Harness. One click sends that text as your message — no typing. Each suggestion also has a small fill button on its right: it only puts that sentence into the composer, so you can edit it before sending. Destructive high-risk actions are marked with ⚠ warning and strictly intercepted from direct sending. Includes adoption indicator for past turns.

It answers "I've read it, now should it do A or B": instead of composing the sentence yourself, just click it.

<img src="assets/turn.en.png" alt="A row of suggestion buttons under a reply: the recommended one is moved to the top, and hovering a button unfolds the sentence that will actually be sent">

## Not the same thing as "composer completion"

There are already a few "next sentence" plugins (`dsh-suggest-prompt`, `dsh-prompt-for-me`, `dsh-suggest-ghost`, `dsh-input-assist`). They all live **inside the composer** as ghost text: they fire an **extra model call** to guess what you would say, offer one line, you accept with Tab, then **press Enter yourself**.

This one takes a different route:

|  | Composer completion | This plugin (dsh-suggestion-chips) |
|---|---|---|
| Where | inside the composer | **under the reply** (turn tail) |
| How many | one | **up to 5 by default**, all shown (extra ones fold away only if you raise the cap) |
| Who decides | the plugin guesses | **the model, from context**, or Level 0 deterministic fallback from text if tool call was omitted (Chinese and English) |
| Extra cost | **an extra model call** (a separate request to guess) | **zero extra token cost** — presentationMeta isolation, no re-injection into context |
| To accept | Tab, then Enter | **one click sends it** (dangerous actions safely fill composer first); fill button allows manual edits |
| If unwanted | ignore it or press Esc | just don't look at it; it never occupies the composer |

## Install

```bash
dsh plugin --profile desktop add dsh-suggestion-chips
```

Then **restart DSH and reload the page** — the host reads its plugin list only at startup, and the client bundle has to be re-fetched. Both steps matter.

## How it works

- **Host side**: registers a non-blocking `suggest_actions` tool. It returns immediately — the model calls it once to close a turn, passing 2-5 suggestions.
- **Client side** draws in two places:
  - a *silent collector* on `tool.call.toolview` — records the suggestions into plugin memory and renders nothing;
  - a *renderer* on `conversation.chat.turnTail` — reads that memory and draws the buttons.
- **Why the turn tail**: DSH folds "process" (thinking + tool calls) into a single collapsed line, so anything drawn inside a tool card is hidden by default. The turn tail sits outside that folding, so the buttons stay visible even when the process is collapsed.
- **Clicking** goes through `conversation.input.shell(sessionId).actions` (set draft → submit) — the exact same path as typing the sentence and pressing Enter.

## Stances and the recommended pick

Two things were added on top of a plain list of sentences.

**Stance.** Every suggestion carries one, and there are five: cautious (a smaller step — confirm before going further), standard (the normal next move along the current route), bold (same route, pushed faster and with more risk taken), alternative (the current approach is dropped), stop (this need not be done at all). A stance appears at most once per turn — repeats are dropped and the free slots go to other angles, so three suggestions that are really the same move never reach you. Five is the maximum (one per stance); when only two are worth offering, you get two.

The stance is **not drawn on the button**: it is a format constraint on the model. That is the point — telling a model "please offer different angles" is advice it can ignore, whereas a required field cannot be ignored.

**Pick.** The model marks the one it would do first, independently of its position in the list — the marked entry is moved to the top and carries a small badge. Its background is the same as the other buttons; only hovering darkens it, like every other button. A `stop` entry ("this need not be done") is pushed to the bottom wherever it was given; the rest keep the order you gave. When the options are genuinely interchangeable, nothing is marked.

**Hover a button** (or focus it with the keyboard) and it unfolds in place, showing the sentence that will actually be sent; move away and it folds back. The point is to keep "what you see" and "what gets sent" aligned — the label is a summary, and the sentence actually sent is usually longer. That sentence lives **outside the button** (a sibling element), so clicking it never sends anything — select and copy as you like.

**All buttons share one width**, sized by the longest label rather than each one's own content: the arrows line up in a column, and a long instruction no longer stretches its button.

**A fill button sits to the right of every suggestion (since 0.1.11; input-field icon).** Clicking it does **not** send: it clears the composer, drops the sentence in, and returns the caret — edit a few words, then press Enter. Use it when the suggestion is roughly right but the wording is not.

**All shown by default**: the per-turn cap is 5 (one per stance), and all of them render at once. The folding code is still there, but its threshold (5) equals the cap, so it normally never fires; raise the cap to 6 and the extra entry folds into a single "N more" line that unfolds in place when clicked — the unfolded ones are clickable too. The unfolded state is deliberately not remembered — scroll away and come back, and it is collapsed again.

The few words the plugin draws itself ("Recommended", "N more", "Show less") follow the interface language: Chinese in a Chinese UI, English otherwise.

Suggestions without a stance still render (backwards compatible).

## Open a new session

When a session has run long enough that it should end, instead of copying the conclusion yourself, creating a new session and pasting it back, offer a suggestion with `opensNewSession: true`: one click creates a new session (same working directory), switches to it, and places that text into the new session's composer.

- **Draft only, never auto-sent.** Auto-sending would immediately start a model turn — spending the user's money for them; filling the composer leaves room to add a line before Enter.
- **At most one such suggestion per session** — extras beyond the first are dropped.
- The button carries a "New session" badge to set it apart from normal suggestions.
- Failures are explained below the button (session service not up, could not switch to foreground, composer never became ready) — never silent.

**Not the same as the official fork**: a fork copies the whole history prefix, so the new session's context is as long as the original's and saves no tokens; this carries only the text you wrote. Use fork to continue exactly where you left off; use this to save tokens.

## Leaner and more native (0.2.0)

- **Tool schema 3,822 → 1,465 chars** (≈956 → ≈366 tokens, sent on every request). Each rule is stated once, and the description now says *when not to call*: only when the task is done or blocked on a user-only choice, do doable steps first, never in plan mode.
- **The model sees one sentence.** The suggestion list travels through `output.presentationMeta` (persisted with the session log, read by the UI only) instead of being echoed back as JSON.
- **The turn ends at the call** via the host's `concludeTurn()` (configurable via `config.concludeTurn`, default `true`), saving one model round-trip per turn. Subagent sessions do not declare the tool.
- **Per-turn reactive store owned by `apply(ctx)`**: suggestions are indexed by `(sessionId, turn / seq)` with subscriber notifications and cleaned up via `ctx.effect`, preventing cross-turn duplication and mount-order races while keeping the package strictly focused on turn-tail action buttons.
- Old hosts fall back gracefully (one extra step, global declaration); 0.1.x sessions still render their buttons.

## Configuration & Dual-Mode (0.3.0)

Configured via the plugin's **own** bundle patch — **not** the profile's `cordis.patch.yml`. The profile patch is applied before the plugin's insert row exists, so a same-id line there is silently ignored (verified 2026-09-26 on another plugin):

```yaml
- insert:
    - id: suggestion-chips
      name: 'dsh-suggestion-chips'
      config:
        displayMode: both  # presentation mode: both (default, dual-mode) | chips (tail chips only) | tab (composer Tab ghost only) | none (off)
        maxActions: 5      # per-turn cap (1-6); extras are dropped; the UI follows this number
        concludeTurn: true # default true (the call ends the turn); set false to keep branch buttons for the turn or avoid the collapse in final-reply-only mode
```

With no `config`, `displayMode` defaults to `"both"`, `maxActions` to 5 (equal to the five stances) and `concludeTurn` to `true`. Restart DSH after changing config — it is read at startup.

- **`both` (default, dual-mode)**: turn-tail chips show the full branching set; when the composer draft is empty, a ghost projection of the top recommended entry (`recommended: true`) appears in the composer — `Tab` adopts it into the draft instantly, and the corresponding chip is auto-marked as adopted.
- **`chips`**: tail suggestion chips only; the composer stays native.
- **`tab`**: tail buttons fully hidden; Claude Code-style Tab ghost prediction in the composer only.
- **Safety & IME protection**: high-risk actions carry a warning badge in the composer and `Tab` is forced to draft-only (never send); key interception is fully suspended during Chinese pinyin composition. All features adapt to Chinese and English environments.

> 2026-09-29 fix: the default used to be 3 — and the fold threshold was also 3, so the two caps matched and "N more" never had anything to unfold; a fourth or fifth distinct action was cut host-side. The default is now 5, which is what makes the fold row useful.

## Limits

- Requires the DSH **0.1.7** line (`conversation.chat.turnTail`, `conversation.input.shell`, `tool.call.toolview`). "End the turn on call", "no declaration for subagents" and "list via presentationMeta" use the 0.2.2 host interfaces; on older hosts the first two automatically fall back to the old behavior (one extra step, global declaration).
- Old sessions from 0.1.x still render their buttons when scrolled back: the UI reads `meta` first and falls back to the result text. Since 0.2.1 the list is replayed from the session event stream, no longer depending on whether that tool call was ever rendered (refreshing the page included).
- When the model does not call `suggest_actions`, the built-in Level 0 extractor falls back to the reply text: numbered options, confirmation questions, and wrap-up closings, in both Chinese and English. The model is allowed not to call it (suggestions belong when the task is done or blocked on a user-only choice, not on mid-task steps), so "no buttons this turn" is not a malfunction.
- Button text comes from the model; keep labels under ~20 characters or they look heavy.
- Normal suggestions send immediately with no confirmation — by design. High-risk actions are intercepted and safely filled into the composer for review; to edit any suggestion first, use the fill button on the right.
- Rapid clicks are debounced for ~0.9s.

## Developer notes

Implementation details, pitfalls, and "why none of the other three positions" live in the repo comments; the `conversation.chat.turnTail` placement was chosen from the official 72 extension slots.

## License

MIT

## Development

```bash
pnpm test      # 49 unit tests, zero external dependencies (node:test)
```

Code layout:

- `lib/normalize.js` — cleaning rules, tool description and the per-turn reactive store (whitespace, dedupe, stances, ordering, cap, `readHostActions`, `createSuggestionStore`); pure functions, unit-testable
- `lib/index.js` — registers the tool and reads config (strictly honors the DSH function-plugin 4-export contract: `Config`, `apply`, `inject`, `name`); the cleaned list travels to the UI via `presentationMeta`, and the model only ever gets one sentence
- `lib/client.js` — browser side. Owned by `apply(ctx)`: keeps the reactive store indexed by `(sessionId, turn / seq)`, cleaned up on `ctx.effect`, records and renders the host's list per turn — no rule is duplicated
- `test/native.test.mjs` — 0.2.0 nativeness regression: 4-export contract, description length, single-sentence result, `concludeTurn` switch, no subagent declaration, old-log fallback, per-turn store and client-slot lifecycle

Edge behavior is pinned by tests: non-arrays, bad JSON, blank labels, duplicate labels, duplicate stances, invalid stances, over-cap counts, out-of-range `maxActions`. UI side: buttons at most 520px wide, labels at most two lines (full text on hover), 0.9s click debounce, the "Recommended" pick highlighted, and the fill button drafts only without sending (clearing the previous draft first). Multi-turn sessions map suggestions precisely by `turn` (or event `seq` range) — no cross-turn leakage.
