// 背景：定期把「待補字幕」數量顯示在擴充功能圖示上（docs/pwa-plan.md §4.4）。
// 純讀取、零 LLM 成本；網路不通就靜默清除 badge，不打擾。

const DEFAULT_WORKER_URL = 'https://ytplayer.ai-apps.work';

async function refreshBadge() {
  const { config } = await chrome.storage.local.get('config');
  const workerUrl = config?.workerUrl || DEFAULT_WORKER_URL;
  const key = config?.ingestKey;
  if (!key) return chrome.action.setBadgeText({ text: '' });
  try {
    const res = await fetch(`${workerUrl}/inbox.json`, { headers: { 'x-ingest-key': key } });
    if (!res.ok) return chrome.action.setBadgeText({ text: '' });
    const d = await res.json();
    await chrome.action.setBadgeText({ text: d.count ? String(d.count) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ffd54a' });
  } catch {
    await chrome.action.setBadgeText({ text: '' });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('inbox', { periodInMinutes: 30 });
  refreshBadge();
});
chrome.runtime.onStartup.addListener(refreshBadge);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'inbox') refreshBadge();
});
// popup 送出 ingest 成功後會主動要求刷新（佇列可能剛銷帳）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'refreshInbox') refreshBadge();
});
