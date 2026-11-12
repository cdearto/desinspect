# DesInspect

> A persistent, Chrome-DevTools-style element inspector for any webpage. Edit CSS or HTML, refresh, log in, navigate — your work survives.

DesInspect is a Chrome extension (Manifest V3) that mirrors the Chrome DevTools Elements panel inside the browser's side panel, then quietly writes every edit to IndexedDB scoped to the page's URL. When you come back — after a refresh, a re-login, or an SPA route change — your tweaks are still there.

## Features

### Elements (DOM control)
- **Collapsible DOM tree** with full attributes, hover-to-highlight, click-to-select
- **Keyboard navigation** — ↑/↓ move, →/← expand/collapse (← again jumps to parent), `Delete` removes the element, `H` hides/shows it, `F2`/`Enter` opens Edit as HTML
- **Context menu** (right-click a row) — Edit as HTML, Duplicate, Hide/Show, Delete, Copy selector, Copy outerHTML
- **Edit as HTML** — double-click any row for an inline pretty-printed outerHTML editor (`⌘↵` apply, `Esc` cancel)
- **Breadcrumbs bar** under the tree showing the ancestor chain; click to jump
- **Pick mode** — Chrome-style page overlay with tinted margin/border/padding/content layers and a tag/size badge

### Styles (CSS editing)
- **Matched rules in cascade order** with source file, inline `element.style` on top
- **Click-to-edit** property names and values with live preview; `Esc` cleanly restores the pre-edit state
- **Checkbox per property** — toggling off inserts `revert !important` so the property genuinely turns off; toggling back on restores the cascade
- **`+ add property`** with CSS property-name autocomplete; **`+` new rule** with editable selector
- **`:hov` state forcing** — force `:hover` / `:focus` / `:focus-within` / `:focus-visible` / `:active` to inspect state-dependent styles
- **Rules with dynamic pseudos** (`:hover`, `::before`, …) are listed with a state chip even when inactive
- **Color swatches** with a native color picker
- **Computed tab** — box-model diagram on top, filterable computed properties below

### Persistence (the point)
- **Every edit auto-saves** to IndexedDB, scoped to `origin + pathname`, and re-applies on refresh, restart, re-login, and SPA navigation (`pushState`/`replaceState`/`popstate` + a MutationObserver for late renders)
- **Undo/redo** (`⌘Z` / `⌘⇧Z`, toolbar buttons) across *all* edit kinds — CSS, HTML, delete, hide, revert, even Revert-all and snapshot restores
- **Changes tab** — every persisted edit with one-click revert
- **Snapshots** — named checkpoints of the full changeset, restorable anytime
- **Cross-origin stylesheets** are fetched through the extension's service worker (CORS-exempt), so CDN-hosted CSS shows up in the Styles panel

## Install (unpacked)

The extension is written in TypeScript and compiled with plain `tsc` (no bundler).

```bash
npm install
npm run build        # type-checks and writes the loadable extension to dist/
```

Then open `chrome://extensions` (Chrome 116+), turn on **Developer mode**, click **Load unpacked**, and select the `dist/` folder. After changing code, run `npm run build` again and hit the reload icon on the extension card.

`npm run typecheck` checks types without writing files.

## Keyboard shortcuts

| Key | Where | Action |
|---|---|---|
| `⌘Z` / `⌘⇧Z` | anywhere in panel | Undo / redo |
| `↑` `↓` `←` `→` | Elements tree | Navigate / expand / collapse |
| `Delete` | Elements tree | Delete selected element |
| `H` | Elements tree | Hide/show selected element |
| `F2` / `Enter` | Elements tree | Edit as HTML |
| `⌘↵` | HTML editor | Apply |
| `Esc` | anywhere | Cancel edit / close menu / exit picker |
| `Tab` | style editor | Property name → value |

## Architecture

```
src/                             # TypeScript sources — classic scripts, no imports
  types.d.ts                     # shared types: change records, messages, tree nodes
  background/service-worker.ts   # opens the side panel, CORS-exempt CSS fetch, navigation events
  storage/local-db.ts            # IndexedDB wrapper (changes + snapshots)
  content/
    selector.ts                  # CSS/XPath selector generation + resolution
    persistence.ts               # apply/re-apply edits, debounced saves, undo/redo history
    styles-engine.ts             # matched rules, computed values, box model, :hov forcing
    overlay.ts                   # Chrome-style box-model highlight
    inspector.ts                 # picker, tree serialization, DOM edits, message router
  sidepanel/panel.ts             # the side panel UI
static/                          # copied to dist/ as-is: manifest, icons, panel HTML/CSS
```

The side panel talks to the inspected tab's content script directly (`chrome.tabs.sendMessage`); every request and its response type is listed in `RequestMap` in `src/types.d.ts`.

## Persistence model

Edits are records keyed `(urlPattern, selector, property)` where `property` is a CSS property, `__html__` (outerHTML replacement), or `__remove__` (element deletion with stored restore position). CSS edits live in one `<style id="desinspect-overrides">` appended last so they win the cascade via `!important`. Undo/redo is a record-level transition log: every mutation — including Revert All and snapshot restores — is a set of `(before, after)` record pairs that can be rolled either way.

## Permissions

- `<all_urls>` host access — inject the inspector on any page; fetch cross-origin CSS
- `sidePanel` — the editor lives there
- `webNavigation` — tell the panel when the inspected tab navigates

No analytics, no telemetry, no remote backend.

## License

MIT — see [LICENSE](LICENSE).
