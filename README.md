# ytplayer — YouTube 中英雙語字幕 POC

自用（dogfooding）工具：把 YouTube 影片的英文字幕翻成**道地台灣正體中文**，
在自己的 player 頁做中英對照顯示。品質目標：高於 YouTube 內建自動翻譯、零中國用語。

架構（已定案，見 [docs/handoff.md](docs/handoff.md) 與 [docs/handoff-append-01.md](docs/handoff-append-01.md) 的影片分層策略）：

```
[自用 Chrome ext] → [CF Worker] → [R2] → [Player 頁]
   抓 caption track    翻譯 pipeline   存字幕   iframe + 自製字幕層
```

## 進度

| Phase | 內容 | 狀態 |
|---|---|---|
| 0 | 可行性驗證（caption track、CORS） | 🟢 決策問題已全數有答案 — 見 [docs/phase0-findings.md](docs/phase0-findings.md)。結論：ext 必要；timedtext 有 POT 防護，ingest 改走「攔截播放器請求」路徑，待 probe2 最終確認 |
| 1 | Chrome ext（ingest，攔截式）+ Worker `/ingest` | 🟡 程式完成、測試過（vitest 11 + wrangler dev 煙霧測試）— 待 [Cloudflare 連結部署](worker/README.md) 與 [ext 載入](ext/README.md) 後實機驗收 |
| 2 | 翻譯 pipeline（斷句 / glossary / 分塊翻譯）— 只處理 Tier 2 | ⬜ |
| 3 | Player 頁（iframe API + 字幕層） | ⬜ |
| 2.5 | ASR 修稿 pipeline（僅英文來源；Phase 3 之後） | ⬜ |
| 4 | 品質迭代（選作）+ tier 分佈統計 | ⬜ |
