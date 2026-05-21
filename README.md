# DesInspect

> A persistent browser element inspector with auto-save. Never lose your CSS/HTML tweaks again.

DesInspect is a Chrome extension (Manifest V3) that turns any webpage into a live design playground. Click an element, tweak its CSS or HTML in the side panel, and your changes are automatically persisted in IndexedDB — surviving page refreshes, navigation, and browser restarts. Optional AI-powered UX audits via Claude.

## Features

- **Click-to-inspect** any element on any page — hover to highlight, click to select
- **Live CSS editing** — DevTools-style style panel with filter, class toggle, and add-rule
- **HTML editing** — edit inner HTML with line numbers, Tab indentation, and `Cmd/Ctrl+Enter` to apply
- **Persistent auto-save** — every change is written to IndexedDB and re-applied on next visit
- **URL-scoped changes** — edits on one page don't leak to another
- **Box model diagram** — Chrome DevTools-style margin/border/padding/content visualizer
- **DOM Navigator** — vertical tree showing ancestors, siblings, and children of the selected element with hover-to-highlight
- **Diff mode** — flip between original and modified states on the live page for before/after comparison
- **Undo/redo** — `Cmd/Ctrl+Z` and `Cmd/Ctrl+Shift+Z`, up to 100 levels deep
- **Snapshots** — named checkpoints of your full changeset (like git commits for browser edits)
- **Export** — copy changes as clean CSS, or export the full changeset as JSON
- **SPA-aware** — detects `pushState`/`replaceState`/`popstate` and re-applies changes after client-side navigation
- **AI UX Audit** (optional) — runs accessibility/usability checks on the selected element or full page via the Anthropic API. Costs <$0.01 per audit. API key is stored locally and only sent to `api.anthropic.com`.
- **AI Helper** (optional) — natural-language CSS/HTML edits ("make this bigger", "add more padding")

## Install

This is an unpacked Chrome extension. To install:

1. Clone this repo:
   ```bash
   git clone https://github.com/cdearto/desinspect.git
   ```
2. Open `chrome://extensions` in Chrome (requires Chrome 116+).
3. Toggle **Developer mode** on (top right).
4. Click **Load unpacked** and select the cloned `desinspect` directory.
5. Pin the DesInspect icon to your toolbar for easy access.

## Usage

1. Navigate to any page you want to modify.
2. Click the DesInspect toolbar icon — this opens the side panel and activates inspector mode.
3. Hover any element to highlight it; click to select.
4. Edit CSS properties or switch to **HTML** mode to edit markup directly.
5. Changes auto-save and re-apply on every revisit to the same URL.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Cmd/Ctrl + Z` | Undo |
| `Cmd/Ctrl + Shift + Z` | Redo |
| `Delete` / `Backspace` | Remove selected element |
| `Esc` | Deselect element / deactivate inspector |
| `Tab` / `Shift+Tab` | Indent / outdent in HTML editor |
| `Cmd/Ctrl + Enter` | Apply HTML edit |

### AI UX Audit setup

1. Get an Anthropic API key at [console.anthropic.com](https://console.anthropic.com/settings/keys).
2. In the side panel, switch to the **AI UX Audit** tab.
3. Paste your key and click **Save**. The key is stored locally in `chrome.storage` and is only sent to `api.anthropic.com`.
4. Use **Audit Page**, **Audit Selected Element**, or **Check Change Impact**.

A **Test Mode** is available that uses mock data — no API key needed.

## Project structure

```
desinspect/
├── manifest.json              # Chrome MV3 manifest
├── background/
│   └── service-worker.js      # Message router, tab/SPA navigation handling
├── content/
│   ├── inspector.js           # Main orchestrator (click/hover/select logic)
│   ├── change-tracker.js      # Records, persists, and re-applies changes
│   ├── selector-engine.js     # Generates robust CSS selectors / XPaths
│   └── overlay-renderer.js    # Highlight overlays on the page
├── sidepanel/
│   ├── index.html             # Side panel UI (Editor / Changes / Audit / History tabs)
│   ├── panel.js               # Panel logic
│   └── panel.css              # Panel styling
├── ai/
│   ├── audit-engine.js        # Anthropic API client + audit orchestration
│   └── prompt-templates.js    # Prompts for audit and natural-language edits
├── storage/
│   └── local-db.js            # IndexedDB wrapper (PersistDB)
├── utils/
│   ├── dom-serializer.js      # Compute styles / inline styles / describe elements
│   └── export.js              # CSS/JSON export helpers
├── styles/
│   └── content.css            # Injected overlay styles
└── icons/                     # 16/32/48/128 toolbar icons
```

## Permissions

- `activeTab`, `scripting` — inject the inspector into the page you're on
- `storage` — persist the user's API key and preferences
- `sidePanel` — render the editor UI
- `webNavigation` — detect SPA route changes as a backup to in-page History API monkey-patches
- `<all_urls>` — required because the user may want to inspect any site
- `https://api.anthropic.com/*` — for the optional AI features

## Privacy

DesInspect runs entirely in your browser. No analytics, no telemetry, no remote backend. The only network request the extension ever makes is to `api.anthropic.com`, and only if you explicitly opt in by saving an API key and triggering an audit.

## Roadmap

- [ ] Firefox port
- [ ] Export changes as a userscript or browser bookmarklet
- [ ] Share/import snapshot bundles
- [ ] Visual diff view (screenshot comparison)
- [ ] Per-element notes/annotations

## License

MIT — see [LICENSE](LICENSE).
