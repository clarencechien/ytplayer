// Phase 0 探測腳本 —— 在 YouTube「影片頁」的 DevTools Console 整段貼上執行。
//
// 它會：
//   1. 從 ytInitialPlayerResponse 讀 caption track 清單（並偵測 SPA 導航後的 stale 問題）
//   2. 用 HTML parse 走一次 fallback 路徑（驗證兩種方法都可行）
//   3. 對每個 track fetch baseUrl + &fmt=json3，記錄狀態 / 事件數 / 前幾筆 cue / CORS 標頭
//   4. 產生一段「CORS 測試 snippet」（已內嵌 baseUrl），請到非 youtube.com 頁面貼上執行
//   5. 自動下載 phase0-<videoId>.json —— 把這個檔案交回 repo 的 phase0/out/
//
// 建議至少跑三支影片：一支有官方英文字幕、一支只有 ASR、一支多語系。

(async () => {
  const out = { probedAt: new Date().toISOString(), url: location.href };

  // --- 1. global 變數路徑 ---
  const urlVideoId = new URLSearchParams(location.search).get('v');
  const g = window.ytInitialPlayerResponse;
  out.urlVideoId = urlVideoId;
  out.globalVar = {
    present: !!g,
    videoId: g?.videoDetails?.videoId ?? null,
    // SPA 導航後 global 可能還是「上一支影片」— 這是 Phase 1 ext 要處理的關鍵陷阱
    staleAfterSpaNav: !!g && g?.videoDetails?.videoId !== urlVideoId,
  };

  // --- 2. HTML parse fallback（重新 fetch 本頁，模擬 ext 拿不到 global 時的路徑）---
  const extractPR = (html) => {
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
  };
  let pr = null;
  try {
    const html = await (await fetch(location.href, { credentials: 'include' })).text();
    pr = extractPR(html);
    out.htmlParse = { works: !!pr, videoId: pr?.videoDetails?.videoId ?? null };
  } catch (e) {
    out.htmlParse = { works: false, error: String(e) };
  }
  // 以「與網址列一致」者為準
  if (g?.videoDetails?.videoId === urlVideoId) pr = g;
  if (!pr) { console.error('兩種方法都拿不到 playerResponse', out); return; }

  out.videoId = pr.videoDetails?.videoId;
  out.meta = {
    title: pr.videoDetails?.title,
    channel: pr.videoDetails?.author,
    lengthSeconds: pr.videoDetails?.lengthSeconds,
    descriptionPrefix: (pr.videoDetails?.shortDescription ?? '').slice(0, 200),
  };

  const rend = pr.captions?.playerCaptionsTracklistRenderer;
  const tracks = rend?.captionTracks ?? [];
  out.translationLanguagesCount = rend?.translationLanguages?.length ?? 0;
  out.captionTracks = tracks.map((t) => ({
    languageCode: t.languageCode,
    kind: t.kind ?? null, // 'asr' = 自動字幕
    name: t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join('') ?? null,
    vssId: t.vssId,
    isTranslatable: t.isTranslatable,
    baseUrlParams: [...new URL(t.baseUrl).searchParams.keys()],
  }));

  // --- 3. 每個 track 抓 json3 樣本 ---
  out.trackSamples = [];
  for (const t of tracks) {
    const s = { languageCode: t.languageCode, kind: t.kind ?? null };
    try {
      const res = await fetch(t.baseUrl + '&fmt=json3', { credentials: 'include' });
      const body = await res.text();
      s.status = res.status;
      s.bytes = body.length;
      s.corsHeaders = {
        accessControlAllowOrigin: res.headers.get('access-control-allow-origin'),
        accessControlAllowCredentials: res.headers.get('access-control-allow-credentials'),
      };
      const j = JSON.parse(body);
      s.eventCount = j.events?.length;
      s.firstEvents = j.events?.slice(0, 8);
    } catch (e) {
      s.error = String(e);
    }
    out.trackSamples.push(s);
  }

  // --- 4. CORS 測試 snippet（到非 youtube.com 頁面，如 example.com 的 Console 貼上）---
  if (tracks[0]) {
    out.corsTestSnippet =
      `fetch(${JSON.stringify(tracks[0].baseUrl + '&fmt=json3')})` +
      `.then(r => r.text()).then(t => console.log('CORS OK, bytes=', t.length))` +
      `.catch(e => console.log('CORS BLOCKED:', String(e)))`;
    console.log('%c=== CORS 測試：複製下面這行，到 example.com 的 Console 貼上 ===', 'color:orange');
    console.log(out.corsTestSnippet);
  }

  // --- 5. 下載結果 ---
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `phase0-${out.videoId}.json`;
  a.click();

  console.log('=== Phase 0 probe 結果（已自動下載 JSON）===');
  console.log(`videoId=${out.videoId} tracks=${tracks.length}`, out.captionTracks);
  console.log('global stale after SPA nav?', out.globalVar.staleAfterSpaNav);
  return out;
})();
