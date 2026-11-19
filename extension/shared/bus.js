// Messages between the viewer tab and the side panel (same extension origin).
//
// panel -> viewer:  {to:'viewer', cmd:'open'|'explain'|'focus'|'mode'|'ask'|'export'|'hello', ...}
// viewer -> panel:  {to:'panel', type:'doc'|'status'|'analysis'|'focus'|'answer'|'exported'|'error', ...}
const channel = new BroadcastChannel('research-helper');

export const send = (msg) => channel.postMessage(msg);
export function listen(to, fn) {
  const h = (e) => e.data?.to === to && fn(e.data);
  channel.addEventListener('message', h);
  return () => channel.removeEventListener('message', h);
}
