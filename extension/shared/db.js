// IndexedDB for things too big for chrome.storage: PDF bytes and chapter analyses.
const DB = 'research-helper';
const VERSION = 1;

let opening;
function open() {
  opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('pdfs')) db.createObjectStore('pdfs');
      if (!db.objectStoreNames.contains('analyses')) db.createObjectStore('analyses');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const putPdf = (id, bytes) => tx('pdfs', 'readwrite', (s) => s.put(bytes, id));
export const getPdf = (id) => tx('pdfs', 'readonly', (s) => s.get(id));
export const deletePdf = (id) => tx('pdfs', 'readwrite', (s) => s.delete(id));
export const putAnalysis = (id, chapter, a) => tx('analyses', 'readwrite', (s) => s.put(a, `${id}:${chapter}`));
export const getAnalysis = (id, chapter) => tx('analyses', 'readonly', (s) => s.get(`${id}:${chapter}`));
export const putVisuals = (id, chapter, v) => tx('analyses', 'readwrite', (s) => s.put(v, `${id}:${chapter}:visuals`));
export const getVisuals = (id, chapter) => tx('analyses', 'readonly', (s) => s.get(`${id}:${chapter}:visuals`));
