# Research Helper

A Chrome extension that reads hard technical PDFs with you. Open a paper or a book. It's split into chapters, and Claude reads one chapter at a time, then:

- **highlights** the sentences that matter (yellow = easy, orange = medium, pink = hard)
- **scribbles handwritten notes** in a paper margin next to the hard parts
- **explains every section in plain words** in Chrome's side panel, pitched at you (editable "About me")
- answers **questions** about the passage you're on
- ends each chapter with a **build card** (core idea, where it fits in a product, a code sketch) and a **glossary** that grows across all your sources
- **exports** chapter notes as Markdown to `library/`, which [Neurotree](../Neurotree) indexes

Two modes: **Annotate all** (the whole chapter marked up at once; click a highlight to see its explanation) and **Guided walk** (section by section; the PDF scrolls to each one and the handwriting animates in. `→`/`←` work in the PDF tab).

Several sources sit in the **library**, each with a segmented progress bar like Claude's context bar: done chapters are full, and the current one fills as you walk its sections. **↻ Rotate** jumps to the next unfinished chapter of the next source, so you can interleave a paper with a book.

The AI runs through your own Claude Code login via a small local bridge. You don't need an API key.

## Setup (once)

```bash
cd ~/Desktop/research-helper
npm install && npm run setup     # vendors pdf.js, rough.js and the Caveat font into extension/vendor
```

In Chrome: `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → pick `~/Desktop/research-helper/extension`. Pin the Research Helper icon. Requires Chrome 140 or newer.

## Use

```bash
npm run bridge       # keep running while you read (127.0.0.1:4317)
```

Click the toolbar icon to open the side panel, then:
- **+ Add PDF** for a local file, or paste a link (arXiv etc.)
- on a tab showing a PDF: **Open this tab's PDF here**
- or right-click any PDF link → **Open in Research Helper**

Press **Explain chapter**. A chapter takes about 1-2 minutes the first time; after that it's cached (`.cache/analyses`). For Chrome's own split view, put the Research Helper tab next to anything else you're working in. The explainer lives in the side panel either way.

Model: Sonnet by default. For deeper explanations: `RH_MODEL=opus npm run bridge`.

## How it works

| Part | What it does |
|---|---|
| `extension/viewer/` | PDF tab: pdf.js canvas + text layer, highlight layer under the text, rough.js ink layer with handwritten notes in the right margin. Owns the document and calls the bridge. |
| `extension/sidepanel/` | Library, progress, rotation, walkthrough, Q&A, build card, glossary, export. Talks to the viewer over a `BroadcastChannel`. |
| `extension/shared/` | `chapters.js` (PDF outline → numbered/"Chapter N" headings → 15-page chunks; PDFs of 25 pages or fewer are one chapter), `anchor.js` (finds Claude's quotes in the text layer despite hyphenation, ligatures, spacing; prefix/suffix fallback), `library.js` (progress, rotation, glossary), storage. |
| `bridge/` | Node, no dependencies. Runs `claude -p` with no tools, no MCP, no settings/hooks, and a JSON schema for the analysis. Validates and caches results, writes exports. Only answers `chrome-extension://` origins and local processes. |
| `library/` | Your exported chapter notes and `glossary.md`. |

Only the current chapter's text goes to Claude, plus 3-sentence summaries of earlier chapters, so books work chapter by chapter.

## Tests

```bash
npm test                                   # unit tests: chapters, anchoring, progress/rotation, markdown, bridge
npm run bridge & npm run e2e -- paper.pdf  # real extension in headless Chrome for Testing, real Claude call, screenshots
node scripts/chapters.mjs book.pdf         # show how a PDF gets split
```

Known limits (v1): scanned PDFs without a text layer show "needs OCR". The last chapter of a book can include its references.
