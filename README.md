# ytplayer — YouTube 中英雙語字幕 POC

自用（dogfooding）工具：把 YouTube 影片的英文字幕翻成**道地台灣正體中文**，
在自己的 player 頁做中英對照顯示。品質目標：高於 YouTube 內建自動翻譯、零中國用語。

架構（已定案，見 [docs/handoff.md](docs/handoff.md)）：

```
[自用 Chrome ext] → [CF Worker] → [R2] → [Player 頁]
   抓 caption track    翻譯 pipeline   存字幕   iframe + 自製字幕層
```

## 進度

| Phase | 內容 | 狀態 |
|---|---|---|
| 0 | 可行性驗證（caption track、CORS） | 🟡 進行中 — 見 [docs/phase0-findings.md](docs/phase0-findings.md)，剩瀏覽器端實測待使用者執行 |
| 1 | Chrome ext（ingest）+ Worker `/ingest` | ⬜ |
| 2 | 翻譯 pipeline（斷句 / glossary / 分塊翻譯） | ⬜ |
| 3 | Player 頁（iframe API + 字幕層） | ⬜ |
| 4 | 品質迭代（選作） | ⬜ |
