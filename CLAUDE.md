# ytplayer — 專案記憶（給未來的 Claude session）

自用 YouTube 雙語字幕系統（道地台灣正體中文）。已吸收合併姊妹專案 kvsplayer（韓綜看片路線）。
架構與現況以 [README.md](README.md) 為準；本檔只放「不看會踩雷」的硬規則。

## 硬規則（實際踩過的雷）

1. **模型/設定的單一事實來源是 `worker/wrangler.jsonc`** — git 部署會蓋掉 dashboard 明文變數。
   目前定案：`gemini-3.5-flash` + `thinkingLevel:"minimal"`（**別用 thinkingBudget** — 它是預算不是
   硬上限，實測 budget 128 仍漏 507 thoughts），依據四組同片實驗
   [docs/model-experiment.md](docs/model-experiment.md)，改動前先看它
2. **thinking 以輸出價計費**，翻譯是機械任務不需要它 — 曾造成單日 NT$ 數百的帳單事故，
   完整教訓在 [docs/gemini-api-lessons.md](docs/gemini-api-lessons.md)（跨專案通用，別重學）
3. **紅線**：YouTube 自動翻譯軌（`tlang`）永不作為輸入；中文軌拒收（路由表 `routeSource`）
4. **LLM 工作只能在 queue consumer 跑**（fetch handler 含 waitUntil 會被砍 — 實測）；
   cron 是零成本看門狗，永不碰 LLM
5. **花費保險絲四層**不可拆：Google prepay → 每步 3 次重試永久失敗 → 每片 token 上限
   （計數跨重排累計，別改回歸零）→ 全域日預算。花費可視：`/health`、`/admin` 儀表板
6. 模型輸出視為敵意輸入 — 品質地板靠 deterministic 檢查（`sanityCheckItem`、禁用詞三層），
   不靠 LLM 自我審查
7. 工作風格：**先計劃再動手**（大改動先落 docs/*.md 計畫）；實驗結論回填文件的決策欄

## 常用操作

- 測試：`cd worker && npx vitest run`（95+ 個，push 前必綠）
- 手動翻譯：`POST /translate/{id}?force=1`（key：`x-ingest-key`）；A/B 擂台：`&model=…`
- 進度/花費：`/subs/{id}/status.json`、`/admin` 儀表板
- 部署：merge 到 main → Workers Builds 自動部署（production branch 設定在 CF dashboard）

## 待辦與懸案

- M5：關閉 kvsplayer（刪 Worker/queue、30 天後刪 kvs-krsub、移除 KVS 綁定與 migrate.ts）
- glossary 疊層（channel/genre/per-video）：計畫在 [docs/glossary-layers.md](docs/glossary-layers.md)，未實作
- ~~lite 縮 chunk 再戰~~：**已測否決**（2026-08-14，E 組缺句反而更多 — 病根是 index-keyed
  協定對 lite 的 id 紀律要求，換協定才有救，見 model-experiment.md）
- ~~id 連號檢查~~：**已實作**（`assertIdSanity` — 重複/亂序整包打回重試）；
  3.6-flash 若要重新評估，前提已備妥，但仍需同料 A/B + 抽樣人工比對
