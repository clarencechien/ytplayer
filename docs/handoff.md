# Handoff：YouTube 中英雙語字幕 POC

> 給 Claude Code 接手的分階段任務書。
> **請依 Phase 順序執行，每個 Phase 有獨立驗收條件，未通過不要往下做。**

---

## 0. 專案目的（先讀這段，它決定所有取捨）

這是一個**自用**工具（dogfooding），不是要上架的產品。

**核心動機**：市面上的雙語字幕擴充功能（沉浸式翻譯、Trancy 等）幾乎都是中國團隊做的，譯文會出現「視頻／質量／信息／網絡／屏幕」這類用詞，讀起來卡。我要的是**道地的台灣正體中文**，而且翻譯品質要高於 YouTube 內建自動翻譯。

**達成品質的手段**（這是本專案唯一的技術賣點，不要簡化掉）：
1. 不逐句翻 — 翻譯前先把 cue 重組成語意完整的句子
2. 引入影片 meta（標題、頻道、簡介）當作翻譯背景
3. 先跑一次 glossary pass 抽出專有名詞，注入後續每個 chunk，確保全片術語一致
4. 允許加譯註（雙關、文化梗、縮寫展開）

**最終形態**：一個網頁，上面是 YouTube iframe player，下面／上面疊自己的中英對照字幕。

---

## 1. 架構決策（已定案，不要重新設計）

```
[自用 Chrome ext]  →  [CF Worker]  →  [R2]  →  [Player 頁]
   抓 caption track    翻譯 pipeline   存字幕    iframe + 自製字幕層
```

### 為什麼是這個形狀 — 決策脈絡

| 決策 | 結論 | 理由 |
|---|---|---|
| ext vs server 抓字幕 | **ext** | Cloudflare IP 被 YouTube 封鎖，server 端抓不到。ext 跑在 youtube.com 頁面內，用使用者自己的 IP／cookie，天然繞過 |
| ext 要不要上架 | **不上架** | load unpacked 自用即可。不上架 = 沒有 Chrome 審查、沒有隱私權政策、沒有權限審核 |
| ext 要不要做字幕疊加 | **不要** | ext 只做 ingest 一件事。字幕疊加交給自己的 player 頁，避開 SPA 導航／全螢幕／劇院模式／廣告狀態這些無底洞 |
| player vs 直接改 YouTube 頁面 | **自己的 player 頁** | iframe Player API 是官方合約，有文件、不會因改版而破。自己頁面的 DOM 完全可控。維護稅趨近於零 |
| 用 CC 軌 vs 用 LLM 看影片 | **CC 軌** | 看影片貴 30–50 倍、慢、且輸出是機率性的（時間軸會漂、會幻覺）。CC 軌是免費且確定的 ground truth |

### 明確的 Non-goals（不要做）

- ❌ 不要下載 YouTube 影片（法遵風險 + 頻寬成本 + 完全沒必要）
- ❌ 不要做 ASR / Whisper（前提就是「有 CC」）
- ❌ 不要用 LLM 直接看影片
- ❌ 不要在 ext 裡疊字幕
- ❌ 不要處理沒有任何 caption track 的影片（直接報錯即可）
- ❌ 不要做使用者系統、登入、多租戶

---

## 2. Phase 0：可行性驗證（先做這個，30 分鐘）

**在寫任何正式程式碼之前**，必須先驗證兩件事。這兩題的答案會影響 Phase 1 的實作方式。

### 任務

1. 在 YouTube 影片頁的 DevTools Console 手動執行，確認能取得 caption track 清單：
   - 嘗試從 `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks` 讀取
   - 若該全域變數不存在，改從頁面 HTML 中 parse（YouTube 常改，兩種都試）
   - 記錄每個 track 的 `baseUrl`、`languageCode`、`kind`（`asr` 代表自動字幕）、`name`

2. **驗證 CORS**：從**非 youtube.com 的頁面**（例如 `about:blank` 或本機 localhost）對某個 `baseUrl` 發 `fetch()`，看是否被 CORS 擋。

### 驗收條件

產出一份 `docs/phase0-findings.md`，包含：
- 至少 3 支影片（一支有官方英文字幕、一支只有 ASR、一支多語系）的 caption track 結構實例
- `baseUrl` 加上 `&fmt=json3` 的回傳格式範例
- CORS 測試結果（**這題的答案要明確寫下來**）
- ASR 軌與 manual 軌的內容差異實例（標點、大小寫、斷句）

### 為什麼重要

若 CORS 是通的，未來 player 頁可以直接在瀏覽器端抓軌，ext 甚至可以不用存在。若被擋，就確認 ext 是唯一路徑。

---

## 3. Phase 1：自用 Chrome Extension（Ingest）

**範圍極小。這個 ext 只做一件事：把 caption track 送到 Worker。**

預期程式碼量 < 250 行。若寫超過，代表範圍跑掉了。

### 規格

- **Manifest V3**
- `host_permissions`：只要 `*://*.youtube.com/*` 和自己的 Worker domain。**不要 `<all_urls>`、不要 `tabs`、不要 `webRequest`**
- UI：只有一顆按鈕。點 ext icon → popup 顯示當前影片的 track 清單 → 選一個 → 送出 → 顯示成功／失敗
- **不要自動觸發**。使用者手動點才動作

### 要送給 Worker 的 payload

```json
{
  "videoId": "dQw4w9WgXcQ",
  "meta": {
    "title": "影片標題",
    "channel": "頻道名稱",
    "description": "簡介前 2000 字",
    "durationSec": 1234
  },
  "track": {
    "languageCode": "en",
    "kind": "asr",
    "name": "English (auto-generated)"
  },
  "cues": [
    { "start": 12.34, "dur": 2.10, "text": "原始英文文字" }
  ]
}
```

**注意**：ext 負責把 YouTube 的原始格式（json3 或 XML）正規化成上面的 `cues` 陣列再送出。Worker 不該知道 YouTube 的格式細節。

### Worker 端點

`POST /ingest` — 收下、驗證、原封不動存進 R2：

```
r2://subs/{videoId}/source.json
```

**Phase 1 到此為止。先不要翻譯。**

### 驗收條件

- 在三支不同影片上點擊 ext，R2 裡出現三個 `source.json`
- `cues` 內容與 YouTube 播放器實際顯示的字幕一致（抽查 5 句）
- ext 在影片切換後（SPA 導航）再點一次，抓到的是**新影片**而非舊的

---

## 4. Phase 2：翻譯 Pipeline（本專案的核心價值）

這是唯一值得花時間打磨的地方。

### 4.1 Step A — 正規化與重新斷句

**這一步是品質的分水嶺。YouTube 自動翻譯之所以爛，就是因為逐 cue 翻。**

- 依標點與時間間隔，把多個 cue 合併成語意完整的**句子**
- 保留 `cue → sentence` 的 index 對應（翻完要映射回時間軸）
- 若 `kind === "asr"`：先做一次 normalize（補標點、還原大小寫、修正明顯的拼寫錯誤）

輸出結構：

```json
{
  "sentences": [
    { "id": 0, "text": "完整的一句英文。", "cueIds": [3, 4, 5] }
  ]
}
```

### 4.2 Step B — Glossary Pass

用一次便宜的呼叫，掃過全片英文，抽出：
- 人名、公司名、產品名
- 領域術語（技術／財經／半導體）
- 縮寫及其展開

輸出 `{ term, suggested_zh, note }`，存成 `r2://subs/{videoId}/glossary.json`。

**這份 glossary 要注入後續每一個 chunk 的 prompt。** 這是全片術語一致的唯一手段。

### 4.3 Step C — 分塊翻譯

- 每個 chunk 約 30–50 句
- 前後各帶 1–2 句 overlap 當上下文（overlap 部分翻譯後丟棄，只取中間）
- 每個 chunk 的 prompt 都注入：影片 meta + glossary + overlap
- 平行送出（並發 6–10）

### 4.4 翻譯 Prompt 要求（重要）

Prompt 必須明確要求：

**語言規範**
- 台灣正體中文，台灣慣用詞彙與語感
- 明確禁止中國用語。至少列出對照表：
  `視頻→影片`、`質量→品質`、`信息→資訊`、`網絡→網路`、`軟件→軟體`、`硬件→硬體`、`屏幕→螢幕`、`數據→資料`、`用戶→使用者`、`默認→預設`、`激活→啟用`、`調用→呼叫`、`打印→列印`、`內存→記憶體`、`優化→最佳化`、`菜單→選單`、`視頻博主→YouTuber`
- 避免翻譯腔（不要「令人印象深刻的」、「這是一個⋯⋯的過程」這類直譯句式）
- 專有名詞、技術縮寫**保留英文原文**，不要硬翻

**譯註機制**
- 遇到雙關、文化梗、需要背景知識的縮寫，可在該句加 `note` 欄位
- note 要簡短（20 字內），player 端會以小字顯示

**輸出格式**（要求純 JSON，無 markdown 圍欄、無前言）

```json
[
  { "id": 0, "zh": "中文翻譯", "note": "選填的譯註" }
]
```

### 4.5 輸出檔

`r2://subs/{videoId}/bilingual.json`：

```json
{
  "videoId": "...",
  "meta": { "...": "..." },
  "promptVersion": "v1",
  "cues": [
    {
      "start": 12.34,
      "end": 14.44,
      "en": "原始英文",
      "zh": "中文翻譯",
      "note": "選填"
    }
  ]
}
```

同時輸出一份 `bilingual.srt`（中英上下兩行）方便丟進桌面播放器測試。

### Cache key

`(videoId, trackLanguageCode, model, promptVersion)`。改 prompt 就換 `promptVersion`，避免吃到舊譯文。

### 驗收條件

**這是整個專案最重要的驗收點。**

- 挑三支你真的想看的影片（建議：一支技術演講、一支財經訪談、一支半導體／製造相關）
- 把譯文跟 YouTube 內建自動翻譯**並排比對**
- 明確回答：**好到值得自己維護一套系統嗎？**
- 檢查全片術語是否一致（同一個詞不該前後翻成兩種）
- 用禁用詞表掃過全文，應為零命中

若這關沒過，**停下來調 prompt，不要往 Phase 3 走**。Player 只是包裝，翻譯才是產品。

---

## 5. Phase 3：Player 頁

### 規格

- 單一頁面，路由 `/watch/{videoId}`
- **YouTube IFrame Player API**（官方 API，不要嘗試操作 iframe 內部 DOM）
- 用 `getCurrentTime()` 輪詢（約 100–200ms）驅動字幕高亮
- 字幕層是**自己頁面的 DOM**，完全可控

### 版面

- 影片上方或下方顯示當前字幕：**英文一行、中文一行**
- 有 `note` 時以小字顯示在旁邊
- 側邊或下方是**完整字幕捲軸列表**，當前句高亮並自動捲動
- 點擊任一句 → `seekTo()` 跳到該時間點（這個功能實際用起來非常有價值，不要省略）

### 設定項（存 localStorage 即可）

- 只顯示中文 / 只顯示英文 / 雙語
- 字級大小
- 是否顯示譯註

### 驗收條件

- 完整看完一支 20 分鐘影片，字幕同步無明顯漂移
- 點擊字幕能正確跳轉
- 拖動進度條後字幕能正確跟上

---

## 6. Phase 4（選作）：品質迭代

只在 Phase 2 驗收通過、且你實際天天在用之後才做：

- **Per-channel glossary 累積**：同一頻道的術語跨影片沿用
- **校對 UI**：在 player 頁直接修改譯文，寫回 R2
- **住宅 IP fetch node**：家中常開的機器跑 `yt-dlp` 抓字幕，讓 ingest 不再需要人手動點 ext
- **從畫面抽 glossary**：技術演講的投影片上通常直接寫著術語，用 LLM 低頻率取樣畫面補充 glossary。這是純文字路線拿不到的資訊，也是現有工具都做不到的

---

## 7. 技術棧

- Cloudflare Worker（TypeScript）+ R2 + Queues
- 翻譯模型：Gemini Flash 系列（成本考量）
- Chrome Extension Manifest V3，原生 JS，不需要框架
- Player 頁：單一 HTML 檔或極簡框架皆可

## 8. 成本預期

20 分鐘影片約 3,500 字 ≈ 5k tokens。加上 glossary pass、overlap、翻譯，全部約 15–20k tokens。用 Flash 級模型，單支成本趨近於零。

**若實際帳單遠高於此，代表某處在重複呼叫或重試失控，停下來檢查。**

---

## 9. 開發原則

1. **模型輸出視為敵意輸入**。JSON 解析失敗、id 對不上、句數不符、時間軸異常 — 全部要有 deterministic 的清洗與檢查，不要相信 prompt 能保證格式
2. **Prompt 管品質天花板，程式碼管品質地板**
3. 每個 Phase 都要能獨立停下來。這是自用工具，隨時可能因為「其實現成的就夠好」而中止
4. 遇到需要逆向 YouTube 內部結構的地方 — **先停下來問**，不要猜
