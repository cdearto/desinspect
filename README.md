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

1. Clone this repo.
2. Open `chrome://extensions` (Chrome 116+).
3. Toggle **Developer mode** on.
4. Click **Load unpacked**, select this directory.
5. Pin the toolbar icon.

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
manifest.json                  # MV3
background/service-worker.js   # side panel, sidepanel↔content relay, CORS-exempt CSS fetch
content/
  selector.js                  # CSS/XPath selector generation + resolution
  styles-engine.js             # matched rules, computed, box model, :hov forcing
  overlay.js                   # Chrome-style box-model highlight overlay
  persistence.js               # IndexedDB re-apply, debounced saves, undo/redo history
  inspector.js                 # picker, tree serialization, DOM ops, message router
storage/local-db.js            # IndexedDB wrapper (changes + snapshots)
sidepanel/                     # tree + tabs UI (index.html, panel.js, panel.css)
styles/content.css             # injected, overlay-only
```

## Persistence model

Edits are records keyed `(urlPattern, selector, property)` where `property` is a CSS property, `__html__` (outerHTML replacement), or `__remove__` (element deletion with stored restore position). CSS edits live in one `<style id="desinspect-overrides">` appended last so they win the cascade via `!important`. Undo/redo is a record-level transition log: every mutation — including Revert All and snapshot restores — is a set of `(before, after)` record pairs that can be rolled either way.

## Permissions

- `activeTab`, `scripting`, `<all_urls>` — inject the inspector everywhere; fetch cross-origin CSS
- `storage` — preferences
- `sidePanel` — the editor lives there
- `webNavigation` — SPA route detection

No analytics, no telemetry, no remote backend.

## License

MIT — see [LICENSE](LICENSE).
