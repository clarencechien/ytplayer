# Gemini API 教訓 — sukemu 摘要版

> 建議放 `docs/gemini-api-lessons.md`，並在 README 的文件表（README.md:7-15）加一列，
> `docs/config.md` §三與 ADR 0001 的「未處理」bullet 可加交叉引用。
> Canonical 完整版：[ytplayer/docs/gemini-api-lessons.md](https://github.com/clarencechien/ytplayer/blob/main/docs/gemini-api-lessons.md)（2026-08-13 v2，已對官方文件核實）。

---

## 通用教訓 TL;DR（完整論證見 canonical）

1. **Thinking 稅**：thinking token 以輸出價計費（本 repo 已正確入帳：`gemini.ts` 把
   thoughtsTokenCount 併入 outTok）。3.x 官方旋鈕是 `thinkingLevel`（minimal/low/medium/high）；
   `thinkingBudget` 僅向下相容，**兩者同時給 → 400**；`budget: 0` 在 3.6-flash 會 400（ytplayer 實測）—
   要降就用 `minimal` 或 `budget: 128`，備 400 fallback。
2. **「機械性任務關思考」是任務形狀判斷，不是全關**：P1（bounding box 空間定位）是 reasoning-shaped，
   handoff.md 的「不要關 thinking」對 P1 成立；但 **P2（JSON 進 JSON 出的在地化改寫）是機械任務**，
   正在為預設 medium thinking 付 3.6-flash 輸出價。
3. **換模型先同料 A/B**：ytplayer 實測 3.6-flash 在 index-keyed batch JSON 會「id 對滑」
   （譯文通順但對錯句，自動指標測不到，靠抽樣人工比對）；社群也有大量 3.6 regressions 回報。
4. **牌價**（2026-08-14 官方核實）：`gemini-3.6-flash-lite`/3.7-lite 確認不存在。
   **注意：3.6-flash 已促銷半價 $0.75/$3.75（至 2026-12-31，之後回 $1.50/$7.50）** —
   docs/config.md 的價表與每菜單成本（NT$1.37）暫時高估一倍，但**別用促銷價改單位經濟**，
   2027-01-01 就漲回。新出的 3.7-flash（同促銷價）沒有 minimal 思考檔、benchmark 偏
   coding/agentic，P1 視覺任務若想試要先跑 ab-models.mjs 同料 A/B。
5. **wrangler `vars` 蓋 dashboard 明文變數**：本 repo 已知且已在 wrangler.jsonc:51 立碑 ✓。
6. HKG colo → location 400：重試有效只因換 colo；穩定解是查 `request.cf.colo` 改路由。
7. 供應商端保險絲旋鈕已到位（AI Studio Spend 頁每專案上限、prepaid、Tier 月上限）— 開工先設。

## 本 repo 專屬 findings（這次盤點發現）

- **sukemu 的「未知 config 欄位 → 400 → 拿掉重試」模式（gemini.ts:114-119 的 mediaResolution
  fallback）就是 thinkingConfig 該用的同一款 fallback** — 要加 thinking 控制時直接沿用這個形狀。
- **座標格式指示會被無視**（normalizeBlocks 從值域反推 0–1000 慣例）— 這條已回填進 canonical §6，
  是「模型輸出視為敵意輸入」的新資料點，其他專案受益。
- 兩段式設計（P1 vision / P2 text，重試不重付圖片 token）是好架構，已回填 canonical §1 當正面示範。

## 待辦清單（依風險排序，我不動你的 code，列給你決定）

1. **P2 沒有任何配額檢查**（index.ts:299-315 只累計不檢查）— 唯一無上限的付費入口。
2. **P2 的 id 對滑風險未驗證**：P2 正是 ytplayer 出事的那種 index-keyed batch JSON
   （`{i, zh, nt}` 按整數 index merge 回去），且回傳的 `i` 沒有驗證對應正確 block。
   低成本防線：驗 `i` 連號 + 集合相等；高信度防線：抽樣人工比對一次。
3. **P2 A/B `thinkingLevel: "minimal"`（或 budget 128）**：機械任務、輸入才 1–2k token，
   卻付 medium thinking 的 3.6-flash 輸出價。handoff.md §13「P2 用哪個模型」還沒跑的 A/B
   可以連這個一起測。P1 維持 thinking，另開 A/B 才動。
4. **配額單位是張數，不是成本**：QuotaCounter 有 costTwd 卻從不當門檻 — 病態圖（30+ 區塊）
   與簡單圖差 7 倍花費佔同一格配額。把 costTwd 設為第二道門檻即可。
5. **無全站/帳號級日預算**：30 張 × N 個核可使用者在組織層級無上限，唯一後盾是 Google 端 —
   至少去 AI Studio Spend 頁設每專案上限。
6. 過時註解：wrangler.jsonc:54 與 gemini.ts:139 說「換 `GEMINI_MODEL` 會自動換價」，
   但這個 var 不存在（實際是 FAST_MODEL/ACCURATE_MODEL）— 順手修，避免未來誤導。
7. 小 race：配額 read-then-act + waitUntil 事後入帳，併發下可微幅超額 — 低優先，知道就好。
