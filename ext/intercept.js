// MAIN world content script：攔截播放器對 /api/timedtext 的回應。
// timedtext 有 POT 防護（phase0-findings §3），自行組 URL 抓不到資料，
// 只能取用播放器自己發出的請求（帶有效 pot）的回應。
//
// 防禦性原則：只讀不改、不吞使用者頁面的例外、容忍其他 ext 同時包裝 XHR/fetch。

(() => {
  if (window.__ytplayerIntercept) return;
  window.__ytplayerIntercept = true;

  const post = (url, body) => {
    try {
      window.postMessage({ source: 'ytplayer-ingest', type: 'timedtext', url: String(url), body }, location.origin);
    } catch (_e) { /* 傳遞失敗不影響頁面 */ }
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    try { this.__ytplayerUrl = String(args[1] ?? ''); } catch (_e) { /* noop */ }
    return origOpen.apply(this, args);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (this.__ytplayerUrl && this.__ytplayerUrl.includes('/api/timedtext')) {
        this.addEventListener('load', () => {
          try {
            if ((this.responseType === '' || this.responseType === 'text') && this.responseText) {
              post(this.__ytplayerUrl, this.responseText);
            }
          } catch (_e) { /* noop */ }
        });
      }
    } catch (_e) { /* noop */ }
    return origSend.apply(this, args);
  };

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (url && String(url).includes('/api/timedtext')) {
        p.then((res) => {
          try {
            res.clone().text().then((body) => body && post(url, body), () => {});
          } catch (_e) { /* noop */ }
        }, () => {});
      }
    } catch (_e) { /* noop */ }
    return p;
  };
})();
