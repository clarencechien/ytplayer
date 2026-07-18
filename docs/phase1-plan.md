# Phase 1 實作計畫（先計劃、經確認後才動手）

> 依據：handoff §3、append-01 §F、phase0-findings §3/§6、probe2 實測（XHR 攔截可行、回應非空）。
> 範圍：**只做 ingest**。ext 攔截字幕 → 送 Worker → 存 R2。不翻譯、不疊字幕。

---

## 1. Repo 結構

```
ext/                  # Chrome Extension（MV3、原生 JS、無框架、無 build step）
  manifest.json
  intercept.js        # MAIN world content script：wrap XHR+fetch，攔 /api/timedtext
  bridge.js           # ISOLATED world content script：收 postMessage、存 captures、答覆 popup
  popup.html
  popup.js            # tier 判定顯示、track 選擇、normalize、POST /ingest
  config.js           # WORKER_URL + INGEST_KEY（自用密鑰，git 內放 example）
worker/               # Cloudflare Worker（TypeScript + wrangler）
  wrangler.toml       # R2 bucket 綁定：SUBS
  src/index.ts        # POST /ingest
  test/               # normalizer/validation 單元測試（vitest）
```

## 2. Ext 設計（估 ~300 行）

### 2.1 攔截（intercept.js，MAIN world，document_start）

- wrap `XMLHttpRequest.prototype.open/send`（probe2 證實播放器走 XHR）與 `window.fetch`（防未來改版）
- 只攔 URL 含 `/api/timedtext` 的**回應**；不改寫、不擋任何請求（防禦性：保持原語意、不吞錯誤，
  已知使用者環境有其他 ext 也在包 XHR，必須共存）
- 攔到後 `window.postMessage({ type: 'ytp-caption', url, body }, origin)` 給 bridge

### 2.2 暫存與狀態（bridge.js，ISOLATED world）

- 從 URL 參數解析 `{ v, lang, kind, tlang, fmt }`，以 `v` 分組、`(lang,kind)` 去重存最新一筆（記憶體即可，popup 開著才用得到）
- `tlang` 非空 → 標記 `translated: true`（紅線 D：這種 capture 一律拒用）
- 回覆 popup 的 `chrome.runtime.onMessage`：回傳 captures 摘要 + 完整 body

### 2.3 Popup 流程（popup.js）

1. 向當前分頁 bridge 要 captures；同時由 bridge **重新 fetch `location.href` 並 parse `ytInitialPlayerResponse`**
   拿 meta / captionTracks（SPA stale 對策，findings §4；global 只當 fallback）
2. 判定 tier（append-01 §B：`vssId` 前綴 + `kind` 交叉驗證）並顯示：
   - Tier 1 → 提示「創作者已有繁中，建議用 YouTube 原生」（仍允許送出，供比對用）
   - Tier 4 → disable 送出
   - captures 為空 → 提示「請先開啟 CC 選原文軌」
   - capture 是 `translated` → 警告「這是自動翻譯軌，請切回原文軌」，不可送
3. 選 track → normalize 成 `cues` → 組 payload → `POST {WORKER_URL}/ingest`（header `x-ingest-key`）→ 顯示成功/失敗

### 2.4 Cue 正規化（popup.js 內，deterministic）

- 依 capture 的實際格式支援兩種：**json3**（`events[].segs[].utf8`，處理 `tOffsetMs`、跳過 `aAppend` 捲動重複列）
  與 **srv3 XML**（`<p t d>` + `<s>`）；以 `phase0b-*.json` fixture 定案細節
- 輸出 `{ start, dur, text }`，秒為單位、text trim、去空 cue、時間軸單調遞增檢查（原則 #1：模型/外部輸入都要清洗）

### 2.5 Payload（handoff §3 + append-01 §F）

```json
{
  "videoId": "...", "tier": 2, "sourceLang": "en",
  "availableTracks": [{ "vssId": ".en", "languageCode": "en", "kind": null, "name": "English" }],
  "meta": { "title": "...", "channel": "...", "description": "前 2000 字", "durationSec": 1234 },
  "track": { "languageCode": "en", "kind": null, "name": "English", "vssId": ".en", "capturedFmt": "json3" },
  "cues": [{ "start": 12.34, "dur": 2.1, "text": "..." }]
}
```

### 2.6 Manifest 權限（最小化，handoff §3 規格）

- `content_scripts`：`*://*.youtube.com/*`（intercept.js 設 `"world": "MAIN"`，Chrome 111+）
- `host_permissions`：僅 youtube.com 與 Worker domain；`permissions`: `activeTab` 皆免——popup 用 `chrome.tabs.query` 需 `tabs`？
  **不用**：`chrome.tabs.sendMessage` 搭配 content script 已注入的分頁不需 `tabs` 權限，只要 `chrome.tabs.query({active,currentWindow})` 拿 id（免權限）
- 無 `webRequest`、無 `<all_urls>`、無自動觸發（全部使用者手動點）

## 3. Worker 設計（src/index.ts，~100 行）

- `POST /ingest`：
  1. 驗 `x-ingest-key`（wrangler secret，403 otherwise）
  2. schema 驗證（deterministic）：videoId `[A-Za-z0-9_-]{11}`；cues 非空、start/dur 為有限數且 start 遞增；
     tier ∈ 1..4；**payload 任何地方出現 `tlang` 即 400**（紅線 D）；body ≤ 5MB
  3. 寫 `R2: subs/{videoId}/source.json`（原封不動存 payload + `ingestedAt`）
  4. 回 `{ ok, key, cueCount }`
- `GET /subs/{videoId}/source.json`：讀回（帶同一 key 驗證）——Phase 2/3 都會用到，先開著方便驗收
- CORS：ext 的 fetch 走 host_permissions 不吃 CORS，Worker 不需開放 `*`

## 4. 開發與驗收步驟

1. **fixture 先行**：等你跑 `__p0report()` 丟回 `phase0b-*.json`（或直接把攔到的 body 存檔給我），
   normalizer + 單元測試以真實資料寫（sandbox 連不上 YouTube，這是唯一的真值來源）
2. 我在 sandbox 完成 ext + worker + 測試（`wrangler dev` 可本機模擬 R2，測 /ingest 全流程）
3. 你這邊：`wrangler deploy` + 建 R2 bucket + 設 secret（我會寫好一步步的 `worker/README.md`）、
   Chrome load unpacked `ext/`
4. 驗收（handoff §3）：三支不同影片 ingest 成功、R2 出現三個 source.json、
   抽查 5 句 cue 與播放器顯示一致、**SPA 切換影片後再抓抓到的是新影片**（popup 顯示的 videoId 必須等於網址列）

## 5. 已知風險與對策

| 風險 | 對策 |
|---|---|
| 使用者開的 CC 是自動翻譯軌（`tlang`） | bridge 標記 + popup 拒送 + Worker 再驗一層 |
| 多 ext 同時 wrap XHR 打架 | 只讀不改、不吞例外；壞掉時 YouTube 原生功能不受影響 |
| 播放器改用 fetch 或 UMP 傳字幕 | fetch 也 wrap；若兩者都攔不到，popup 顯示「攔不到，請回報」而非壞掉 |
| capture 的 videoId ≠ 網址列 videoId（SPA 殘留） | popup 以網址列 `v` 為準過濾 captures |
| 手動開關 CC 這步驟麻煩 | 接受。這是 POC；自動化（如自動點 CC）留 Phase 4 再議 |

## 6. 決策（已定案）

1. Worker 名稱：**`ytplayer`**；R2 bucket：`ytplayer-subs`
2. 部署方式：**Cloudflare Workers Builds（GitHub 連結，push 即部署）**，步驟見 `worker/README.md`；
   deploy command `npm run deploy:ci` 會 best-effort 建 bucket
3. ext 不對 Worker 開 host_permission — 改由 Worker 回 CORS 標頭（安全性由 `INGEST_KEY` 把關），
   權限縮到只剩 youtube.com；Phase 3 player 頁讀 GET 端點也直接受益
4. normalizer 只支援 json3（phase0b 確認播放器固定 `fmt=json3`），fixture 進了單元測試
