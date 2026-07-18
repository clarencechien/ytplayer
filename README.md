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
| 1 | Chrome ext（ingest，攔截式）+ Worker `/ingest` | 🟢 實機 ingest 成功（SpaceX 707 cues）；驗收剩：三支影片 + cue 抽查 + SPA 切換 |
| 2 | 翻譯 pipeline（斷句 / glossary / 分塊翻譯） | 🟢 首支實跑通過（181 句、零禁用詞、80 分）；**prompt v2**：目標觀眾改為大學生/非本科（術語「中文（English）」+ 白話註解自動附在第一次出現處） |
| 3 | Player 頁（iframe API + 字幕層） | 🟡 完成待驗收：`/watch/{videoId}` + 清單頁 `/`，樣式借鏡 kvsplayer、中英同級；驗收 = 完整看完一支 20 分鐘影片 |
| 2.5 | ASR 修稿 pipeline（僅英文來源） | 🟡 已實作：Tier 3 + en 自動先修稿（去 [music]、修聽寫錯、補標點）再進翻譯，cron 會撿 — 待 SpaceX 實跑驗收 |
| 4 | 品質迭代（選作）+ tier 分佈統計 | ⬜ |
