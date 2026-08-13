# Gemini API 實戰教訓（跨專案通用）

> 2026-08-13 整理自 ytplayer + kvsplayer 的帳單事故與四組模型實驗。
> **寫給下一個用 Gemini 的專案**（kikemu / sukemi / manemu…）：把這頁複製過去或直接引用，
> 不要再用一次 NT$2000 學同樣的課。
> 詳細數據：[model-experiment.md](model-experiment.md)、[asr-language-experiment.md](asr-language-experiment.md) §4。

---

## 1. Thinking 稅（最貴的一課）

- Gemini 2.5+ 全系列**預設開推理**，thinking token **以輸出價計費**（$9/M 級），
  中度推理輸出膨脹 ~3 倍、重度 6–8 倍
- **症狀識別**：AI Studio 用量圖 Output tokens ≫ Input tokens（翻譯/抽取類工作應該反過來）
- **機械性任務（翻譯、格式轉換、抽取、分類）一律關思考**：
  `generationConfig.thinkingConfig.thinkingBudget`
- **相容性陷阱（實測）**：`budget: 0` 在 3.5-flash 可、**3.6-flash 拒收（400 generic）**；
  `budget: 128` 兩者通吃且實際 thoughts=0 → **跨模型預設用 128**，並準備 400 fallback（拿掉 config 重試）
- 效果實測：同片同 prompt，關思考 tokens **-31%**，且省掉的全是輸出價 token

## 2. 模型選擇：用同片 A/B，不要用印象

同一支影片、同一套 prompt 四組對決的結論（樣本：日文 ASR 686 句，有官方人工譯文對照）：

| 模型 | 結果 | 教訓 |
|---|---|---|
| 3.5-flash + 思考關 | **勝**：0 缺句、品質同思考版 | 日常翻譯的甜蜜點 |
| 3.6-flash + 思考關 | **多處「譯文對錯句」**（batch 內 id 對滑）| 量化指標（缺句/warnings）抓不到這種錯 — **必須抽樣人工比對** |
| 3.5-flash-lite | 缺 27 句（可見的失敗）| 大 batch（40 句 JSON）對 lite 太難；縮 chunk 再戰 |
| 3.5-flash + 思考開 | 品質最完整（譯註最多）但成本形狀最差 | 思考的邊際品質不值 3 倍輸出費 |

方法論：**LLM batch JSON 任務的模型評測，抽樣人工比對是必要的** —
「id 對滑」讓譯文看起來通順卻對到錯的時間點，任何自動指標都測不出來。

## 3. 官方牌價（2026-08，換模型前先查最新）

| 模型 | 輸入 $/M | 輸出 $/M |
|---|---|---|
| gemini-3.5-flash | 1.50 | 9.00 |
| gemini-3.6-flash | 1.50 | 7.50（輸出平均再少 17%）|
| gemini-3.5-flash-lite | 0.30 | 2.50 |

- 換算成本時**輸出佔比**比單價重要（thinking 計輸出價）
- 模型 ID 用 `GET /v1beta/models` 驗證存在再上 config —— `gemini-3.6-flash-lite` 這種
  「聽起來應該有」的 ID 不存在（404）

## 4. 設定管理陷阱（Cloudflare Workers 特有）

- **git 部署會用 wrangler.jsonc 的 `vars` 蓋掉 dashboard 明文變數**（只有 Secret 倖存）
  → 在 dashboard 改 `GEMINI_MODEL` 會被下一次部署無聲踩回 → **模型等設定的單一事實來源放 git**
- CF Worker 出口 colo 會變：台灣流量常經香港 → Gemini 回「User location is not supported」400
  → 這是**可重試錯誤**（同請求重打常換到可用出口）

## 5. 花錢系統的保險絲（架構級，四層）

任何「無人看管 + 會呼叫付費 API + 會重試」的系統，事故公式 = 無人看管 × 花錢 × 重試 × 失敗不可見。

1. **供應商端**：prepay / 日配額上限（程式再錯也燒不破）
2. **每步重試上限**：連續 N 次失敗 → 永久標記、只有人工能重啟
3. **每件工作 token 上限**：計數器要**跨重排累計**（重排歸零 = 保險絲被繞過，實際踩過）
4. **全域日預算**：超過 → 暫停非失敗，隔日自動續
+ **花費即時可視**（per-step 落地 tokens、prompt/output/thoughts 拆解）— 看不見的花費才是危險的花費
+ 付費呼叫「先存檔再花下一筆」：checkpoint 化，被砍只損失一步

## 6. 翻譯 pipeline 的品質地板（prompt 是天花板、程式是地板）

- 模型輸出視為敵意輸入：JSON 截斷修復（尾端逐 `}` 回退）、逐句 deterministic fail-fast
  （簡體字形表、原文照抄、長度異常）、崩塌偵測（同譯文 ≥3 次）
- 缺句處理：重試 → 切半分治（對付截斷與毒句）→ 仍缺標 `untranslated` 顯示原文（**可見的失敗**優於沉默）
- 禁用詞三層：prompt 對照表（付 token，精簡）→ 執法掃描（低誤報，觸發重譯）→ 大詞表（僅提示）
- 長工作放對執行環境：CF Worker 的 fetch handler（含 waitUntil）跑不完分鐘級工作，
  只有 scheduled/queue consumer 可以 — Queues 分步自我續鏈 + 冪等 checkpoint 是正解

## 7. 各專案現況（記憶同步區）

| 專案 | 狀態 | Gemini 用法 |
|---|---|---|
| **ytplayer** | 本 repo，active | text 路由（3.5-flash 思考關）+ video 路由（看片，MEDIUM 300 tok/s）|
| **kvsplayer（ytpoc）** | 已吸收合併進 ytplayer，待關閉 | 看片配方全數移植（分段掃描/失敗階梯/片尾偵測）|
| kikemu / sukemi / manemu | **本 session 無資料** — 此容器看不到其他專案的記憶 | 若有用 Gemini，請把本頁 §1–§5 帶過去；有實驗數據歡迎回填此表 |
