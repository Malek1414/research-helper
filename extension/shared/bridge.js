// Client for the local bridge (bridge/server.mjs).
export const BRIDGE = 'http://127.0.0.1:4317';
export const START_CMD = 'cd ~/Desktop/research-helper && npm run bridge';

async function call(path, body) {
  let res;
  try {
    res = await fetch(BRIDGE + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  } catch {
    throw Object.assign(new Error(`Bridge is offline. Start it with: ${START_CMD}`), { offline: true });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `bridge error ${res.status}`);
  return data;
}

export const health = () => call('/health').then(() => true, () => false);
export const analyze = (body) => call('/analyze', body);
export const visualize = (body) => call('/visualize', body);
export const trace = (body) => call('/trace', body);
export const listings = (body) => call('/listings', body);
export const ask = (body) => call('/ask', body);
export const exportChapter = (body) => call('/export', body);

// Streams /explain: onEvent({type: 'analysis'|'visuals'|'error'|'end', ...}) for
// each NDJSON line. Resolves when the stream ends.
export async function explain(body, onEvent) {
  let res;
  try {
    res = await fetch(BRIDGE + '/explain', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error(`Bridge is offline. Start it with: ${START_CMD}`), { offline: true });
  }
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `bridge error ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const ev = JSON.parse(line);
      if (ev.type === 'error') throw new Error(ev.error);
      onEvent(ev);
    }
  }
}
