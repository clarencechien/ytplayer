// Phase 0.5 探測腳本 —— 驗證「攔截播放器自己的 timedtext 請求」路徑。
//
// 背景：probe 1 發現 baseUrl 直接 fetch 一律回 200 + 空 body（POT 防護），
// 所以 Phase 1 ext 必須改成攔截播放器實際發出的字幕請求。本腳本先驗證這條路可行。
//
// 使用方式（在 YouTube 影片頁）：
//   1. 重新整理頁面後，先把這整段貼進 Console 執行（要在開 CC 之前裝好攔截）
//   2. 點播放器的 CC 按鈕開啟字幕（或切換字幕軌；若已開啟，關掉再開）
//   3. 看到 Console 印出 [probe2] captured ... 之後，執行：  __p0report()
//   4. 會自動下載 phase0b-<videoId>.json —— 交回 phase0/out/
//
// 要驗證的三件事：
//   a. 播放器的請求比 baseUrl 多帶哪些參數（預期有 pot=）、回應是否非空
//   b. 攔截到的 URL 原樣重放（replay）是否仍拿得到資料 → ext 可自己再 fetch
//   c. 重放時把 fmt 改成 json3 是否可行 → ext 可指定想要的格式

(() => {
  if (window.__p0cap) { console.log('[probe2] 已安裝過，直接開 CC 即可'); return; }
  const cap = (window.__p0cap = { captures: [] });

  const record = (url, bodyPromise, via) => {
    bodyPromise
      .then((body) => {
        cap.captures.push({ at: new Date().toISOString(), via, url, bytes: body.length, body });
        console.log(`%c[probe2] captured (${via}) bytes=${body.length}`, 'color:limegreen', url.slice(0, 140) + '…');
        console.log('[probe2] 拿到資料了就執行 __p0report()');
      })
      .catch((e) => console.warn('[probe2] capture 失敗', e));
  };

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    const p = origFetch.apply(this, args);
    if (url && url.includes('/api/timedtext')) p.then((res) => record(url, res.clone().text(), 'fetch'));
    return p;
  };
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (url && String(url).includes('/api/timedtext')) {
      this.addEventListener('load', () => record(String(url), Promise.resolve(this.responseText), 'xhr'));
    }
    return origOpen.call(this, method, url, ...rest);
  };

  const analyzeBody = (body) => {
    const out = { bytes: body.length };
    try {
      const j = JSON.parse(body);
      out.format = 'json';
      out.eventCount = j.events?.length;
      out.firstEvents = j.events?.slice(0, 8);
    } catch {
      out.format = body.trimStart().startsWith('<') ? 'xml' : 'unknown';
      out.bodyPrefix = body.slice(0, 500);
    }
    return out;
  };

  window.__p0report = async () => {
    const videoId = new URLSearchParams(location.search).get('v');
    const out = { probedAt: new Date().toISOString(), url: location.href, videoId, captures: [] };
    for (const c of cap.captures) {
      const u = new URL(c.url, location.origin);
      out.captures.push({
        at: c.at,
        via: c.via,
        params: [...u.searchParams.keys()],
        hasPot: u.searchParams.has('pot'),
        fmt: u.searchParams.get('fmt'),
        lang: u.searchParams.get('lang'),
        kind: u.searchParams.get('kind'),
        tlang: u.searchParams.get('tlang'), // 若非 null 代表使用者開的是自動翻譯軌，紅線警告
        ...analyzeBody(c.body),
        fullUrl: c.url,
      });
    }
    // 重放測試：原樣 + 改 fmt=json3
    const first = cap.captures[0];
    if (first) {
      try {
        const r = await origFetch(first.url, { credentials: 'include' });
        out.replaySame = { status: r.status, ...analyzeBody(await r.text()) };
      } catch (e) { out.replaySame = { error: String(e) }; }
      try {
        const u = new URL(first.url, location.origin);
        u.searchParams.set('fmt', 'json3');
        const r = await origFetch(u.toString(), { credentials: 'include' });
        out.replayJson3 = { status: r.status, ...analyzeBody(await r.text()) };
      } catch (e) { out.replayJson3 = { error: String(e) }; }
    } else {
      console.warn('[probe2] 還沒攔截到任何 timedtext 請求，請先開啟/切換 CC');
      return;
    }
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `phase0b-${videoId}.json`;
    a.click();
    console.log('=== probe2 結果（已下載 JSON）===');
    console.log(`captures=${out.captures.length} hasPot=${out.captures.map(c => c.hasPot)} replaySame=${out.replaySame?.status}/${out.replaySame?.bytes}b replayJson3=${out.replayJson3?.status}/${out.replayJson3?.bytes}b`);
    return out;
  };

  console.log('%c[probe2] 攔截已安裝。現在去開啟（或關掉再開）播放器的 CC 字幕。', 'color:orange;font-weight:bold');
})();
