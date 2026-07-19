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
    height: 100vh; display: flex; flex-direction: column; overflow: hidden;
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

  @media (max-width: 860px) {
    main { flex-direction: column; }
    aside { max-width: none; min-width: 0; border-left: 0; border-top: 1px solid var(--line); flex: 1; }
    .stage { flex: 0 0 auto; }
    .video-wrap { aspect-ratio: 16/9; flex: none; }
  }
`;

export function watchPage(videoId: string): string {
  return `<!DOCTYPE html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ytplayer</title>
<style>${STYLE}</style>
</head>
<body data-mode="both">
<header>
  <a id="backBtn" href="/" title="回影片清單">←</a>
  <h1 id="title">載入中…</h1>
  <span class="meta" id="meta"></span>
  <div class="controls">
    <button id="btnMode" title="快捷鍵 C：開/關字幕">字幕：雙語</button>
    <button id="btnNotes" class="on">譯註：開</button>
    <button id="btnFollow" class="on">跟隨捲動</button>
    <button id="btnSmaller">A−</button>
    <button id="btnBigger">A＋</button>
    <button id="btnAlpha" title="字幕底色/文字整體透明度">透明度：100%</button>
    <button id="btnSpeed" title="快捷鍵 Shift+&lt; / Shift+&gt;">速度：1x</button>
    <button id="btnLock" title="開放：可直接操作 YouTube 原生介面（畫質等）；期間點影片後熱鍵可能失效，鎖回即恢復">YT 介面：鎖定</button>
    <button id="btnFull">⛶ 全螢幕</button>
  </div>
</header>
<main>
  <div class="stage" id="stage">
    <div class="video-wrap">
      <div id="player"></div>
      <div id="clickLayer" title="點擊：播放/暫停・雙擊：全螢幕"></div>
      <div id="subBand"><div id="subEn"></div><div id="subZh"></div><div id="subNote"></div></div>
    </div>
  </div>
  <aside>
    <div class="head">逐句稿（點擊跳轉）・C 字幕開關・按住 H 暫看畫面・Space 播放・←→ ±5s・F 全螢幕</div>
    <div id="list"></div>
  </aside>
</main>
<script>
var VID = ${JSON.stringify(videoId)};
var MODES = [["both","字幕：雙語"],["zh","字幕：只中"],["en","字幕：只原文"],["off","字幕：無"]];
var OFF = 3, ALPHAS = [1, 0.75, 0.5, 0.25], SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];
var S = { mode: 0, notes: true, follow: true, scale: 1, alpha: 0, speed: 1 };
var prevMode = 0; // C 鍵切回「無」之前的模式
try { Object.assign(S, JSON.parse(localStorage.getItem("ytplayer-settings") || "{}")); } catch (e) {}
var cues = [], rows = [], cur = -1;
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
  if (yt && yt.setPlaybackRate) yt.setPlaybackRate(SPEEDS[S.speed] || 1);
}
document.getElementById("btnMode").onclick = function () { S.mode = (S.mode + 1) % MODES.length; save(); applySettings(); };
document.getElementById("btnAlpha").onclick = function () { S.alpha = (S.alpha + 1) % ALPHAS.length; save(); applySettings(); };
document.getElementById("btnSpeed").onclick = function () { S.speed = (S.speed + 1) % SPEEDS.length; save(); applySettings(); };
function stepSpeed(d) { S.speed = Math.min(SPEEDS.length - 1, Math.max(0, S.speed + d)); save(); applySettings(); }
document.getElementById("btnNotes").onclick = function () { S.notes = !S.notes; save(); applySettings(); };
document.getElementById("btnFollow").onclick = function () { S.follow = !S.follow; save(); applySettings(); };
document.getElementById("btnSmaller").onclick = function () { S.scale = Math.max(0.7, +(S.scale - 0.1).toFixed(2)); save(); applySettings(); };
document.getElementById("btnBigger").onclick = function () { S.scale = Math.min(1.8, +(S.scale + 0.1).toFixed(2)); save(); applySettings(); };
function toggleFull() {
  var st = document.getElementById("stage");
  if (document.fullscreenElement) document.exitFullscreen(); else st.requestFullscreen();
}
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
      list.innerHTML = '<div class="msg">這支影片的翻譯還沒好（cron 每 5 分鐘自動跑）。此頁會自動重試…<br>' +
        '還沒 ingest 的話：到 YouTube 開這支影片 → 開 CC 選原文軌 → 點 ext 送出。</div>';
      setTimeout(load, 20000);
      return;
    }
    r.json().then(init);
  }).catch(function () { setTimeout(load, 20000); });
}

function init(doc) {
  cues = doc.cues || [];
  document.getElementById("title").textContent = doc.meta && doc.meta.title || VID;
  document.getElementById("meta").textContent =
    (doc.meta && doc.meta.channel || "") + "・" + cues.length + " 句・" + (doc.model || "") +
    (doc.warnings && doc.warnings.length ? "・⚠ " + doc.warnings.length + " warnings" : "");
  document.title = (doc.meta && doc.meta.title || VID) + " — ytplayer";
  list.innerHTML = "";
  rows = [];
  cues.forEach(function (c, i) {
    var d = document.createElement("div");
    d.className = "row";
    var html = '<span class="t">' + fmtTime(c.start) + "</span>" +
      '<span class="zh"></span><span class="en"></span>';
    if (c.note) html += '<span class="note"></span>';
    d.innerHTML = html;
    d.querySelector(".zh").textContent = c.zh;
    d.querySelector(".en").textContent = c.en;
    if (c.note) d.querySelector(".note").textContent = c.note;
    d.onclick = function () { if (yt && yt.seekTo) { yt.seekTo(c.start, true); yt.playVideo(); } };
    list.appendChild(d);
    rows.push(d);
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

function tick() {
  if (!yt || !yt.getCurrentTime) return;
  var t = yt.getCurrentTime();
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
  if (S.follow) rows[idx].scrollIntoView({ block: "center", behavior: "smooth" });
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
<header><h1>ytplayer — 中英雙語字幕</h1><span class="meta">自用 dogfood・Tier 2 自動翻譯</span></header>
<main><div id="videos"><div class="msg">載入中…</div></div></main>
<script>
fetch("/videos.json").then(function (r) { return r.json(); }).then(function (vids) {
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
