// Tiny, safe Markdown renderer for Claude's explanations: escapes all HTML,
// then supports paragraphs, bullet/numbered lists, fenced code, bold, italic, inline code.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s) {
  const codes = [];
  s = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      flushPara();
      flushList();
      const code = [];
      while (++i < lines.length && !lines[i].startsWith('```')) code.push(lines[i]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const item = line.match(/^\s*(?:([-*])|(\d+)[.)])\s+(.*)$/);
    if (item) {
      flushPara();
      const tag = item[1] ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      list ||= { tag, items: [] };
      list.items.push(item[3]);
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      out.push(`<p><strong>${inline(heading[1])}</strong></p>`);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    if (list) flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join('');
}

export { esc as escapeHtml };
