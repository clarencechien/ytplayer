# ytplayer — YouTube 中英雙語字幕（自用）

把 YouTube 影片的原文字幕翻成**道地台灣正體中文**，在自己的 player 頁做雙語對照。
品質目標：高於 YouTube 內建自動翻譯、零中國用語、非本科觀眾（大學生程度）能看懂六～八成。

```
[自用 Chrome ext] → [CF Worker (ytplayer)] → [R2] → [Player 頁]
  攔截 caption 軌      cron 佇列 + 翻譯 pipeline   存字幕   iframe + 雙語字幕層
```

線上：`https://ytplayer.ai-apps.work`（清單頁 `/`、播放 `/watch/{videoId}`）

## 影片分層（Tier）與解法歸屬

Caption track 有四個層級，每層是不同的題目（詳見 [docs/handoff-append-01.md](docs/handoff-append-01.md)）：

| Tier | 定義 | 判別 | 解法 | 歸屬 |
|---|---|---|---|---|
| **1** | 創作者自製多語言（有人工 zh-TW/zh-Hant 軌） | 存在非 ASR 的 zh 軌 | 預設用 YouTube 原生；**不滿意時 ingest 原文軌即重做** | ytplayer |
| **2** | 創作者自製原文 CC | 非 ASR、僅原文 | 斷句 → glossary → 分塊翻譯（主路徑） | ytplayer |
| **3**（英文） | 僅自動字幕 ASR | `kind==='asr'` / `vssId` 前綴 `a.` | 先 LLM 修稿再進 Tier 2 流程（Phase 2.5） | ytplayer |
| **3**（非英文） | 僅 ASR，日/韓等 | 同上 | 轉寫不可信，唯一划算的是 **LLM 看片路線** | **kvsplayer** |
| **4** | 無任何 CC | captionTracks 空 | 直接報錯 | —（或看片路線） |

實作上可譯性判準**看「被 ingest 的軌」不看 tier**：中文軌拒收、人工原文軌不分語言可翻、ASR 僅限英文。
紅線：YouTube 自動翻譯軌（`tlang`）永不作為輸入。

## 使用流程（日常）

1. YouTube 開影片 → 播放器開 CC 選**原文**軌 → 點 ext 圖示 → 送出
2. 完事。cron 每 5 分鐘自動翻（單支 1–2 分鐘），popup 給的 `/watch` 連結過幾分鐘自己出現字幕
3. 重翻：再 ingest 一次（source 變新即自動重翻）；改 prompt 後重跑：`POST /translate/{id}?force=1`

## 現況

MVP 完整可用：ingest → （英文 ASR 修稿）→ glossary → 分塊翻譯 → deterministic 驗證/fail-fast → 自動譯註 → player。
prompt 目前 **v4**；worker 測試 63 個。品質防線與所有實證教訓見 **[docs/lessons-learned.md](docs/lessons-learned.md)**。
kvsplayer 合併與否的分析（架構差異 / ADR / go–no-go）見 **[docs/kvsplayer-merge-todo.md](docs/kvsplayer-merge-todo.md)**。

### Player 操作（與 YouTube 慣例一致）

| 鍵 | 功能 | | 鍵 | 功能 |
|---|---|---|---|---|
| Space / K | 播放/暫停 | | C | 字幕開/關 |
| ← / → | ±5 秒 | | **按住 H** | 字幕暫時隱形（看畫面） |
| F | 全螢幕 | | Shift+< / > | 播放速度 |
| M | 靜音 | | 單擊影片 / 雙擊 | 播放暫停 / 全螢幕 |

按鈕列另有：字幕模式（雙語/只中/只原文/無）、譯註開關、字級、透明度、速度、
「YT 介面：鎖定/開放」（開放時可直接操作原生控制列，例如畫質齒輪）。

## Repo 結構與文件

| 路徑 | 內容 |
|---|---|
| `ext/` | MV3 擴充功能（攔截式 ingest），安裝見 [ext/README.md](ext/README.md) |
| `worker/` | CF Worker：`/ingest`、`/translate`、cron 佇列、player 頁。部署見 [worker/README.md](worker/README.md) |
| `phase0/` | 可行性探測工具與原始資料 |
| [docs/handoff.md](docs/handoff.md) | 原始任務書（分階段規格） |
| [docs/handoff-append-01.md](docs/handoff-append-01.md) | 影片分層策略增補 |
| [docs/phase0-findings.md](docs/phase0-findings.md) | Phase 0 實測結論（POT、CORS、SPA stale…） |
| [docs/phase1-plan.md](docs/phase1-plan.md) / [docs/phase2-plan.md](docs/phase2-plan.md) | 各階段實作計畫 |
| [docs/lessons-learned.md](docs/lessons-learned.md) | **實證教訓總整理 + kvsplayer 合流接軌指南** |
