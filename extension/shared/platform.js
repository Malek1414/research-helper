// Lets the same viewer and panel run in two places:
//  - as the Chrome extension (real chrome.* APIs), or
//  - as the localhost web app served by the bridge (web/index.html), where this
//    installs a small chrome.* stand-in: storage in localStorage, "tabs" = the
//    viewer iframe of the web app.
// Import this first in every entry point.

export const IS_EXTENSION = !!globalThis.chrome?.runtime?.id;

if (!IS_EXTENSION) installWebShim();

function installWebShim() {
  const PREFIX = 'rh:';
  const listeners = [];
  const read = (k) => {
    try {
      const v = localStorage.getItem(PREFIX + k);
      return v == null ? undefined : JSON.parse(v);
    } catch {
      return undefined;
    }
  };
  const notify = (changes) => listeners.forEach((fn) => fn(changes, 'local'));
  // Other iframes / tabs of the app see changes through the storage event.
  window.addEventListener('storage', (e) => {
    if (!e.key?.startsWith(PREFIX)) return;
    const k = e.key.slice(PREFIX.length);
    notify({ [k]: { oldValue: e.oldValue && JSON.parse(e.oldValue), newValue: e.newValue && JSON.parse(e.newValue) } });
  });

  const app = () => {
    try {
      return window.top.rhApp || null;
    } catch {
      return null;
    }
  };
  const viewerBase = () => new URL('/extension/viewer/viewer.html', location.origin).href;
  const noop = { addListener() {} };

  globalThis.chrome = {
    runtime: { id: undefined, getURL: (p) => new URL(`/extension/${p}`, location.origin).href },
    storage: {
      local: {
        async get(keys) {
          const out = {};
          for (const k of [].concat(keys)) {
            const v = read(k);
            if (v !== undefined) out[k] = v;
          }
          return out;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: read(k), newValue: v };
            localStorage.setItem(PREFIX + k, JSON.stringify(v));
          }
          notify(changes);
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    tabs: {
      async query(q) {
        const a = app();
        if (q?.url?.startsWith(viewerBase()) && a) return [{ id: 1, windowId: 1, url: a.viewerUrl() }];
        return [];
      },
      async update(_id, { url }) {
        app()?.openUrl(url);
        return { id: 1, windowId: 1 };
      },
      async create({ url }) {
        if (app()) app().openUrl(url);
        else window.open(url, '_blank');
        return { id: 1, windowId: 1 };
      },
      onActivated: noop,
      onUpdated: noop,
    },
    windows: { async update() {}, async getCurrent() { return { id: 1 }; } },
    sidePanel: { async open() {} },
  };
  document.documentElement.classList.add('rh-web');
}
