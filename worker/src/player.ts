// Phase 3 — Player 頁與影片清單頁。樣式借鏡 kvsplayer，但雙語字幕中英「同級」
// （同字級、同權重，僅以顏色區分）。單檔 HTML、無框架、由 Worker 直接 serve。

const STYLE = `
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #262b36;
    --fg: #e8eaf0; --dim: #8b93a5; --accent: #ffd54a; --en: #9ecbff;
    --scale: 1;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif;
    height: 100vh; height: 100dvh; /* iOS Safari 的 100vh 會被網址列吃掉 */
    display: flex; flex-direction: column; overflow: hidden;
  }
  header {
    padding: 10px 16px; border-bottom: 1px solid var(--line);
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  }
  header h1 { font-size: 15px; font-weight: 600; }
  header .meta { font-size: 12px; color: var(--dim); }
  #backBtn {
    display: flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; border-radius: 8px; flex: none;
    background: var(--panel); border: 1px solid var(--line);
    color: var(--fg); text-decoration: none; font-size: 16px;
  }
  #backBtn:hover { border-color: var(--accent); color: var(--accent); }
  .controls { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
  .controls button {
    background: var(--panel); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .controls button.on { border-color: var(--accent); color: var(--accent); }
  main { flex: 1; display: flex; min-height: 0; }
  .stage { flex: 1.6; display: flex; flex-direction: column; min-width: 0; }
  .video-wrap { position: relative; background: #000; flex: 1; min-height: 0; }
  .video-wrap #player { position: absolute; inset: 0; width: 100%; height: 100%; }

  /* 字幕帶：疊在影片底部。中英同級（同字級同權重），僅顏色區分 */
  #subBand {
    position: absolute; left: 0; right: 0; bottom: 7%;
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: 0 4%; pointer-events: none; z-index: 6; text-align: center;
    opacity: var(--band-alpha, 1); transition: opacity .15s;
  }
  body.peek #subBand { opacity: .06; } /* 按住 H：暫看畫面 */
  body[data-mode="off"] #subBand { display: none; }
  /* 畫面字卡層（video 路由 kind=card）：疊畫面上緣、短促字卡樣式，與對白字幕分層 */
  #cardLayer {
    position: absolute; top: 6%; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; gap: 6px; align-items: center;
    pointer-events: none; z-index: 4; max-width: 90%;
  }
  #cardLayer .card {
    background: rgba(20,16,4,calc(var(--alpha) * .82)); color: #ffd54a;
    padding: 4px 12px; border-radius: 8px; border: 1px solid rgba(255,213,74,.35);
    font-size: calc(15px * var(--scale)); font-weight: 700; white-space: pre-line; text-align: center;
  }
  body.peek #cardLayer { opacity: .06; }
  body[data-mode="off"] #cardLayer, body[data-mode="en"] #cardLayer { display: none; }
  .row .kindCard { color: #ffd54a; font-size: 11px; margin-right: 4px; }

  /* 透明點擊層：點影片=播放/暫停由我們接手，焦點不會掉進 iframe、熱鍵永遠有效。
     底部留 90px；「YT 介面：開放」時整層讓開，原生控制全部可直接操作 */
  #clickLayer { position: absolute; inset: 0 0 90px 0; z-index: 4; cursor: pointer; }
  body.unlock #clickLayer { display: none; }
  #subEn, #subZh, #subNote {
    width: fit-content; max-width: 92%;
    background: rgba(8,10,14,.72); border-radius: .4em; padding: .1em .55em;
  }
  #subEn:empty, #subZh:empty, #subNote:empty { display: none; }
  #subZh, #subEn {
    font-size: calc(clamp(17px, 2.3vw, 28px) * var(--scale));
    font-weight: 600; line-height: 1.4; text-shadow: 0 1px 2px rgba(0,0,0,.8);
  }
  #subEn { color: var(--en); }
  #subNote { color: var(--accent); font-size: calc(clamp(12px, 1.3vw, 15px) * var(--scale)); white-space: pre-line; }
  body[data-mode="zh"] #subEn { display: none; }
  body[data-mode="en"] #subZh { display: none; }
  body.notes-off #subNote, body.notes-off .row .note { display: none; }
  .stage:fullscreen { background: #000; }
  /* 劇場模式：收起逐句稿，影片區吃滿視窗寬 — YouTube 依「播放器渲染尺寸」選畫質
     （720p 需 ~1280x720、1080p 需 ~1920x1080），窄版面會被鎖在低畫質。
     見 docs/video-quality.md */
  body.theater aside { display: none; }
  body.theater .stage { flex: 1; }
  #quality { font-variant-numeric: tabular-nums; }

  /* transcript */
  aside {
    flex: 1; border-left: 1px solid var(--line); background: var(--panel);
    display: flex; flex-direction: column; min-width: 300px; max-width: 460px;
  }
  aside .head { padding: 10px 14px; font-size: 12px; color: var(--dim); border-bottom: 1px solid var(--line); }
  #list { flex: 1; overflow-y: auto; padding: 6px 0; }
  .row { padding: 7px 14px; cursor: pointer; border-left: 3px solid transparent; }
  .row:hover { background: rgba(255,255,255,.04); }
  .row.cur { background: rgba(255,213,74,.08); border-left-color: var(--accent); }
  .row .t { color: var(--dim); font-size: 11px; margin-right: 6px; font-variant-numeric: tabular-nums; }
  .row .zh, .row .en { display: block; font-size: calc(14px * var(--scale)); line-height: 1.45; }
  .row .en { color: var(--en); opacity: .85; }
  .row .note { display: block; color: var(--accent); font-size: calc(12px * var(--scale)); white-space: pre-line; }
  .row .note::before { content: "註 "; opacity: .7; }
  body[data-mode="zh"] .row .en { display: none; }
  body[data-mode="en"] .row .zh { display: none; }
  .msg { padding: 14px; color: var(--dim); font-size: 13px; }
  .msg a { color: var(--en); }

  /* 首次導覽 */
  #welcome {
    position: fixed; inset: 0; z-index: 50; display: flex;
    align-items: center; justify-content: center; background: rgba(0,0,0,.7);
  }
  #welcome.hidden { display: none; }
  #welcome .card {
    background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
    max-width: 520px; width: calc(100% - 40px); max-height: 85vh; overflow-y: auto;
    padding: 20px 22px;
  }
  #welcome h2 { font-size: 16px; margin-bottom: 10px; }
  #welcome table { width: 100%; border-collapse: collapse; font-size: 13px; margin: 8px 0; }
  #welcome td { padding: 4px 6px; border-bottom: 1px solid var(--line); }
  #welcome td.k { color: var(--accent); white-space: nowrap; font-variant-numeric: tabular-nums; width: 110px; }
  #welcome .tip { color: var(--dim); font-size: 12px; margin: 8px 0; line-height: 1.6; }
  #welcome button {
    width: 100%; margin-top: 10px; padding: 9px; border: 0; border-radius: 8px;
    background: var(--accent); color: #000; font-weight: 700; cursor: pointer; font-size: 14px;
  }

  @media (max-width: 860px) {
    main { flex-direction: column; }
    aside { max-width: none; min-width: 0; border-left: 0; border-top: 1px solid var(--line); flex: 1; }
    .stage { flex: 0 0 auto; }
    .video-wrap { aspect-ratio: 16/9; flex: none; }
  }

  /* mobile 模式（touch 裝置，JS 偵測後加 body.mobile）：
     字幕不疊影片 — subBand 由 JS 移到影片下方成常駐區塊，畫面完全不被遮 */
  body.mobile main { flex-direction: column; }
  body.mobile .stage { flex: 0 0 auto; }
  body.mobile .video-wrap { aspect-ratio: 16/9; flex: none; }
  body.mobile aside { max-width: none; min-width: 0; border-left: 0; border-top: 1px solid var(--line); flex: 1; }
  body.mobile #subBand {
    position: static; pointer-events: auto; text-align: left;
    align-items: stretch; gap: 3px; padding: 8px 12px;
    background: var(--panel); border-bottom: 1px solid var(--line);
  }
  body.mobile #subEn, body.mobile #subZh, body.mobile #subNote {
    background: none; max-width: 100%; width: auto; padding: 0; text-shadow: none;
  }
  body.mobile #subZh, body.mobile #subEn { font-size: calc(16px * var(--scale)); line-height: 1.45; }
  body.mobile #subNote { font-size: calc(12px * var(--scale)); }
  body.mobile header { padding: 6px 10px; gap: 6px; }
  body.mobile header h1 { font-size: 13px; }
  body.mobile header .meta { display: none; }
  body.mobile .controls { margin-left: 0; }
  body.mobile .controls button { padding: 3px 8px; font-size: 11px; }
  #clickLayer { touch-action: manipulation; }

  /* mobile 橫向 = 沉浸看片：影片滿版、字幕回到疊加、header/逐句稿收起
     （16:9 滿寬在橫向就是滿版，下方字幕會被推出畫面 — 所以疊加是唯一解；
     轉回直向即恢復所有控制） */
  @media (orientation: landscape) {
    body.mobile header, body.mobile aside { display: none; }
    body.mobile .stage { flex: 1; position: relative; }
    body.mobile .video-wrap { aspect-ratio: auto; flex: 1; }
    body.mobile #subBand {
      position: absolute; left: 0; right: 0; bottom: 6%; z-index: 6;
      background: none; border: 0; padding: 0 4%;
      pointer-events: none; text-align: center; align-items: center; gap: 4px;
    }
    body.mobile #subEn, body.mobile #subZh, body.mobile #subNote {
      background: rgba(8,10,14,.72); border-radius: .4em; padding: .1em .55em;
      width: fit-content; max-width: 92%; margin: 0;
      text-shadow: 0 1px 2px rgba(0,0,0,.8);
    }
    body.mobile #subZh, body.mobile #subEn { font-size: calc(clamp(16px, 2.2vw, 26px) * var(--scale)); }
    body.mobile #subNote { font-size: calc(12px * var(--scale)); }
  }
`;

export function watchPage(videoId: string): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0f1115">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="apple-touch-icon" href="/icon-192.png">
<title>ytplayer</title>
<style>${STYLE}</style>
</head>
<body data-mode="both">
<header>
  <a id="backBtn" href="/" title="回影片清單">←</a>
  <h1 id="title">載入中…</h1>
  <span class="meta" id="meta"></span>
  <span class="meta" id="quality" title="YouTube 目前實際輸出的畫質（依播放器尺寸自動選）"></span>
  <div class="controls">
    <button id="btnMode" title="快捷鍵 C：開/關字幕">字幕：雙語</button>
    <button id="btnNotes" class="on">譯註：開</button>
    <button id="btnFollow" class="on">跟隨捲動</button>
    <button id="btnSmaller">A−</button>
    <button id="btnBigger">A＋</button>
    <button id="btnAlpha" title="字幕底色/文字整體透明度">透明度：100%</button>
    <button id="btnSpeed" title="快捷鍵 Shift+&lt; / Shift+&gt;">速度：1x</button>
    <button id="btnLock" title="開放：可直接操作 YouTube 原生介面（畫質等）；期間點影片後熱鍵可能失效，鎖回即恢復">YT 介面：鎖定</button>
    <button id="btnTheater" title="快捷鍵 T：收起逐句稿讓畫面變大（畫質會跟著提升）">劇場模式</button>
    <button id="btnFull">⛶ 全螢幕</button>
    <button id="btnHelp" title="操作說明與快捷鍵">？</button>
  </div>
</header>
<main>
  <div class="stage" id="stage">
    <div class="video-wrap">
      <div id="player"></div>
      <div id="clickLayer" title="點擊：播放/暫停・雙擊：全螢幕"></div>
      <div id="cardLayer"></div>
      <div id="subBand"><div id="subEn"></div><div id="subZh"></div><div id="subNote"></div></div>
    </div>
  </div>
  <aside>
    <div class="head">逐句稿（點擊跳轉）・C 字幕開關・按住 H 暫看畫面・？看完整說明</div>
    <div id="list"></div>
  </aside>
</main>
<div id="welcome" class="hidden">
  <div class="card">
    <h2>ytplayer 操作指南</h2>
    <div id="wDesktop">
      <div class="tip">影片區：<b>單擊＝播放/暫停・雙擊＝全螢幕</b>（由本頁接管，快捷鍵才能隨時生效）</div>
      <table>
        <tr><td class="k">Space / K</td><td>播放 / 暫停</td></tr>
        <tr><td class="k">← / →</td><td>快退 / 快進 5 秒</td></tr>
        <tr><td class="k">F・M</td><td>全螢幕・靜音</td></tr>
        <tr><td class="k">Shift + &lt; / &gt;</td><td>播放速度（同 YouTube）</td></tr>
        <tr><td class="k">C</td><td>字幕開 / 關</td></tr>
        <tr><td class="k">按住 H</td><td>字幕暫時隱形，放開恢復 — 看畫面上的資訊用</td></tr>
      </table>
      <div class="tip">
        按鈕列：字幕模式（雙語→只中→只原文→無）、譯註、字級 A±、透明度、速度。<br>
        要動 YouTube 原生介面（畫質齒輪等）→ 按「YT 介面：開放」，用完鎖回。<br>
        右側逐句稿點任一句可跳轉；黃色小字是譯註（術語第一次出現時自動附上白話解釋）。
      </div>
    </div>
    <div id="wMobile" style="display:none">
      <div class="tip">
        <b>點影片＝播放 / 暫停</b>；字幕在影片下方，不會遮住畫面。<br>
        下方逐句稿點任一句可跳轉；黃色小字是譯註（術語第一次出現時的白話解釋）。<br>
        按鈕列：字幕模式（雙語→只中→只原文→無）、譯註、字級 A±、速度。<br>
        要用 YouTube 原生介面（音量、畫質）→ 按「YT 介面：開放」，用完鎖回。
      </div>
    </div>
    <button id="welcomeOk">知道了，開始看片（之後按 ？ 可再看）</button>
  </div>
</div>
<script>
var VID = ${JSON.stringify(videoId)};
var MODES = [["both","字幕：雙語"],["zh","字幕：只中"],["en","字幕：只原文"],["off","字幕：無"]];
var OFF = 3, ALPHAS = [1, 0.75, 0.5, 0.25], SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
// mobile 偵測：touch 為主、UA 為輔
var MOBILE = (window.matchMedia && matchMedia("(pointer: coarse)").matches) ||
  /iPhone|iPad|Android/i.test(navigator.userAgent);
var S = { mode: 0, notes: true, follow: !MOBILE, scale: 1, alpha: 0, speed: 1, theater: false };
var prevMode = 0; // C 鍵切回「無」之前的模式
try { Object.assign(S, JSON.parse(localStorage.getItem("ytplayer-settings") || "{}")); } catch (e) {}
var cues = [], rows = [], cur = -1, cardCues = [], cardKey = "";
var yt = null, ytReady = false, pendingInit = false;
var list = document.getElementById("list");
var subEn = document.getElementById("subEn"), subZh = document.getElementById("subZh"), subNote = document.getElementById("subNote");

function save() { localStorage.setItem("ytplayer-settings", JSON.stringify(S)); }
function applySettings() {
  document.body.dataset.mode = MODES[S.mode][0];
  document.getElementById("btnMode").textContent = MODES[S.mode][1];
  document.body.classList.toggle("notes-off", !S.notes);
  document.getElementById("btnNotes").textContent = "譯註：" + (S.notes ? "開" : "關");
  document.getElementById("btnNotes").classList.toggle("on", S.notes);
  document.getElementById("btnFollow").classList.toggle("on", S.follow);
  document.documentElement.style.setProperty("--scale", S.scale);
  document.documentElement.style.setProperty("--band-alpha", ALPHAS[S.alpha] || 1);
  document.getElementById("btnAlpha").textContent = "透明度：" + Math.round((ALPHAS[S.alpha] || 1) * 100) + "%";
  document.getElementById("btnSpeed").textContent = "速度：" + (SPEEDS[S.speed] || 1) + "x";
  document.body.classList.toggle("theater", !!S.theater);
  document.getElementById("btnTheater").classList.toggle("on", !!S.theater);
  if (yt && yt.setPlaybackRate) yt.setPlaybackRate(SPEEDS[S.speed] || 1);
  setTimeout(showQuality, 1200); // 版面變動後 ABR 需要一點時間換檔
}

// 畫質顯示：YouTube 不讓程式「指定」畫質（setPlaybackQuality 已失效），但讀得到目前值。
// 顯示出來才能驗證「畫面變大 → 畫質變好」有沒有真的發生（docs/video-quality.md §2）
var QLABEL = { tiny: "144p", small: "240p", medium: "360p", large: "480p", hd720: "720p", hd1080: "1080p", hd1440: "1440p", hd2160: "4K", highres: "高解析" };
function showQuality() {
  var el = document.getElementById("quality");
  if (!el || !yt || !yt.getPlaybackQuality) return;
  var q = yt.getPlaybackQuality();
  if (!q || q === "unknown") { el.textContent = ""; return; }
  var box = document.getElementById("player").getBoundingClientRect();
  var dpr = window.devicePixelRatio || 1;
  el.textContent = "・🖥 " + (QLABEL[q] || q);
  el.title = "YouTube 目前輸出 " + (QLABEL[q] || q) +
    "（播放器 " + Math.round(box.width) + "×" + Math.round(box.height) +
    " CSS px、DPR " + dpr + "）。畫質由 YouTube 依播放器尺寸自動決定 — 按 T 或全螢幕把畫面變大就可能提升。";
}
document.getElementById("btnMode").onclick = function () { S.mode = (S.mode + 1) % MODES.length; save(); applySettings(); };
document.getElementById("btnAlpha").onclick = function () { S.alpha = (S.alpha + 1) % ALPHAS.length; save(); applySettings(); };
document.getElementById("btnSpeed").onclick = function () { S.speed = (S.speed + 1) % SPEEDS.length; save(); applySettings(); };
function stepSpeed(d) { S.speed = Math.min(SPEEDS.length - 1, Math.max(0, S.speed + d)); save(); applySettings(); }
document.getElementById("btnTheater").onclick = function () { S.theater = !S.theater; save(); applySettings(); };
document.getElementById("btnNotes").onclick = function () { S.notes = !S.notes; save(); applySettings(); };
document.getElementById("btnFollow").onclick = function () { S.follow = !S.follow; save(); applySettings(); };
document.getElementById("btnSmaller").onclick = function () { S.scale = Math.max(0.7, +(S.scale - 0.1).toFixed(2)); save(); applySettings(); };
document.getElementById("btnBigger").onclick = function () { S.scale = Math.min(1.8, +(S.scale + 0.1).toFixed(2)); save(); applySettings(); };
function toggleFull() {
  var st = document.getElementById("stage");
  if (document.fullscreenElement) document.exitFullscreen(); else st.requestFullscreen();
}
document.addEventListener("fullscreenchange", function () { setTimeout(showQuality, 1500); });
document.getElementById("btnFull").onclick = toggleFull;

// 我們的字幕層就是 CC — 原生 CC 一律關（ingest 時開的 CC 是帳號黏性設定，embed 會繼承）。
// setOption('captions','track',{}) 是官方 API 清空字幕軌；unloadModule 當雙保險
function killNativeCC() {
  if (!yt) return;
  try { yt.setOption && yt.setOption("captions", "track", {}); } catch (e) { /* noop */ }
  try { yt.setOption && yt.setOption("cc", "track", {}); } catch (e) { /* noop */ }
  try { yt.unloadModule && yt.unloadModule("captions"); } catch (e) { /* noop */ }
  try { yt.unloadModule && yt.unloadModule("cc"); } catch (e) { /* noop */ }
}

function togglePlay() {
  if (!yt || !yt.getPlayerState) return;
  if (yt.getPlayerState() === 1) yt.pauseVideo(); else yt.playVideo();
}
function seekBy(sec) {
  if (yt && yt.getCurrentTime) yt.seekTo(Math.max(0, yt.getCurrentTime() + sec), true);
}
// 點擊層：播放控制由我們接手，焦點不進 iframe → 熱鍵（含全螢幕時）永遠有效
var clickLayer = document.getElementById("clickLayer");
clickLayer.onclick = togglePlay;
clickLayer.ondblclick = toggleFull;

// 「YT 介面：開放」：暫時撤掉點擊層，讓原生控制列（畫質齒輪等）可直接操作
var unlocked = false;
document.getElementById("btnLock").onclick = function () {
  unlocked = !unlocked;
  document.body.classList.toggle("unlock", unlocked);
  this.textContent = "YT 介面：" + (unlocked ? "開放中" : "鎖定");
  this.classList.toggle("on", unlocked);
  if (!unlocked) window.focus(); // 鎖回時把焦點拿回來，熱鍵立即恢復
};

// 快捷鍵：C 開關字幕、按住 H 暫看畫面；焦點既然留在本頁，
// 一併補上播放鍵（Space/K、←→ ±5s、F 全螢幕、M 靜音），體感同 YouTube
document.addEventListener("keydown", function (e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  var k = e.key.toLowerCase();
  if (k === "c") {
    if (S.mode === OFF) { S.mode = prevMode; }
    else { prevMode = S.mode; S.mode = OFF; }
    save(); applySettings();
  } else if (k === "h" && !e.repeat) {
    document.body.classList.add("peek");
  } else if (k === " " || k === "k") {
    e.preventDefault();
    togglePlay();
  } else if (k === "arrowleft") {
    e.preventDefault();
    seekBy(-5);
  } else if (k === "arrowright") {
    e.preventDefault();
    seekBy(5);
  } else if (k === "t") {
    S.theater = !S.theater; save(); applySettings();
  } else if (k === "f") {
    toggleFull();
  } else if (e.key === "<") {
    stepSpeed(-1);
  } else if (e.key === ">") {
    stepSpeed(1);
  } else if (k === "m" && yt && yt.isMuted) {
    if (yt.isMuted()) yt.unMute(); else yt.mute();
  }
});
document.addEventListener("keyup", function (e) {
  if (e.key.toLowerCase() === "h") document.body.classList.remove("peek");
});
window.addEventListener("blur", function () { document.body.classList.remove("peek"); });

// mobile 模式：字幕帶移出影片（不遮畫面）、隱藏觸控用不到的東西
if (MOBILE) {
  document.body.classList.add("mobile");
  document.getElementById("stage").appendChild(document.getElementById("subBand"));
  document.querySelector("aside .head").textContent = "逐句稿（點擊跳轉）";
  document.getElementById("wDesktop").style.display = "none";
  document.getElementById("wMobile").style.display = "";
  document.getElementById("btnAlpha").style.display = "none"; // 字幕已不疊影片，透明度無意義
}
// iPhone Safari 不支援網頁元素全螢幕 API，藏掉假按鈕
if (!document.documentElement.requestFullscreen) {
  document.getElementById("btnFull").style.display = "none";
}

// 首次導覽：看過一次就不再自動跳（？按鈕隨時可叫回）
var welcome = document.getElementById("welcome");
if (!localStorage.getItem("ytplayer-welcome-v1")) welcome.classList.remove("hidden");
document.getElementById("welcomeOk").onclick = function () {
  localStorage.setItem("ytplayer-welcome-v1", "1");
  welcome.classList.add("hidden");
};
document.getElementById("btnHelp").onclick = function () { welcome.classList.remove("hidden"); };
welcome.addEventListener("click", function (e) { if (e.target === welcome) document.getElementById("welcomeOk").click(); });

applySettings();

var tag = document.createElement("script");
tag.src = "https://www.youtube.com/iframe_api";
document.head.appendChild(tag);
window.onYouTubeIframeAPIReady = function () { ytReady = true; if (pendingInit) createYT(); };
function createYT() {
  yt = new YT.Player("player", {
    videoId: VID,
    playerVars: { rel: 0, playsinline: 1, cc_load_policy: 0 },
    events: {
      onReady: function () {
        if (yt.setPlaybackRate) yt.setPlaybackRate(SPEEDS[S.speed] || 1);
        killNativeCC();
      },
      // captions 模組是播放後才懶載入的 — onReady 時 unload 是對空氣揮拳。
      // onApiChange 正是模組載入的時點（官方事件），在這裡關才關得掉
      onApiChange: killNativeCC,
      onStateChange: killNativeCC,
    },
  });
}

function fmtTime(t) {
  t = Math.floor(t);
  var m = Math.floor(t / 60), s = t % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function load() {
  fetch("/subs/" + VID + "/bilingual.json").then(function (r) {
    if (!r.ok) {
      // 還沒翻好：顯示 job 進度（status.json 每步更新），此頁自動重試
      fetch("/subs/" + VID + "/status.json").then(function (s) { return s.ok ? s.json() : null; })
        .catch(function () { return null; })
        .then(function (st) {
          var msg = '這支影片的翻譯還沒好。此頁會自動重試…';
          if (st && st.failed) msg = '⚠ 翻譯失敗：' + (st.failReason || '未知原因') + '<br>可用 /translate/' + VID + '?force=1 重跑。';
          else if (st && st.stage) msg = '翻譯中：' + st.stage + (st.step ? '（' + st.step + '）' : '') + '。此頁會自動重試…';
          else msg += '<br>還沒 ingest 的話：到 YouTube 開這支影片 → 開 CC 選原文軌 → 點 ext 送出。';
          list.innerHTML = '<div class="msg">' + msg + '</div>';
        });
      setTimeout(load, 20000);
      return;
    }
    r.json().then(init);
  }).catch(function () { setTimeout(load, 20000); });
}

function init(doc) {
  var all = doc.cues || [];
  // schema v2 用 orig 取代 en（kvsplayer 合併後 ko/ja/en 通用）；v1 舊資料照舊
  all.forEach(function (c) { if (c.en == null && c.orig != null) c.en = c.orig; });
  // 字卡（video 路由 kind=card）走獨立圖層；對白字幕帶與同步邏輯只吃 speech
  cardCues = all.filter(function (c) { return c.kind === "card"; });
  cues = all.filter(function (c) { return c.kind !== "card"; });
  // 兜底 chaining：資料端沒 retime 過（無 end0）的舊片，載入時輕量延伸句尾
  // （句間空隙 → 字幕早消失；資料端修正鈕在 /admin，見 docs/subtitle-timing.md）
  if (!cues.some(function (c) { return c.end0 != null; })) {
    for (var ci = 0; ci < cues.length; ci++) {
      var nx = cues[ci + 1];
      if (nx && nx.start - cues[ci].end > 0) cues[ci].end = Math.min(nx.start - 0.05, cues[ci].end + 2);
    }
  }
  document.getElementById("title").textContent = doc.meta && doc.meta.title || VID;
  document.getElementById("meta").textContent =
    (doc.meta && doc.meta.channel || "") + "・" + cues.length + " 句" +
    (cardCues.length ? "・🃏 " + cardCues.length + " 字卡" : "") + "・" + (doc.model || "") +
    (doc.trust === "model" ? "・⏱ 時間軸為模型估算" : "") +
    (doc.warnings && doc.warnings.length ? "・⚠ " + doc.warnings.length + " warnings" : "");
  document.title = (doc.meta && doc.meta.title || VID) + " — ytplayer";
  list.innerHTML = "";
  rows = [];
  all.forEach(function (c) {
    var d = document.createElement("div");
    d.className = "row";
    var html = '<span class="t">' + fmtTime(c.start) + "</span>" +
      (c.kind === "card" ? '<span class="kindCard">🃏 字卡</span>' : "") +
      '<span class="zh"></span><span class="en"></span>';
    if (c.note) html += '<span class="note"></span>';
    d.innerHTML = html;
    d.querySelector(".zh").textContent = c.zh;
    d.querySelector(".en").textContent = c.en;
    if (c.note) d.querySelector(".note").textContent = c.note;
    d.onclick = function () { if (yt && yt.seekTo) { yt.seekTo(c.start, true); yt.playVideo(); } };
    list.appendChild(d);
    if (c.kind !== "card") rows.push(d); // rows 與 cues（speech）平行，供高亮同步
  });
  if (ytReady) createYT(); else pendingInit = true;
  setInterval(tick, 150);
}

function findCue(t) {
  // binary search：最後一個 start <= t 的 cue；在其 end + 1.5s 寬限內都算當前句
  var lo = 0, hi = cues.length - 1, ans = -1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  if (ans >= 0 && t < cues[ans].end + 1.5) return ans;
  return -1;
}

function tickCards(t) {
  if (!cardCues.length) return;
  var vis = [];
  for (var i = 0; i < cardCues.length; i++) {
    var c = cardCues[i];
    if (c.start > t) break; // 依 start 排序，之後的都還沒到
    if (t < c.end + 0.5) vis.push(c);
  }
  var key = vis.map(function (c) { return c.start; }).join(",");
  if (key === cardKey) return;
  cardKey = key;
  var layer = document.getElementById("cardLayer");
  layer.innerHTML = "";
  vis.forEach(function (c) {
    var d = document.createElement("div");
    d.className = "card";
    d.textContent = c.zh;
    layer.appendChild(d);
  });
}

var qTick = 0;
function tick() {
  if (!yt || !yt.getCurrentTime) return;
  if (++qTick % 33 === 0) showQuality(); // 150ms × 33 ≈ 每 5 秒更新一次畫質顯示
  var t = yt.getCurrentTime();
  tickCards(t);
  var idx = findCue(t);
  if (idx === cur) return;
  if (cur >= 0 && rows[cur]) rows[cur].classList.remove("cur");
  cur = idx;
  if (idx < 0) { subZh.textContent = ""; subEn.textContent = ""; subNote.textContent = ""; return; }
  var c = cues[idx];
  subZh.textContent = c.zh;
  subEn.textContent = c.en;
  subNote.textContent = c.note || "";
  rows[idx].classList.add("cur");
  if (S.follow) rows[idx].scrollIntoView({ block: MOBILE ? "nearest" : "center", behavior: "smooth" });
}

load();
</script>
</body>
</html>`;
}

export function indexPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0f1115">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/icon-192.png">
<title>ytplayer — 影片清單</title>
<style>${STYLE}
  #videos { max-width: 720px; margin: 0 auto; width: 100%; overflow-y: auto; padding: 8px 0; }
  .vrow { padding: 12px 16px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .vrow:hover { background: rgba(255,255,255,.04); }
  .vrow .title { font-size: 15px; font-weight: 600; }
  .vrow .sub { font-size: 12px; color: var(--dim); margin-top: 2px; }
  .vrow.pending { cursor: default; opacity: .6; }
</style>
</head>
<body>
<header>
  <h1>ytplayer — 雙語字幕</h1>
  <span class="meta">自用</span>
  <a href="/share" class="meta" style="margin-left:auto;color:var(--en)">＋ 送片</a>
</header>
<main>
  <div id="inbox"></div>
  <div id="videos"><div class="msg">載入中…</div></div>
</main>
<script>
// 清單需要 key（等於觀看紀錄）。首次用 /?key=XXX 進來即存進 localStorage 並清掉網址，
// 之後直接開 / 就好；key 不進網址列歷史。單片 /watch/{id} 仍公開、可分享
var KEY_STORE = "ytplayer-key";
var qs = new URLSearchParams(location.search);
if (qs.get("key")) {
  localStorage.setItem(KEY_STORE, qs.get("key"));
  history.replaceState(null, "", location.pathname);
}
var savedKey = localStorage.getItem(KEY_STORE) || "";

function askKey(msg) {
  var box = document.getElementById("videos");
  box.innerHTML = '<div class="msg">' + msg +
    '<br><br><input id="k" type="password" placeholder="INGEST_KEY" style="padding:6px 8px;border-radius:6px;border:1px solid var(--line);background:var(--panel);color:var(--fg)">' +
    ' <button id="kb" style="padding:6px 12px;border:0;border-radius:6px;background:var(--accent);cursor:pointer">記住</button></div>';
  document.getElementById("kb").onclick = function () {
    localStorage.setItem(KEY_STORE, document.getElementById("k").value.trim());
    location.reload();
  };
}

function esc(v) { var d = document.createElement("span"); d.textContent = String(v == null ? "" : v); return d.innerHTML; }

// PWA：註冊極簡 service worker 取得可安裝資格（不快取，見 docs/pwa-plan.md §4.2）
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {});

// 待補字幕佇列（手機送進來的片，等桌機 ext 補收）
function loadInbox() {
  if (!savedKey) return;
  fetch("/inbox.json", { headers: { "x-ingest-key": savedKey } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) {
      var box = document.getElementById("inbox");
      if (!d || !d.count) { box.innerHTML = ""; return; }
      box.innerHTML = '<div class="msg" style="color:var(--accent)">📥 待補字幕 ' + d.count +
        ' 支 — 桌機開 Chrome 時，擴充功能圖示會顯示數量，點一下即可補收</div>' +
        d.items.map(function (it) {
          return '<div class="vrow pending"><div class="title">' + esc(it.title || it.videoId) + '</div>' +
            '<div class="sub">' + it.videoId + '・' + (it.requestedAt || "").slice(0, 16).replace("T", " ") +
            '・<a href="https://www.youtube.com/watch?v=' + it.videoId + '" target="_blank" style="color:var(--en)">YouTube</a>' +
            '・<a href="#" data-del="' + it.videoId + '" style="color:var(--dim)">移除</a></div></div>';
        }).join("");
      box.querySelectorAll("[data-del]").forEach(function (a) {
        a.onclick = function (e) {
          e.preventDefault();
          fetch("/inbox/" + a.dataset.del, { method: "DELETE", headers: { "x-ingest-key": savedKey } }).then(loadInbox);
        };
      });
    })
    .catch(function () {});
}
loadInbox();

fetch("/videos.json", { headers: savedKey ? { "x-ingest-key": savedKey } : {} }).then(function (r) {
  if (r.status === 403) { askKey("影片清單需要金鑰（單片播放連結不需要）。"); return null; }
  return r.json();
}).then(function (vids) {
  if (!vids) return;
  var box = document.getElementById("videos");
  box.innerHTML = "";
  if (!vids.length) { box.innerHTML = '<div class="msg">還沒有影片。去 YouTube 開影片 → 開 CC 選原文軌 → 點 ext 送出。</div>'; return; }
  vids.forEach(function (v) {
    var d = document.createElement("div");
    d.className = "vrow" + (v.translated ? "" : " pending");
    var t = document.createElement("div"); t.className = "title";
    t.textContent = v.title || v.videoId;
    var s = document.createElement("div"); s.className = "sub";
    s.textContent = v.translated
      ? (v.channel || "") + "・" + v.cueCount + " 句・" + v.videoId
      : v.videoId + (v.queued ? "・⏳ 已排入佇列，cron 每 5 分鐘自動翻" : "・🚫 " + (v.reason || "不在自動翻譯範圍"));
    d.appendChild(t); d.appendChild(s);
    if (v.translated) d.onclick = function () { location.href = "/watch/" + v.videoId; };
    box.appendChild(d);
  });
}).catch(function () {
  document.getElementById("videos").innerHTML = '<div class="msg">清單載入失敗</div>';
});
</script>
</body>
</html>`;
}

// /admin — 一頁式營運儀表板 + 看片任務入口。
// 上：今日花費（/health 同源資料）＋所有 job 狀態（/jobs.json，15 秒自動刷新）。
// 下：看片任務表單（video 路由）。認證：頁面建議用 Cloudflare Access 蓋 /admin；
// API 帶 localStorage 的 key（首次用 /?key=… 開清單頁即已存入）。
export function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>ytplayer — 儀表板</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0f0f13; color: #eee; font: 14px/1.6 system-ui, "Noto Sans TC", sans-serif; }
  main { max-width: 860px; margin: 24px auto 60px; padding: 0 16px; }
  h1 { font-size: 19px; margin: 18px 0 6px; } h2 { font-size: 15px; margin: 26px 0 8px; color: #ccc; }
  .hint { color: #999; font-size: 12.5px; }
  .strip { display: flex; gap: 10px; flex-wrap: wrap; margin: 14px 0; }
  .stat { background: #1a1a22; border: 1px solid #2a2a35; border-radius: 10px; padding: 10px 16px; min-width: 130px; }
  .stat .v { font-size: 20px; font-weight: 700; color: #ffd54a; font-variant-numeric: tabular-nums; }
  .stat .k { font-size: 11.5px; color: #999; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #23232d; vertical-align: top; }
  th { color: #888; font-weight: 500; font-size: 11.5px; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .st-run { color: #6cf; } .st-done { color: #7c5; } .st-fail { color: #f66; } .st-pause { color: #fa5; }
  .title { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; vertical-align: bottom; }
  a { color: #59f; text-decoration: none; } a:hover { text-decoration: underline; }
  label { display: block; margin: 12px 0 4px; color: #bbb; font-size: 13px; }
  input { width: 100%; box-sizing: border-box; background: #1a1a22; color: #eee; border: 1px solid #333;
          border-radius: 8px; padding: 9px 12px; font-size: 14px; }
  button { margin-top: 14px; background: #ffd54a; color: #000; border: 0; border-radius: 8px;
           padding: 9px 20px; font-size: 14px; font-weight: 700; cursor: pointer; }
  #out { margin-top: 14px; white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12.5px; }
  .ok { color: #7c5; } .err { color: #f66; }
  #jerr { color: #f66; font-size: 13px; margin: 10px 0; }
</style>
</head>
<body>
<main>
  <h1>📊 ytplayer 儀表板</h1>
  <div class="strip" id="strip"><div class="stat"><div class="v">…</div><div class="k">載入中</div></div></div>
  <div id="jerr"></div>
  <h2>任務狀態 <span class="hint">（15 秒自動刷新・費用為估算值，費率 <span id="rate">?</span> NT$/M tokens，var COST_NTD_PER_M 可調）</span></h2>
  <table>
    <thead><tr><th>影片</th><th>路由</th><th>狀態</th><th>tokens</th><th>est NT$</th><th>耗時</th><th>更新於</th></tr></thead>
    <tbody id="rows"><tr><td colspan="7" class="hint">載入中…</td></tr></tbody>
  </table>

  <h2>🎬 看片任務（Gemini 直接看片）</h2>
  <p class="hint">給「字卡型韓綜」與「完全沒有 CC」的影片。成本約純文字翻譯 30 倍（MEDIUM ≈ 300 tok/秒），
  一般有原文 CC 的影片請照常用 ext ingest。</p>
  <label>YouTube 連結或影片 ID</label>
  <input id="url" placeholder="https://www.youtube.com/watch?v=… 或 11 碼 ID">
  <label>片長（分鐘）— 建議填，比自動探測可靠</label>
  <input id="dur" type="number" min="1" placeholder="例：72（留空 = countTokens 自動探測 + 開放式掃描）">
  <label>原文語言（預設 ko）</label>
  <input id="lang" placeholder="ko">
  <label>頻道鎖定表（選填）— glossary/channel-{鍵值}.json，人名與節目專名照表翻</label>
  <input id="chan" placeholder="例：15ya（內建的十五夜譯名表）；留空 = 只吃 genre 通用表">
  <button id="go">開始看片</button>
  <div id="out"></div>
</main>
<script>
var KEY = localStorage.getItem("ytplayer-key");
function headers() {
  var h = { "content-type": "application/json" };
  if (KEY) h["x-ingest-key"] = KEY;
  return h;
}
function fmtDur(ms) {
  if (!(ms > 0)) return "—";
  var m = Math.floor(ms / 60000), s = Math.round(ms % 60000 / 1000);
  return m ? m + "分" + (s ? s + "秒" : "") : s + "秒";
}
function esc(s) { var d = document.createElement("span"); d.textContent = String(s == null ? "" : s); return d.innerHTML; }
function stCls(j) { return j.failed ? "st-fail" : j.stage === "done" ? "st-done" : j.stage === "paused" ? "st-pause" : "st-run"; }
function stTxt(j) {
  if (j.failed) return "❌ failed：" + (j.failReason || "");
  if (j.stage === "done") return "✅ done" + (j.warningCount ? "（⚠" + j.warningCount + "）" : "");
  if (j.stage === "paused") return "⏸ " + (j.failReason || "日預算已滿");
  return "▶ " + j.stage + (j.step ? " " + j.step : "");
}
function refresh() {
  fetch("/jobs.json", { headers: headers() })
    .then(function (r) {
      if (r.status === 403) throw new Error("未授權：先用 /?key=你的KEY 開一次清單頁（key 會存進瀏覽器），或把本頁掛在 Cloudflare Access 後面。");
      return r.json();
    })
    .then(function (d) {
      document.getElementById("jerr").textContent = "";
      document.getElementById("rate").textContent = d.rateNTDPerM;
      var t = d.today;
      document.getElementById("strip").innerHTML =
        '<div class="stat"><div class="v">' + t.tokens.toLocaleString() + '</div><div class="k">今日 tokens（上限 ' + t.dailyCapTokens.toLocaleString() + '）</div></div>' +
        '<div class="stat"><div class="v">' + t.llmCalls + '</div><div class="k">今日 LLM 呼叫</div></div>' +
        '<div class="stat"><div class="v">NT$ ' + t.estNTD + '</div><div class="k">今日估算費用</div></div>' +
        '<div class="stat"><div class="v">' + d.jobs.filter(function (j) { return !j.failed && j.stage !== "done"; }).length + '</div><div class="k">進行中任務</div></div>';
      var rows = d.jobs.map(function (j) {
        var elapsed = (j.stage === "done" || j.failed)
          ? Date.parse(j.updatedAt) - Date.parse(j.startedAt)
          : Date.now() - Date.parse(j.startedAt);
        return "<tr><td><a class='title' href='/watch/" + j.videoId + "' target='_blank' title='" + esc(j.title) + "'>" + esc(j.title) + "</a><br>" +
          "<span class='hint'>" + j.videoId + "・<a href='/subs/" + j.videoId + "/status.json' target='_blank'>status</a>" +
          (j.stage === "done" ? "・<a href='#' onclick='return retime(\\"" + j.videoId + "\\")' title='重算顯示時間軸（chaining，零 LLM 費用、冪等可重按）'>⏱修時間</a>" : "") +
          "</span></td>" +
          "<td>" + esc(j.route || "") + "</td>" +
          "<td class='" + stCls(j) + "'>" + esc(stTxt(j)) + "</td>" +
          "<td class='num'>" + (j.tokensUsed || 0).toLocaleString() +
          (j.thoughtTokens > 0 ? "<br><span class='hint'>思考 " + j.thoughtTokens.toLocaleString() + "</span>" : "") + "</td>" +
          "<td class='num'>" + (j.estNTD || 0) + "</td>" +
          "<td class='num'>" + fmtDur(elapsed) + "</td>" +
          "<td class='num'>" + (j.updatedAt ? new Date(j.updatedAt).toLocaleTimeString() : "—") + "</td></tr>";
      });
      document.getElementById("rows").innerHTML = rows.join("") || "<tr><td colspan='7' class='hint'>還沒有任何任務</td></tr>";
    })
    .catch(function (e) { document.getElementById("jerr").textContent = String(e.message || e); });
}
refresh();
setInterval(refresh, 15000);

// B 修正鈕：對已翻好的影片重算顯示時間軸（docs/subtitle-timing.md）— 零 LLM、冪等
function retime(id) {
  fetch("/retime/" + id, { method: "POST", headers: headers() })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      document.getElementById("jerr").textContent = d.ok
        ? "⏱ " + id + "：已調整 " + d.changed + "/" + d.cueCount + " 句的顯示時間"
        : "修時間失敗：" + (d.error || "");
    })
    .catch(function (e) { document.getElementById("jerr").textContent = String(e); });
  return false;
}

var out = document.getElementById("out");
document.getElementById("go").onclick = function () {
  var m = (document.getElementById("url").value || "").match(/(?:v=|youtu\\.be\\/|shorts\\/)?([A-Za-z0-9_-]{11})(?:[?&#]|$)/);
  if (!m) { out.innerHTML = '<span class="err">無法解析影片 ID</span>'; return; }
  var id = m[1];
  var body = {};
  var dur = +document.getElementById("dur").value;
  if (dur > 0) body.durationMin = dur;
  var lang = document.getElementById("lang").value.trim();
  if (lang) body.lang = lang;
  var chan = document.getElementById("chan").value.trim();
  if (chan) body.channel = chan;
  out.textContent = "送出中…";
  fetch("/watch-job/" + id, { method: "POST", headers: headers(), body: JSON.stringify(body) })
    .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
    .then(function (r) {
      if (!r.j.ok) { out.innerHTML = '<span class="err">' + (r.j.error || ("HTTP " + r.s)) + "</span>"; return; }
      out.innerHTML = '<span class="ok">已受理。</span>上表 15 秒內會出現進度・完成後：<a href="/watch/' + id + '" target="_blank">/watch/' + id + "</a>";
      setTimeout(refresh, 3000);
    })
    .catch(function (e) { out.innerHTML = '<span class="err">' + e + "</span>"; });
};
</script>
</body>
</html>`;
}

// /share — PWA share target 落點（Android）＋ iOS 的貼上框退路（docs/pwa-plan.md §4.3）。
// 手機沒有 ext（攔截不了字幕），所以這裡只把影片排進「待補字幕」佇列，
// 桌機開 Chrome 時由 ext popup 提醒補收；急件才走看片模式（貴 30 倍）。
export function sharePage(): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="manifest" href="/manifest.webmanifest">
<title>ytplayer — 送片</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0f1115; color: #e8eaf0;
         font: 15px/1.65 system-ui, "Noto Sans TC", sans-serif; }
  main { max-width: 520px; margin: 0 auto; padding: 28px 18px 60px; }
  h1 { font-size: 19px; margin-bottom: 6px; }
  .hint { color: #8b93a5; font-size: 13px; }
  input { width: 100%; box-sizing: border-box; background: #171a21; color: #e8eaf0;
          border: 1px solid #262b36; border-radius: 10px; padding: 12px 14px; font-size: 16px; margin-top: 14px; }
  button { width: 100%; margin-top: 12px; background: #ffd54a; color: #000; border: 0;
           border-radius: 10px; padding: 13px; font-size: 16px; font-weight: 700; cursor: pointer; }
  button.ghost { background: #171a21; color: #e8eaf0; border: 1px solid #262b36; font-weight: 500; }
  #out { margin-top: 18px; font-size: 14px; line-height: 1.7; }
  .ok { color: #7c5; } .err { color: #f66; }
  a { color: #9ecbff; }
</style>
</head>
<body>
<main>
  <h1>📥 送片給 ytplayer</h1>
  <p class="hint">手機沒有擴充功能、抓不到字幕，所以這裡先排隊：
  桌機開 Chrome 時擴充功能會提醒你補收（字幕品質與費用都最好）。</p>
  <input id="url" placeholder="貼上 YouTube 連結" autocomplete="off" autocapitalize="off">
  <button id="go">排入待補</button>
  <button id="goWatch" class="ghost">改用看片模式（立刻有字幕，費用約 30 倍）</button>
  <div id="out"></div>
  <p class="hint" style="margin-top:22px">
    <a href="/">← 影片清單</a>　<a href="/admin">儀表板</a>
  </p>
</main>
<script>
var out = document.getElementById("out");
var input = document.getElementById("url");
// share target（Android）：url 可能落在 url 或 text 參數
var q = new URLSearchParams(location.search);
var shared = q.get("url") || q.get("text") || "";
if (shared) {
  input.value = shared;
  history.replaceState(null, "", "/share"); // 連結不留在網址列（noindex 之外的第二層保險）
}
function headers() {
  var h = { "content-type": "application/json" };
  var key = localStorage.getItem("ytplayer-key");
  if (key) h["x-ingest-key"] = key;
  return h;
}
function idOf(v) {
  var m = (v || "").match(/(?:v=|youtu\\.be\\/|shorts\\/|embed\\/)?([A-Za-z0-9_-]{11})(?:[?&#]|$)/);
  return m ? m[1] : null;
}
function post(path, body) {
  out.textContent = "送出中…";
  return fetch(path, { method: "POST", headers: headers(), body: JSON.stringify(body || {}) })
    .then(function (r) { return r.json().then(function (j) { return { s: r.status, j: j }; }); })
    .then(function (r) {
      if (r.s === 403) {
        out.innerHTML = '<span class="err">未授權</span>：請先在這台裝置用 <code>/?key=你的KEY</code> 開一次清單頁（key 會存進瀏覽器）。';
        return null;
      }
      if (!r.j.ok) { out.innerHTML = '<span class="err">' + (r.j.error || ("HTTP " + r.s)) + "</span>"; return null; }
      return r.j;
    })
    .catch(function (e) { out.innerHTML = '<span class="err">' + e + "</span>"; return null; });
}
document.getElementById("go").onclick = function () {
  var id = idOf(input.value);
  if (!id) { out.innerHTML = '<span class="err">看不懂這個連結</span>'; return; }
  post("/inbox", { url: input.value, via: shared ? "share" : "paste" }).then(function (j) {
    if (!j) return;
    if (j.already === "translated") {
      out.innerHTML = '<span class="ok">這支已經翻好了。</span><br><a href="/watch/' + id + '">▶ 直接看</a>';
    } else if (j.already === "ingested") {
      out.innerHTML = '<span class="ok">已經送過了，翻譯進行中。</span><br><a href="/watch/' + id + '">▶ 到播放頁看進度</a>';
    } else {
      out.innerHTML = '<span class="ok">✅ 已排入待補。</span><br>桌機開 Chrome 時，擴充功能圖示會顯示待補數量，點一下就能補收。<br><a href="/watch/' + id + '">▶ 播放頁</a>';
    }
  });
};
document.getElementById("goWatch").onclick = function () {
  var id = idOf(input.value);
  if (!id) { out.innerHTML = '<span class="err">看不懂這個連結</span>'; return; }
  if (!confirm("看片模式會讓 Gemini 直接看整部影片，費用約為一般翻譯的 30 倍。確定嗎？")) return;
  post("/watch-job/" + id, {}).then(function (j) {
    if (!j) return;
    out.innerHTML = '<span class="ok">🎬 看片任務已受理。</span><br><a href="/watch/' + id + '">▶ 播放頁（翻好前會顯示進度）</a>';
  });
};
</script>
</body>
</html>`;
}
