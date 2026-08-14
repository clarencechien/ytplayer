# Gemini API 教訓 — kikemu 摘要版

> 建議放 `docs/gemini-api-lessons.md`（docs/ 目前只有 PRD.md），並在 README 的「文件」表
> （README.md:122 附近）加一列。kikemu 沒有 CLAUDE.md — 值得照 ytplayer 的樣子建一個，
> 「wrangler.jsonc 是設定唯一事實來源」與 thinking 規則對這個 repo 逐字適用。
> Canonical 完整版：[ytplayer/docs/gemini-api-lessons.md](https://github.com/clarencechien/ytplayer/blob/main/docs/gemini-api-lessons.md)（2026-08-13 v2，已對官方文件核實）。

---

## 通用教訓 TL;DR（完整論證見 canonical）

1. **Thinking 稅**：thinking token 以輸出價計費（官方明載）。3.5-flash 預設 medium。
   機械性任務（翻譯/抽取）用 `thinkingLevel: "minimal"` 或 `thinkingBudget: 128`，
   備 400 fallback；budget 與 level 永不同時給。
2. **換模型先同料 A/B**：3.6-flash 有 batch id 對滑實測（ytplayer）+ 社群 regressions 回報。
3. **牌價**（2026-08-14 官方核實）：3.5-flash **$1.50/$9.00**、3.5-flash-lite $0.30/$2.50；
   3.6-flash 與新出的 3.7-flash 促銷 **$0.75/$3.75（至 2026-12-31，之後 $1.50/$7.50）**。
   促銷價別寫進 PRD 單位經濟（4.5 個月後失效）；3.7 沒有 minimal 思考檔，
   逐句翻譯這種機械任務別遷。模型 ID 先 `GET /v1beta/models` 驗證
   （本 repo judge.py:27 已踩過 `gemini-3-pro-preview` 404）。
4. **保險絲四層**：供應商端上限（AI Studio Spend 頁，開工先設）→ 每步重試上限 →
   每件工作 token 上限（跨重排累計）→ 全域日預算；花費要即時可視。
   本 repo 的「先存檔再花下一筆」checkpoint（results/raw/ 存在即跳過）是好習慣 ✓。

## 本 repo 專屬 findings（這次盤點發現，數據來自你自己存的 usageMetadata — 之前沒人讀它）

- **Thinking 稅在本 repo 是現在進行式**：全 repo 沒有任何地方設 thinkingConfig。
  自家存檔的 usageMetadata 顯示：C 組逐句翻譯 thoughts/output = **8.3×**（59,305 vs 7,123 tokens）、
  exp2 各組 3–6×、judge 用 pro 級 **18×**；`gemini-flash-lite-latest` 同工作 thoughts=**0**；
  **Live 路徑（3.1-flash-live）114 次全部 thoughts=0** — 災區只在 generateContent 這一側。
- **production 比實驗更糟**：exp1 是整段翻譯（thinking 前導攤在長文上），
  `relay.ts:138` 是**每句 finalized 各打一次** — 近乎固定的 thinking 前導按句付費，
  實驗量到的 8× 是地板不是估計。
- **extractVocab 的 JSON 截斷疑為 thinking 吃掉 maxOutputTokens 額度**（16384 仍截斷，
  make_dict.py 同款）— 加 thinking 控制後很可能連 salvage parser 都不太需要。
- **Live audio 輸出 token 在 usageMetadata 低報**（report.md:530 自己記過）— Live 花費從
  帳單側驗證，不要只信 usageMetadata。

## 待辦清單（依風險排序，我不動你的檔案，列給你決定）

1. **成本表抄錯價，且已擴散**：`results/report.md` §5 把 3.5-flash 記成 $0.30/$2.50 —
   那是 **flash-lite** 的價。真價 $1.50/$9.00 + thinking 按輸出價重算：
   translate hop ≈ **$0.84/hr**（非 $0.23）、兩跳合計 ≈ **$1.08/hr**（非 $0.47）。
   這個錯已進 `docs/PRD.md:157` 的單位經濟與管理儀表板（NT$0.25/min 同源）。
   修正順序：report.md §5 → PRD → 儀表板換算。
   附帶好消息：thinking 佔該 hop ~87%，關掉後 translate hop 掉到 ~$0.09/hr —
   **修完反而強化現在 C+（SM+詞表+Gemini 譯）路線的成本論證**，report 裡「成本略輸」的 hedge 可以拿掉。
2. **production translate 加 `thinkingLevel: "minimal"`（或 budget 128）+ 400 fallback**：
   `app/worker/gemini.ts` 的 `generate()` 是單一 helper，一處改三處生效
   （translateSentence / researchTerms / extractVocab）。researchTerms 帶 google_search tool，
   要不要保留 thinking 可單獨 A/B。
3. **無任何 spend 保險絲**：quota.ts 只算聽的秒數，token/成本零管制；`retryZh` 使用者可無限觸發。
   最低限度：去 AI Studio Spend 頁設每專案上限 + relay 端加每日 token 計數。
4. **judge.py 一口氣 108 個付費呼叫、無重試也無預算宣告** — 跑板前先估價
   （pro 級 judge 的 thinking 是 18×，換 flash 級或 flash-lite-latest 可省一個數量級，
   後者實測 thoughts=0）。
5. **驗證「budget 128 兩者通吃」**：`exp2/scripts/transcribe_ref.py` 同一路徑打 3.5-flash 與
   3.6-flash，是給 canonical §1 補第二次確認的天然位置（順手把結果回填 ytplayer 的文件）。
6. aggregate.py 完全忽略 usage — 把 thoughts/prompt/output 三欄加進彙總，
   「花費可視」才算落地（數據都在 results/raw/ 裡，只差讀出來）。
