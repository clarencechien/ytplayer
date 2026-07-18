# Phase 0 Findings：可行性驗證

> 狀態：**核心決策問題已全部有答案**（2026-07-18，三支影片實測，資料在 `phase0/out/`）。
> 剩一項執行面驗證（probe2：攔截路徑），不影響架構結論，影響 Phase 1 的實作細節。

---

## 0. 結論摘要（決策用）

| 問題 | 答案 | 證據 |
|---|---|---|
| CF Worker / server 端能抓字幕嗎？ | **不能** | §1：datacenter IP 全路徑被 bot-check 擋死 |
| Player 頁能在瀏覽器端自己抓 CC 嗎？ | **不能** | §3：timedtext 無 CORS 標頭；且連 same-origin 都拿不到 body（POT） |
| ext 是唯一 ingest 路徑嗎？ | **是** | 上兩列的交集 |
| ext 可以「拿 baseUrl 直接 fetch」嗎？ | **不行**（新發現） | §3：頁內帶 cookie fetch 一律 `200` + **0 bytes** → Phase 1 改為攔截播放器自己的請求 |
| `ytInitialPlayerResponse` global 在 SPA 導航後可信嗎？ | **不可信** | §4：實測 global 停留在上一支影片；HTML 重抓 + parse 三支全部成功 |
| vssId 分層規則（`a.` = ASR、`.` = 人工）成立嗎？ | **成立** | §2：三支影片與 `kind` 欄位交叉驗證一致 |

**對 handoff 的影響**：架構四格圖不變（ext → Worker → R2 → Player），但 Phase 1 的 ext 從「讀 baseUrl 自己 fetch」改為「**內容腳本攔截播放器發出的 timedtext 回應**」。詳見 §6。

---

## 1. Server 端（datacenter IP）抓不到字幕 ✅ 已驗證

雲端 sandbox（datacenter egress IP）實測，「Cloudflare IP 被封」的假設成立且比預期更全面：

| 路徑 | 結果（2026-07-18） |
|---|---|
| `GET /watch?v=...` | `429` 或 `302 → google.com/sorry`（CAPTCHA） |
| Innertube `WEB` / `TVHTML5` / `MWEB` | `200` 但 `playabilityStatus = LOGIN_REQUIRED`："Sign in to confirm you're not a bot"，無 captionTracks |
| Innertube `ANDROID` | `400 FAILED_PRECONDITION` |

→ Phase 4 的「住宅 IP fetch node」若要做，必須跑在家用網路。

## 2. 三支實測影片：正好各佔一個 Tier ✅

（Tier 定義見 [handoff-append-01](handoff-append-01.md)；判別用 `vssId` 前綴 + `kind` 交叉驗證，兩者一致）

| videoId | 影片 | tracks | Tier | 說明 |
|---|---|---|---|---|
| `5OLs1GWB4OA` | MrBeast "I Built 10 Schools…" | 25（24 條人工多語系 **含 `.zh-Hant`** + `a.en`） | **1** | 創作者已有繁中 → 不進 pipeline，提示用原生 |
| `ksfm6jeTg3Q` | Claude "Building the future of agentic infrastructure" | `.en` + `a.en` | **2** | 官方英文 CC → POC 主路徑 |
| `-a0ecQMq-rM` | SpaceX "Starship - Critical Path" | 僅 `a.en` | **3** | ASR only → ingest 後標記，Phase 2.5 再處理 |

其他觀察：
- 三支的 `translationLanguages` 都是 **156** 種（自動翻譯目標語清單；依紅線規則 D 永不作為輸入，程式碼看到 `tlang` 即 bug）
- SpaceX 的 ASR 軌 baseUrl 多了 **`variant=gemini`** 參數 — YouTube 的 ASR 已有 Gemini 版本；轉寫品質假設值得在 Phase 2.5 前重新抽查（可能比舊 ASR 乾淨）
- `baseUrl` 參數集：`v, ei, caps, opi, exp, xoaf, xowf, xospf, hl, ip, ipbits, expire, sparams, signature, key, lang`（ASR 軌多 `kind`、`variant`）
- `expire` 實測約 **7 小時**（probe 07:27 UTC，expire 14:27 UTC）；`ip=0.0.0.0` 且 `sparams` 含 ip → 簽名未綁定單一 IP

## 3. 重大新發現：timedtext 有 POT 防護，baseUrl 直接 fetch 已死 ⚠️

**三支影片、28 條軌，全部**：在 youtube.com 頁面內、帶 cookie 對 `baseUrl&fmt=json3` fetch →
`HTTP 200`、`Content-Length 0`（空 body）。

- 這與 2024 年底起 YouTube 對 timedtext 加上 **POT（proof-of-origin token）** 的公開觀察一致：實際播放器發出的字幕請求帶有 BotGuard 產生的 `pot=` 參數，缺了它伺服器回空 200
- **CORS**：所有回應 `Access-Control-Allow-Origin: null`（無此標頭）→ 就算沒有 POT，非 youtube.com origin 的 fetch 也會被 CORS 擋。「player 頁自己抓軌、取消 ext」這條路**雙重確定不通**
- 影響：ext 不能自己組 URL 抓字幕，要**攔截播放器自己發的請求**（其 URL 含有效 pot、回應含完整 cue）。此路徑由 `phase0/devtools-probe2-intercept.js` 驗證（見 §6）

## 4. SPA 導航 stale 問題 ✅ 已實證

`ksfm6jeTg3Q` 是站內點擊導航進入的，此時 `window.ytInitialPlayerResponse.videoDetails.videoId` 還停留在**上一支影片**（`255IGB63nTY`）；另兩支（直接載入）則一致。
HTML 重抓 + balanced-brace parse 在三支上全部成功且 videoId 正確。

→ **Phase 1 規則：track 清單與 meta 一律「重新 fetch `location.href` 再 parse」**，不信 global。global 只能當 fallback。

## 5. 未完成項目與去向

**probe2 實測（2026-07-18，`-a0ecQMq-rM`）：攔截路徑確認可行 ✅**

- 播放器發字幕請求用的是 **XHR**（不是 fetch）→ ext 兩者都要 wrap，但 XHR 是主要路徑
- 攔到的回應**非空**：365,999 與 374,694 bytes（34 分鐘 ASR 軌，開 CC 後觸發兩次請求）
  — 與 baseUrl 直接 fetch 的 `200 + 0 bytes` 形成對照，證實 POT 防護下「攔截」是唯一且足夠的路徑
- 使用者環境同時有其他也在 wrap XHR/fetch 的擴充功能（廣告攔截器、`fix-yt-traditional-chinese-subtitle` 等）
  → ext 的攔截要防禦性實作：保持原方法語意、不吞錯誤、容忍多層包裝共存

**phase0b 完整報告（`phase0/out/phase0b--a0ecQMq-rM.json`）確認：**

- 播放器請求確實帶 **`pot`**（+`potc=1`）與完整 client 識別（`c=WEB`、`cver`、`cbrand/cbr/cbrver`、`cplatform` 等）
- **`fmt=json3`** 是播放器預設格式 → normalizer 只需支援 json3
- **原樣重放可行**：同 session 內 fetch 攔到的 URL → `200`、非空、合法 json3（但 ext 設計上直接存回應 body，不依賴重放）
- json3 結構：無 `segs` 的事件 = 視窗定義；`aAppend===1` = roll-up 捲動列（跳過）；其餘每事件一列，`segs[].utf8` 逐詞串接
- **Gemini 版 ASR（`variant=gemini`）有標點、大小寫、`[music]` 標記**（"When you're dealing… launchpad,"）
  → append-01 §C「英文 ASR 需補標點」的前提已部分過時，Phase 2.5 範圍可能縮小
- **tlang 在真實使用中確實出現**：使用者當時開著「自動翻譯→中文（繁體）」，前兩筆 capture 都是 `tlang=zh-Hant`
  → ext 的 tlang 過濾是必要防線，不是理論防禦
- 附帶觀察：同一 URL 的自動翻譯結果**不穩定**（capture 1379 events / 重放 931 events，字詞也不同）— 再次支持紅線 D

| 項目 | 狀態 | 去向 |
|---|---|---|
| ASR vs manual 內容差異實例 | 部分取得（Gemini ASR 品質觀察如上） | 完整比較：在 Tier 2 影片上開關兩條軌各攔一次 |

## 6. Phase 1 設計修正（由本次結果導出）

1. ext 內容腳本以 **MAIN world** 注入，wrap `window.fetch` + `XMLHttpRequest`，攔截 `/api/timedtext` 回應
2. 使用流程改為：開影片 → **開 CC 選原文軌** → ext 攔到 cue 資料 → 點 ext icon → popup 顯示 tier / track → 送出
3. popup 顯示 Tier 判定：Tier 1 提示用原生繁中、Tier 4 disable 送出（依 append #01）
4. payload 增加 `tier` / `sourceLang` / `availableTracks`（依 append #01 §F）
5. 若攔到的 URL 含 `tlang` → 使用者開到自動翻譯軌，**拒收並提示切回原文軌**（紅線規則 D 的落實點）
6. 行數預算：攔截邏輯會讓 ext 超出原估的 250 行一些（估 ~300）；超出來源明確，可接受

---

## 附錄：探測工具

| 檔案 | 用途 |
|---|---|
| `phase0/devtools-probe.js` | 貼進影片頁 Console：track 清單、tier 原始資料、SPA stale 偵測（baseUrl fetch 部分已被 POT 廢掉，保留作為證據產生器） |
| `phase0/devtools-probe2-intercept.js` | **下一步**。驗證攔截路徑 + 取得 json3 實例 |
| `phase0/probe-server.mjs` | server 端探測（§1 證據來源） |
| `phase0/probe.mjs` | Playwright 版（sandbox 內因 proxy TLS 限制不可用） |
