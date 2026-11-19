# Research Helper: design

Date: 2026-11-19. Status: approved.

## Goal
A Chrome extension that turns hard technical PDFs (papers, book chapters) into something a strong product builder without deep full-stack / ML / CV / database background can understand and implement. You open a PDF, the side panel explains it section by section, and the PDF gets highlights and handwritten margin notes on the hard parts. Long PDFs are worked chapter by chapter. Several sources can be read in rotation, each with a progress bar like Claude's context bar.

## Pieces
| Unit | Job | Talks to |
|---|---|---|
| `extension/viewer/` | Own PDF tab (pdf.js, text layer, SVG annotation overlay with highlights + rough.js handwriting in a right gutter). Owns the document: chapter split, text extraction, anchoring, calling the bridge for analyses. | bridge (HTTP), panel (BroadcastChannel), IndexedDB |
| `extension/sidepanel/` | Library + source switcher with per-source progress bars, Rotate, chapter list, mode toggle (Annotate all / Guided walk), explanations, ask box, glossary, build card, export. | viewer (BroadcastChannel), bridge (ask, export), storage |
| `extension/background.js` | Opens the side panel on action click, context menu "Open in Research Helper" on PDF links, imports PDF bytes into IndexedDB. | storage, tabs |
| `extension/shared/` | Pure logic: `chapters.js` (outline / headings / fixed chunks), `anchor.js` (find a quote in page text, fuzzy), `progress.js`, `rotate.js`; plus `db.js` (IndexedDB), `store.js` (chrome.storage), `bus.js` (BroadcastChannel). | |
| `bridge/` | Node HTTP server on 127.0.0.1:4317, no deps. Runs `claude -p` headless (subscription auth, no tools, no MCP, no settings) with a JSON schema. Disk cache per chapter. Writes Markdown exports. Only accepts requests from `chrome-extension://` origins (or no origin, i.e. local processes). | Claude Code CLI, `library/` |
| `library/` | Markdown exports, one folder per source, one file per chapter, plus `glossary.md`. Lives in this git repo under ~/Desktop, so Neurotree indexes it. | Neurotree |

## Chapters
1. PDF outline: top-level items become chapters (if there is a single top item, its children). Chapters over 60 pages are split by their children if any, else by fixed chunks.
2. No outline: PDFs of 25 pages or fewer are one chapter ("Whole document"). Longer ones: headings detected from large-font lines starting a page region ("Chapter 3", "3 Storage and Retrieval", "PART II").
3. Still nothing: fixed 15-page chunks.

Only the current chapter's text is sent to Claude, with page markers `[[p N]]`, plus short summaries of the previous chapters ("story so far").

## Analysis schema (per chapter)
```
{ summary, sections: [{ title, page, difficulty 1-5, explanation, anchors: [{page, quote}], note|null }],
  glossary: [{term, definition}], buildCard: { coreIdea, whereItFits, sketch } }
```
`note` (max 12 words, handwritten) only for difficulty >= 4. Quotes must be verbatim, 4-20 words. The explainer's audience is configurable ("About me", default describes Malek: product/AI-tools builder, not deep in full-stack, ML, CV, databases, data-intensive systems).

## Modes
- Annotate all: render every highlight and note at once; clicking a highlight focuses its section in the panel.
- Guided walk: panel steps sections; viewer scrolls to the section, draws its highlight and animates the handwriting in. Ask box answers about the current section.

## Sources and progress
Each source keeps chapters, done flags, current chapter, mode. Progress bar = thin segmented bar, one segment per chapter, filled when done, plus %. A chapter is done when the walk reaches its end, on export, or by "Mark done". Rotate opens the next unfinished chapter of the next source with unfinished chapters (round robin after the active source).

## Errors
Bridge offline: panel shows the start command; reading still works. Quote not found exactly: normalized match, then first-8-words prefix match, then explanation without highlight. No text layer: "needs OCR" message. Claude failure / invalid JSON: error with retry; nothing cached.

## Testing
`node --test`: chapters, anchor matching, progress, rotation, schema validation, export Markdown, bridge HTTP with a fake claude runner. E2E: Playwright Chromium with the unpacked extension on a real paper.

## Out of v1
OCR, mobile, sync, check questions, auto-commit of exports.

## Addendum (same day): localhost app and Claude Code plugin
- **Web app**: the bridge serves `web/index.html` at http://127.0.0.1:4317, which embeds the extension's viewer and panel as iframes. `extension/shared/platform.js` replaces chrome.* there (localStorage storage with cross-frame change events, the viewer iframe as the only "tab"). Remote PDFs are downloaded through `GET /fetch?url=`. The bridge now also checks the Host header (DNS rebinding) and accepts its own origin.
- **Fixed extension ID** via a manifest `key`, plus `import.html?url=&title=&explain=1` so other tools can hand the extension a paper.
- **Auto-explain**: `explain=1` on the viewer starts the analysis once the chapter renders. Links already in the library are reopened, not re-added. A title passed in is kept over the PDF's metadata title.
- **Plugin** `plugin/`: skill `read` (`/research-helper:read <topic|researcher|paper> [in chrome]`), `find.mjs` (OpenAlex works/authors with open-access PDFs, ranked by relevance blended with citations; arXiv; retry on 429; optional OPENALEX_API_KEY), `launch.mjs` (verifies the link is a PDF, starts the server detached if needed, prints the URL; `--open` opens it).

## Addendum: Visual mode
- Panel toggle **Visual | Text** (stored as `view`, default visual). Text mode is unchanged.
- After a chapter is analysed, the viewer calls `POST /visualize` with the sections and chapter text. Claude returns structured data only (`bridge/visual.mjs`): a concept `map` {nodes (with section), links} and per section {kind: flow|stack|compare|formula|analogy|numbers|cycle, oneLiner, groups, items, links, steps[{show, caption}]}. Validated (limits, unknown ids dropped, every item in some step), cached on disk and in IndexedDB (`<id>:<chapter>:visuals`).
- `shared/visual-layout.js` (pure) positions shapes per kind; `sidepanel/whiteboard.js` draws them with rough.js (stable seeds) and Caveat on paper, revealing step by step with draw-in animation. The current section auto-plays once.
- Annotate all: map on top, then a visual card per section. Guided walk: the section's whiteboard first, the map folded below. Map nodes jump to their section; the current one is outlined red. A section without a usable picture falls back to text.

## Addendum: code visualizer
- Panel tab **Code**. Sources: listings found in the chapter (`POST /listings`, asked by the viewer which owns the text, cached in IndexedDB `<id>:<chapter>:listings`), the build card sketch, or pasted code with a language picker.
- `POST /trace` (`bridge/trace.mjs`): Claude simulates execution (no code is run) and returns {language, summary, lines, added, steps[{line, event: line|call|return|skip|error, explain, vars[{scope, name, kind: value|list|matrix|dict|object|table, text, cells}], output}]}. The reader's lines are kept verbatim; Claude may only append up to 8 example lines (`added`). Max 80 steps, loops traced 2 rounds then one skip step. Disk-cached by code + language + aboutMe.
- `shared/trace-view.js` (pure): language-agnostic highlighter (escaped), running/previous line marks, variables grouped by scope with changed values flagged, output. Panel player: prev/next, play, slider, arrow keys and space.
