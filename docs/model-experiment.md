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

## 復現

```bash
npx esbuild worker/scripts/ab-runner.ts --bundle --platform=node --format=esm \
  --outfile=/tmp/ab-runner.mjs --loader:.json=json \
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
NODE_EXTRA_CA_CERTS=… gemini_key=… node /tmp/ab-runner.mjs <videoId> <model> <outDir>
```
