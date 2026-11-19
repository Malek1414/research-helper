// Writes chapter notes as Markdown into library/, where Neurotree indexes them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function slug(s) {
  return String(s || 'untitled')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

const dots = (n) => '●'.repeat(n) + '○'.repeat(5 - n);

export function chapterMarkdown({ source, chapterIndex, chapter, analysis, date }) {
  const a = analysis;
  const lines = [
    `# ${chapter.title}`,
    '',
    `Source: **${source.title}**, chapter ${chapterIndex + 1}, pages ${chapter.start + 1}-${chapter.end + 1}${source.url ? ` (${source.url})` : ''}.`,
    `Exported ${date} by Research Helper.`,
    '',
    '## In short',
    '',
    a.summary,
    '',
    '## Build card',
    '',
    `**Core idea.** ${a.buildCard.coreIdea}`,
    '',
    '**Where it fits:**',
    ...a.buildCard.whereItFits.map((w) => `- ${w}`),
    '',
  ];
  if (a.buildCard.sketch) lines.push('```' + a.buildCard.sketchLang, a.buildCard.sketch, '```', '');
  lines.push('## Walkthrough', '');
  for (const s of a.sections) {
    lines.push(`### ${s.title}`, '', `Page ${s.page}, difficulty ${dots(s.difficulty)}`, '');
    for (const q of s.anchors) lines.push(`> ${q.quote} (p. ${q.page})`, '');
    lines.push(s.explanation, '');
    if (s.note) lines.push(`*Margin note:* ${s.note}`, '');
  }
  if (a.glossary.length) {
    lines.push('## Glossary', '', ...a.glossary.map((g) => `- **${g.term}**: ${g.definition}`), '');
  }
  return lines.join('\n');
}

export function glossaryMarkdown(glossary, date) {
  const entries = Object.values(glossary || {}).sort((x, y) => x.term.localeCompare(y.term));
  return [
    '# Glossary',
    '',
    `Every term Research Helper has explained, across all sources. Updated ${date}.`,
    '',
    ...entries.map((e) => `- **${e.term}**: ${e.definition} _(${e.sources.join(', ')})_`),
    '',
  ].join('\n');
}

export function writeExport(libraryDir, { source, chapterIndex, chapter, analysis, glossary }, date = new Date().toISOString().slice(0, 10)) {
  const dir = join(libraryDir, slug(source.title));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${String(chapterIndex + 1).padStart(2, '0')}-${slug(chapter.title)}.md`);
  writeFileSync(file, chapterMarkdown({ source, chapterIndex, chapter, analysis, date }));
  const gfile = join(libraryDir, 'glossary.md');
  writeFileSync(gfile, glossaryMarkdown(glossary, date));
  return { file, glossary: gfile };
}
