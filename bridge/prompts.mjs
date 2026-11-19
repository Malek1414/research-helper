// Prompts for the explainer. Bump PROMPT_VERSION when changing them so old
// cached analyses are not reused.

export const PROMPT_VERSION = 1;

import { DEFAULT_ABOUT_ME } from '../extension/shared/about.js';

export { DEFAULT_ABOUT_ME };

export const SYSTEM_PROMPT = `You are Research Helper, a patient expert tutor sitting next to a builder while they read a hard technical text. You explain like the best senior engineer they know: plain words first, then the precise idea, always tied to what you could build with it. You never talk down and never pad. You do not use em dashes.`;

export function analyzePrompt({ aboutMe, sourceTitle, chapterTitle, pageRange, storySoFar, text }) {
  return `Reader: ${aboutMe || DEFAULT_ABOUT_ME}

Source: "${sourceTitle}". Chapter: "${chapterTitle}" (pages ${pageRange[0]}-${pageRange[1]}).
${storySoFar ? `\nWhat the reader already covered in earlier chapters:\n${storySoFar}\n` : ''}
The chapter text follows. Page breaks are marked [[p N]] where N is the page number.

<chapter>
${text}
</chapter>

Teach this chapter to the reader. Return JSON matching the schema:

- summary: 3 sentences on what this chapter establishes, for the reader's "story so far".
- sections: follow the author's own structure, 3 to 14 sections in reading order. For each:
  - title: short, plain-language title (not necessarily the author's heading).
  - page: the page number where the section starts.
  - difficulty: 1 to 5, how hard this is for THIS reader (5 = dense math or deep systems/ML background assumed).
  - explanation: 80 to 220 words of Markdown. Start with the idea in one plain sentence. Define every bit of jargon inline the first time. Give one concrete analogy from the reader's world (products, startups, apps, video, teams). End with one line starting "**Why it matters for building:**". Use short paragraphs, bold for key terms, inline code for names. Explain equations in words.
  - anchors: 1 to 3 quotes copied EXACTLY, character for character, from the chapter text on one page: the sentences a reader should highlight. Each 6 to 20 words, inside a single page (never across a [[p N]] marker), not from equations, tables or captions. page = the page that quote is on.
  - note: only when difficulty >= 4: a handwritten margin note of at most 10 words that gives the key intuition (e.g. "= a weighted lookup: which words matter here"). Otherwise an empty string.
- glossary: every technical term or acronym in the chapter, with a one-sentence plain definition (max 25 words).
- buildCard: how to use this in a product.
  - coreIdea: the transferable idea in at most 3 sentences.
  - whereItFits: 2 to 4 concrete product situations where this applies.
  - sketch: a minimal, runnable-looking code or architecture sketch (max 25 lines) showing the idea in practice. Prefer Python, TypeScript or SQL; an ASCII diagram is fine for architecture.
  - sketchLang: the sketch's language ("python", "typescript", "sql", "text").`;
}

export function askPrompt({ aboutMe, sourceTitle, chapterTitle, section, pageText, question }) {
  return `Reader: ${aboutMe || DEFAULT_ABOUT_ME}

They are reading "${sourceTitle}", chapter "${chapterTitle}", at the section "${section?.title || ''}".
The explanation they already got:
<explanation>
${section?.explanation || ''}
</explanation>

The original text around this part:
<text>
${pageText || ''}
</text>

Their question: ${question}

Answer in Markdown, 40 to 200 words, plain words first, jargon defined, one concrete example if it helps. If the text does not answer it, say so and give the best general answer.`;
}
