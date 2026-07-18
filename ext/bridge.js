// ISOLATED world content script：
//   1. 收 intercept.js（MAIN world）postMessage 過來的 timedtext capture，依 (videoId, lang, kind, tlang) 暫存
//   2. 回覆 popup 的查詢：captures 摘要 + 重新抓 HTML parse 的 playerResponse（SPA stale 對策，findings §4）

const captures = new Map();

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data;
  if (!d || d.source !== 'ytplayer-ingest' || d.type !== 'timedtext' || typeof d.body !== 'string') return;
  try {
    const q = new URL(d.url, location.origin).searchParams;
    const rec = {
      at: Date.now(),
      videoId: q.get('v'),
      lang: q.get('lang'),
      kind: q.get('kind'),
      tlang: q.get('tlang'),
      fmt: q.get('fmt'),
      bytes: d.body.length,
      body: d.body,
    };
    if (!rec.videoId) return;
    rec.key = `${rec.videoId}|${rec.lang}|${rec.kind ?? ''}|${rec.tlang ?? ''}`;
    captures.set(rec.key, rec);
  } catch (_e) { /* 壞 URL 直接略過 */ }
});

// ytInitialPlayerResponse 的 balanced-brace 抽取（與 phase0 探測相同作法；regex 撐不住 1MB JSON）
function extractPlayerResponse(html) {
  const marker = 'ytInitialPlayerResponse = ';
  const i = html.indexOf(marker);
  if (i < 0) return null;
  let depth = 0, inStr = false, esc = false;
  const start = i + marker.length;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (esc) { esc = false; continue; }
    if (inStr) { if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) return JSON.parse(html.slice(start, j + 1)); }
  }
  return null;
}

const trackName = (t) => t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join('') ?? null;

async function getState() {
  const urlVideoId = new URLSearchParams(location.search).get('v');
  let page = null, pageError = null;
  try {
    const html = await (await fetch(location.href, { credentials: 'include' })).text();
    let pr = extractPlayerResponse(html);
    // fallback：HTML parse 失敗且 global 與網址列一致時才信 global
    if (!pr && window.ytInitialPlayerResponse?.videoDetails?.videoId === urlVideoId) {
      pr = window.ytInitialPlayerResponse;
    }
    if (pr) {
      page = {
        videoId: pr.videoDetails?.videoId ?? null,
        meta: {
          title: pr.videoDetails?.title ?? '',
          channel: pr.videoDetails?.author ?? '',
          description: (pr.videoDetails?.shortDescription ?? '').slice(0, 2000),
          durationSec: Number(pr.videoDetails?.lengthSeconds ?? 0),
        },
        tracks: (pr.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).map((t) => ({
          languageCode: t.languageCode,
          kind: t.kind ?? null,
          name: trackName(t),
          vssId: t.vssId ?? null,
        })),
      };
    } else {
      pageError = 'ytInitialPlayerResponse 抓不到（HTML parse 與 global 都失敗）';
    }
  } catch (e) {
    pageError = String(e);
  }
  const capList = [...captures.values()]
    .filter((c) => c.videoId === urlVideoId)
    .map(({ body, ...rest }) => rest);
  return { urlVideoId, page, pageError, captures: capList };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getState') {
    getState().then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg?.type === 'getCaptureBody') {
    const rec = captures.get(msg.key);
    sendResponse(rec ? { body: rec.body } : { error: 'capture 不存在（可能已切換影片）' });
    return false;
  }
});
