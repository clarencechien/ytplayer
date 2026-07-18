# Handoff 增補 #01：影片分層與範圍收斂

> 接續 `handoff-bilingual-subtitle-poc.md`。
> **本文件只包含新增／修正的內容，原文件其餘部分仍然有效。**
> 有衝突處，**以本文件為準**。

---

## A. 對原文件的修正

原文件把「有 CC」當成單一集合處理，只區分 manual / ASR。**這個二分法不夠。**

實際上 caption track 有四個層級，每一層是不同的題目，需要不同的處理路線與成本結構。原文件 §4 的翻譯 pipeline 預設所有輸入都適用同一條路——**這是錯的**。

---

## B. 影片分層（新增核心概念）

| Tier | 名稱 | 判別 | 輸入品質 | 處理路線 |
|---|---|---|---|---|
| **1** | 創作者自製多語言 | 存在非 ASR 的目標語言（zh-TW / zh-Hant）軌 | 人工在地化，高 | **完全不處理**，提示使用者直接用 YouTube 原生 |
| **2** | 創作者自製原文 CC | 非 ASR 軌，僅原文語言 | 有標點、大小寫、斷句正確 | **純翻譯**（POC 範圍） |
| **3** | 自動生成 CC | `kind === "asr"` | 無標點、全小寫、專有名詞錯 | 需先修稿再翻譯（Phase 2.5） |
| **4** | 無任何 CC | `captionTracks` 為空 | — | **永不處理**，直接報錯 |

### 判別方式

`captionTracks` 中：
- ASR 軌的 `vssId` 以 `a.` 開頭（例：`a.en`）
- 人工軌的 `vssId` 以 `.` 開頭（例：`.en`）
- 亦可用 `kind === "asr"` 交叉驗證，兩者都檢查

分層在取得 track 清單的同時即可完成，零額外成本。

---

## C. 語言軸（Tier 3 不是單一格，是矩陣）

Tier 3 的可用性**高度依賴原文語言**：

| 原文語言 | ASR 品質 | 結論 |
|---|---|---|
| 英文 | 良好，WER 個位數 | 補標點即可用，仍是純文字問題 |
| 日文 / 韓文 | 明顯較差，同音字、漢字轉換、人名易錯 | **轉寫本身不可信**，修稿等於在修錯的文字，翻出來錯上加錯 |

### 由此得到的成本邊界（重要）

前述「不要用 LLM 直接看影片」的建議，**邊界應修正為**：

> LLM 看影片這條昂貴路線，**只在「Tier 3 + 非英文」這一格划算**。
> 因為該格錯的是「聽寫」而非「翻譯」，有可信原文時使用它純屬浪費。

這也解釋了姊妹專案 kvsplayer（韓綜）為何必須走 Gemini 看片路線——它落在矩陣最右下角。**本專案不在那一格，不要複製該架構。**

---

## D. 硬性規則（新增，紅線）

### 🚫 永遠不要使用 YouTube 的自動翻譯軌作為輸入

`timedtext` 加上 `tlang` 參數可直接取得中文軌，看似省事，但：

- 那是機器翻譯的產物
- 拿它再翻一次 = 翻譯一個譯本，錯誤疊加
- 你將永遠無法得知原文實際說了什麼

**一律從原文語言軌翻譯。** 若程式碼中出現 `tlang` 參數，視為 bug。

---

## E. POC 範圍收斂（修改原文件 §4 驗收條件）

**POC 只處理 Tier 2。**

理由是隔離變數：Tier 2 的輸入是完美的（人工原文、有標點），唯一的變數就是「本專案的翻譯 vs YouTube 的自動翻譯」。

> 若在最有利的條件下都贏不過 YouTube 自動翻譯，
> 加上 ASR 修稿只會更輸。**先在乾淨輸入上證明品質，再往下擴。**

### 各 Tier 在 POC 階段的行為

- **Tier 1** → 偵測後提示「這支影片創作者已提供中文字幕，建議直接使用 YouTube 原生軌」，不進 pipeline
- **Tier 2** → 正常處理（POC 唯一路徑）
- **Tier 3** → 接受 ingest 並標記，但**先不翻譯**（留待 Phase 2.5）
- **Tier 4** → 直接報錯

---

## F. 對各 Phase 的具體修改

### Phase 1（ext）

payload 新增欄位：

```json
{
  "videoId": "...",
  "tier": 2,
  "sourceLang": "en",
  "availableTracks": [
    { "vssId": ".en", "languageCode": "en", "kind": null, "name": "English" },
    { "vssId": "a.en", "languageCode": "en", "kind": "asr", "name": "English (auto-generated)" }
  ],
  "meta": { "...": "..." },
  "track": { "...": "..." },
  "cues": [ "..." ]
}
```

- `availableTracks` 要記錄**完整清單**，不只選中的那條。之後分析各 tier 分佈時會用到
- ext 的 popup 應顯示偵測到的 tier，Tier 1 時給出提示、Tier 4 時 disable 送出按鈕

### Phase 2（翻譯 pipeline）

- 明確限定只處理 `tier === 2`
- 原文件 §4.1 中「若 `kind === "asr"` 先做 normalize」的分支**移出**，改列入 Phase 2.5

### Phase 2.5（新增階段，Phase 3 之後才做）

ASR 修稿 pipeline，**僅限英文來源**：

1. 補標點、還原大小寫
2. 用 glossary 修正專有名詞拼寫
3. 重新斷句
4. 輸出一條**比 YouTube 原生更乾淨的英文軌**（這本身就是雙語播放器的賣點——使用者對照的英文那行品質也提升了）
5. 再進入既有的 Phase 2 翻譯流程

非英文 ASR **不在本專案範圍內**。

### Phase 4（選作項目新增）

- 統計自己觀看清單中各 tier 的實際分佈。這個數字會直接決定 Phase 2.5 值不值得做——若九成影片都是 Tier 2，ASR 修稿就是白工

---

## G. Phase 0 實測結果（2026-07-18 回填，詳見 phase0-findings.md）

1. **CORS：擋。** timedtext 回應無 `Access-Control-Allow-Origin` 標頭 → ext **不能取消**。
   而且發現更嚴重的：timedtext 有 POT 防護，`baseUrl` 直接 fetch 即使在 youtube.com
   頁內帶 cookie 也回 `200 + 空 body`（三支影片 28 條軌全中）→ ext 也不能自己組 URL 抓，
   Phase 1 改為「MAIN world 攔截播放器自己發出的 timedtext 請求」（見 findings §6）。
2. **Tier 判定**：`5OLs1GWB4OA`（MrBeast，含 `.zh-Hant`）= Tier 1；
   `ksfm6jeTg3Q`（Claude 頻道，`.en` + `a.en`）= Tier 2；
   `-a0ecQMq-rM`（SpaceX，僅 `a.en`）= Tier 3。三支正好各佔一層。
3. **vssId 前綴規則相符**：`a.en` = ASR、`.en` = 人工，與 `kind === "asr"` 交叉驗證一致。
   另外 SpaceX 的 ASR 軌帶 `variant=gemini` — YouTube 的 ASR 已有 Gemini 版，
   §C 對英文 ASR 品質的假設在 Phase 2.5 前值得重新抽查（可能更乾淨）。
