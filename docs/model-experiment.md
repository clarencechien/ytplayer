# 模型對決：同片四組實測（2026-08-13）

> 起因：帳單事故追查（見 [asr-language-experiment.md](asr-language-experiment.md) §4.2 與 README 保險絲）。
> AI Studio 用量圖顯示 Output tokens 是 Input 的 3–4 倍 — 全是 thinking（以輸出價計費）。
> 樣本：`9gHJwbSHPus`（日文 ASR 686 cues，有創作者人工中文軌當標準答案）。
> 方法：本機 runner（`worker/scripts/ab-runner.ts`）跑完整 text pipeline，不碰 production。

## 事前的 API 隔離測試（費用歸因的鐵證）

| 探測 | 結果 |
|---|---|
| `gemini-3.6-flash` 無設定（小 prompt）| 187 tokens 中 **173 是 thinking** — 預設思考極兇 |
| `gemini-3.6-flash` + `thinkingBudget: 0` | **400 拒收** |
| `gemini-3.6-flash` + `thinkingBudget: 128` | 接受，實際 thoughts=0（= 實質關閉，兩模型通吃的設法）|
| `gemini-3.5-flash` + `thinkingBudget: 0` | 接受，thoughts=0 |
| `gemini-3.6-flash-lite` | **404 不存在**（lite 家族現役為 `gemini-3.5-flash-lite`）|

## 四組結果

| | C：3.5-flash<br>思考開（事故時代）| **D：3.5-flash<br>思考關（勝者）** | A：3.6-flash<br>思考關 | B：3.5-flash-lite<br>思考關 |
|---|---|---|---|---|
| tokens | 273,617 | **188,824（-31%）** | 223,471 | 187,654 |
| 輸出佔比 | 帳單圖 3–4 倍於輸入 | **33%**（思考殘量 6.9k）| 33% | 33% |
| 缺句（untranslated）| 0 | **0** | 3 | **27** ❌ |
| warnings | 1（優化）| 1（優化）| 7 | 3 |
| 修稿：Zold 殘留 / Fold 正確 | 0 / 15 | 2 / 9 | 0 / 13 | 0 / 14 |
| 自發譯註數 | 21 | 6 | 5 | 17 |
| 抽樣 vs 人工軌 | 穩、貼 | **穩、貼（與 C 同級）** | **多處譯文對錯句** ❌ | 過的句子貼，但缺句顯原文 |

### 關鍵質化發現

1. **A（3.6-flash 關思考）有「譯文對錯句」**：多個抽樣點（1:30、5:00、8:30）顯示的中文是**別的時間點的內容**
   — 模型在 40 句 batch 內 id 對滑。量化指標抓不到（句子本身合理），比缺句危險 → **禁用**
2. **B（lite）缺 27 句**、一處同句重複 — 錯得可見（顯示原文），但當預設不合格
3. **D 的小代價**：修稿殘留 2 個 `Zold`（顯示在原文行可見）、自發譯註 21→6
   （deterministic 的 glossary 譯註不受影響）。換 -31% tokens 且輸出價份額大減 — 值得

## 決策

- **預設**：`gemini-3.5-flash` + `GEMINI_THINKING_BUDGET` 預設 128（實質關閉，跨模型通吃）
- 單輪覆寫隨時可用：`POST /translate/{id}?force=1&model=…`（A/B 擂台常設）
- 3.6-flash 若要複用需先解 id 錯位（例如縮小 chunk、或加 id 連號檢查）— 記為 future work
- 帳單校準：等 Google 帳單出來後把儀表板 `COST_NTD_PER_M` 調成真實費率

## 追加：E 組 — lite + 縮 chunk 20（2026-08-14，假說否決）

「lite 缺句是 40 句大 batch 的協定問題」的驗證結果：**否**。

| | B：lite + chunk 40 | E：lite + chunk 20（+ id 連號檢查上線後）|
|---|---|---|
| untranslated | 27 | **30（更糟）** |
| 失敗形狀 | 缺句零星 | **整 chunk 歸零**（連切半分治都救不回）|
| tokens | 187,654 | 212,994（chunk 變小 → overlap/prompt 攤提變多）|

判讀：id 連號檢查上線後，lite 的輸出頻繁因**重複/亂序 id** 被整包打回 — 病根是
index-keyed 協定對 lite 的 id 紀律要求太高，縮 chunk 無解。lite 要再戰需要**換協定**
（如按位置對齊的純陣列輸出），記為 future idea，不再投入。**預設維持 3.5-flash + 關思考。**

## 追加：F 組 — 回聲對位協定 v4 vs v5（2026-08-16）

換的不是模型而是**協定**（翻譯輸出加 `t` = 原文前 12 字元的回聲欄位），
所以照 [model-reeval-sop.md](model-reeval-sop.md) 的五步跑：先量自然變異再比。

樣本 `hK9fypJKHyY`（英 ASR 274 句）／基準 3 次、候選 6 次：

| | v4（只靠 id）| v5（回聲對位）|
|---|---|---|
| untranslated | 0 / 0 / 0 | 0（6 次全 0）|
| driftSuspect | mean 2.33（2–3）| mean 3.33（1–6）→ **無改善，落在雜訊裡** |
| tokens | mean 43.8k（39.5–51.0k）| mean 49.8k（45.9–53.4k）→ **+14%** |
| 成本 | mean NT$5.40 | mean NT$6.25 |
| echoRejects | —（無此協定）| 82 / 7 / 11（mean 33）|

**質化（決定性的那一項）**：抽一個 40 句 chunk 逐句比對模型回的 `t`，
抓到連續三句整段位移一格（模型回給 #36 的 `t` 是 #35 的尾巴，#37 的是 #36…）。
沒有回聲欄位的話這三句會被靜靜收下 —— 這正是 A 組（3.6-flash）當初被抓到的同一種錯，
只是 3.5-flash 發生得比較零星。**自動指標永遠測不到它，人工抽樣才會。**

日文樣本 `9gHJwbSHPus` 攔截率高得多（127/679 = 19%，4 句最終未譯）——
日文 ASR 常在子句中間斷 cue，模型更容易翻到隔壁碎片。取捨與旋鈕見
[future-ideas.md](future-ideas.md) F1。

判讀：**協定改動不會讓漂移指標變好，但會把「安靜地錯」變成「看得見地重譯」**。
下次重評 3.6-flash 時，`echoRejects` 就是它對滑本性有沒有改的直接證據。

## 外部資料驗證（2026-08-13 網路查證）

| 模型 | 輸入 $/M | 輸出 $/M（thinking 計此價）| 對照我們的實驗 |
|---|---|---|---|
| gemini-3.5-flash | $1.50 | **$9.00** | C 組貴的主因：thinking 全計輸出價 |
| gemini-3.6-flash | $1.50 | $7.50（且輸出平均少 17%）| 單價其實比 3.5 便宜 — 但 A 組「譯文對錯句」品質失格，價差救不了 |
| gemini-3.5-flash-lite | $0.30 | $2.50 | 6 倍價差屬實 — B 組缺句問題若能解（縮小 chunk？）值得再戰 |

外部一致確認：**thinking token 以輸出價計費**、中度推理約 3 倍輸出量、重度 6–8 倍 —
與我們帳單圖的「Output = Input 的 3–4 倍」完全吻合。
另外業界常見建議是「任務路由」：翻譯/分類/字幕用 lite 級、agent/coding 用 flash 級 —
lite 級做翻譯有其社群背書，我們 B 組的缺句可能是 40 句大 batch 的協定問題而非能力問題，
「lite + 縮小 chunk（20 句）」記為 future work。

今日「幾百元」帳單的數學也對上了：全日 recorded+未記錄的 run 約 1.5–3M tokens、
thinking 時代輸出占六成 × $9/M ≈ NT$300–600。

（費率來源見 PR 說明連結；儀表板已改雙費率估算：輸入 47 / 輸出 280 NT$/M，vars 可調。）

## 復現

```bash
npx esbuild worker/scripts/ab-runner.ts --bundle --platform=node --format=esm \
  --outfile=/tmp/ab-runner.mjs --loader:.json=json \
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
NODE_EXTRA_CA_CERTS=… gemini_key=… node /tmp/ab-runner.mjs <videoId> <model> <outDir>
```
