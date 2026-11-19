// Reads a JSON object while Claude is still writing it: returns the items of a
// top-level array that are already complete, so the panel can show them early.

export function completeItems(src, key) {
  const items = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let strStart = -1;
  let lastStr = '';
  let lastKey = null;
  let inArray = false;
  let itemStart = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') {
        inStr = false;
        if (depth === 1) lastStr = src.slice(strStart, i + 1);
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      strStart = i;
    } else if (c === ':' && depth === 1) {
      try { lastKey = JSON.parse(lastStr); } catch { lastKey = null; }
    } else if (c === '{' || c === '[') {
      if (depth === 1 && c === '[' && lastKey === key) inArray = true;
      else if (inArray && depth === 2 && c === '{') itemStart = i;
      depth++;
    } else if (c === '}' || c === ']') {
      depth--;
      if (inArray && depth === 2 && itemStart >= 0) {
        try { items.push(JSON.parse(src.slice(itemStart, i + 1))); } catch { /* not complete */ }
        itemStart = -1;
      } else if (inArray && depth === 1) return items;
    }
  }
  return items;
}
