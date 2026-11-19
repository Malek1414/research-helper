---
name: read
description: Find the paper worth reading on a topic or by a researcher, recommend it with reasons, and open it in Research Helper already being explained (highlights, handwritten notes, plain-words walkthrough, build card). Use when the user says "/research-helper:read", "find me a paper on X", "what should I read about X", "best paper on X", "papers by <researcher>", "open <paper> in research helper", or "teach me X from the research". With no argument, just opens the Research Helper app.
argument-hint: "<topic | researcher | paper title> [in chrome]"
---

# Research Helper: read

The user is a builder (founder, ships with AI tools) who is not deep in full-stack, ML, computer vision, databases or data-intensive systems, and wants to understand top research well enough to build it into products. Your job: pick the ONE paper that gives them the most understanding per hour for their request, say why in plain words, and open it in Research Helper.

Research Helper lives in `~/Desktop/research-helper` (or `$RH_HOME`). Scripts:
- `node ~/Desktop/research-helper/plugin/scripts/find.mjs ...` finds open-access papers
- `node ~/Desktop/research-helper/plugin/scripts/launch.mjs ...` opens one

## 1. Read the request

- **Topic** ("vector databases", "diffusion models for video", "how Kafka works"), **researcher** ("Yann LeCun", "papers by Martin Kleppmann"), or a **specific paper** ("the FlashAttention paper").
- **Where to open it**: localhost web app by default (`--target web`). If they say "in Chrome", "in the extension" or "side panel", use `--target chrome`.
- No argument: run `launch.mjs --app` and open the URL it prints (step 4). Done.

## 2. Find candidates

Run the matching search (all sources are free, no key; send only the topic or name, never personal details):

```bash
node ~/Desktop/research-helper/plugin/scripts/find.mjs topic "<topic>" --n 12
node ~/Desktop/research-helper/plugin/scripts/find.mjs topic "<topic>" --sort citations --n 12   # the classics
node ~/Desktop/research-helper/plugin/scripts/find.mjs arxiv "<topic>" --n 8                      # recent preprints
node ~/Desktop/research-helper/plugin/scripts/find.mjs author "<name>" [--topic "<subtopic>"] --n 12
```

Run 2 or 3 of these in parallel for a topic (relevance + citations, plus arXiv if the field moves fast). Every result has a PDF link.

Use what you know too. If you know the canonical paper for this (e.g. "Attention Is All You Need" for transformers, the Dynamo paper for key-value stores, the MapReduce paper for batch processing) and it is not in the results, you can still choose it: give its arXiv PDF (`https://arxiv.org/pdf/<id>`) or another direct PDF link. `launch.mjs` checks the link before opening.

Researcher with a common name: if `find.mjs author` lists other people with that name and the request does not say which one, ask the user one short question before going on.

## 3. Choose one

Pick by, in this order:
1. **Understanding per hour for this user.** The foundational paper that later work builds on usually beats the newest one. If the topic is broad and new to them, a well-cited survey or tutorial can be the better first read; say so.
2. **Buildability.** Prefer papers whose idea can be turned into a product feature or system design.
3. **Readable length.** Prefer under ~40 pages. Long surveys and books are fine; Research Helper splits them into chapters, so mention which chapter to start with.
4. **A real, free PDF.** No paywalls.

For a researcher: name their 3 to 5 most important works in one line each, then pick the best entry point for a builder (often their most cited or most explanatory paper, not their most recent).

## 4. Open it

```bash
node ~/Desktop/research-helper/plugin/scripts/launch.mjs --url "<pdf url>" --title "<paper title>" --target web
```

- It checks that the link really is a PDF, starts the local server if it is not running, and prints JSON with `open` (the URL to open).
- If it prints `"ok": false` with "PDF check failed", take the next-best candidate (or the arXiv version of the same paper) and run it again. Other errors: tell the user what it says.
- Open the printed `open` URL in the user's Chrome with the **chrome-real** tools (`mcp__chrome-real__new_page`; load it with ToolSearch first). If chrome-real is not available, run `launch.mjs` again with `--open`, which opens it with macOS `open`.
- The paper opens and starts explaining by itself (about 1 to 2 minutes for the first chapter; reopening a paper is instant). Add `--no-explain` only if the user wants to read first.
- `--target chrome` needs the extension loaded once (chrome://extensions → Developer mode → Load unpacked → `~/Desktop/research-helper/extension`). If the extension page does not open, fall back to `--target web` and say why.

## 5. Tell the user

Keep it short:
- **The pick**: title, authors, year, and in 2 sentences why this one, in plain words.
- **What you will be able to build after reading it**: one line.
- **If you have more time**: 2 or 3 alternatives, one line each (what each adds).
- **Where it is open**: "Open in Research Helper at http://127.0.0.1:4317, explaining chapter 1 now." For books or long surveys, say which chapter to start with.

No em dashes.
