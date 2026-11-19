import { importFromUrl } from './shared/open.js';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'rh-open-link',
    title: 'Open in Research Helper',
    contexts: ['link'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'rh-open-link' || !info.linkUrl) return;
  // Open the panel in the same gesture, then import.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  try {
    await importFromUrl(info.linkUrl);
  } catch (e) {
    console.warn('Research Helper import failed:', e.message);
  }
});
