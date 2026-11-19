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
export const ask = (body) => call('/ask', body);
export const exportChapter = (body) => call('/export', body);
