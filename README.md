# ytplayer — YouTube 雙語字幕（自用）

把 YouTube 影片翻成**道地台灣正體中文**，在自己的 player 頁做雙語對照（原文英/日/韓…皆可）。
品質目標：高於 YouTube 內建自動翻譯、零中國用語、非本科觀眾（大學生程度）能看懂六～八成。
已吸收合併姊妹專案 kvsplayer（韓綜 Gemini 看片路線 + 字卡）。

```
text 路由：[自用 Chrome ext] ──ingest──┐
                                      ├→ [CF Worker + Queues 分步 pipeline] → [R2] → [Player 頁]
video 路由：[/admin 貼連結（看片）] ────┘     plan→修稿→glossary→翻譯→組裝            iframe + 字幕層 + 字卡層
```

線上：`https://ytplayer.ai-apps.work`（清單頁 `/`、播放 `/watch/{videoId}`、看片任務 `/admin`）

## 影片分層（Tier）與解法歸屬

Caption track 有四個層級，每層是不同的題目（詳見 [docs/handoff-append-01.md](docs/handoff-append-01.md)）：

| Tier | 定義 | 判別 | 路由 |
|---|---|---|---|
| **1** | 創作者自製多語言（有人工 zh-TW/zh-Hant 軌） | 存在非 ASR 的 zh 軌 | 預設用 YouTube 原生；**不滿意時 ingest 原文軌即重做**（`text`） |
| **2** | 創作者自製原文 CC | 非 ASR、僅原文 | `text`：斷句 → glossary → 分塊翻譯（主路徑） |
| **3**（ASR） | 僅自動字幕 | `kind==='asr'` / `vssId` 前綴 `a.` | `text`：先 LLM 修稿再翻。**各語言開放**（[實測依據](docs/asr-language-experiment.md)），韓文除外 |
| **3**（字卡型） | ASR 有，但畫面字卡承載語意（韓綜） | 人工判斷 | `video`：Gemini 看片（`/admin` 貼連結，成本 ~30 倍故永遠明示選擇） |
| **4** | 無任何 CC | captionTracks 空 | `video`（唯一選項） |

路由判準**看「被 ingest 的軌」不看 tier**：中文軌拒收、人工原文軌不分語言可翻、ASR 除韓文外開放
（`worker/src/pipeline.ts` 的 `routeSource`）。紅線：YouTube 自動翻譯軌（`tlang`）永不作為輸入。

## 使用流程（日常）

**有原文 CC / ASR 的影片（text 路由，絕大多數）**
1. YouTube 開影片 → 播放器開 CC 選**原文**軌 → 點 ext 圖示 → 送出
2. 完事。ingest 即排入 Queues 分步翻譯（進度在 `/subs/{id}/status.json`，player 頁會顯示），
   popup 給的 `/watch` 連結幾分鐘後自己出現字幕
3. 重翻：再 ingest 一次（source 變新即自動重翻）；改 prompt 後重跑：`POST /translate/{id}?force=1`
   （`force` 也是唯一能重啟「已標記失敗」影片的方式 — 連續失敗 3 次會永久停，防燒錢）
4. 舊片字幕「太快消失」：`/admin` 儀表板該列按「⏱ 修時間」（零 LLM 費用、冪等可重按）。
   ASR 句界要貼齊語音則需 **ext 更新後重新 ingest**（詞級時間，見
   [docs/subtitle-timing.md](docs/subtitle-timing.md)）

**字卡型韓綜 / 無 CC 的影片（video 路由）**
開 `/admin` 貼連結（建議填片長），Gemini 分段看片：聽寫 + 讀字卡 + 翻譯一次完成。
時間軸為模型估算（player 會標示 ⏱），成本約 text 路由 30 倍，長片會吃大半日預算。

## 現況

**合併後全功能可用**（2026-08-13，一日完成 kvsplayer 吸收合併，過程見 [docs/migration.md](docs/migration.md)）：

- **text 路由**：ingest →（ASR 修稿）→ glossary → 分塊翻譯 → deterministic 驗證/fail-fast → 自動譯註。
  日文 ASR 端到端實測通過（`Zold8`→`Z Fold8` 修復 0 殘留、untranslated 0）
- **video 路由**：kvsplayer 看片配方移植（分段掃描/截斷接續/失敗階梯/片尾偵測）+ 播放卡卡修正
  （時間軸單調不重疊、字卡獨立圖層）；舊資料 9 支已遷入 schema v2
- **執行架構**：Queues 分步自我續鏈（每步落地 checkpoint、斷鏈由 cron 看門狗自癒 — 實戰驗證過）
- **花費保險絲四層**：Google 端 prepay 配額 → 每步 3 次重試後永久失敗 → 每片 token 上限
  （text 500k / video 3M）→ 全域日預算 2M；成本事故的教訓見
  [docs/asr-language-experiment.md](docs/asr-language-experiment.md) §4.2
- **隱私**：全站 noindex（含 robots.txt 不 Disallow 的陷阱解法）；清單 key-gate；
  `/watch` 公開可分享（已接受的殘餘風險記錄在 [docs/migration.md](docs/migration.md) §5）

prompt 目前 **v4**；worker 測試 **97 個**。品質防線與所有實證教訓見
**[docs/lessons-learned.md](docs/lessons-learned.md)**；合併決策材料見
[docs/kvsplayer-merge-todo.md](docs/kvsplayer-merge-todo.md)。
glossary 目前 text 路由 by video 自動抽、video 路由 by language 靜態表（疊層方案見 backlog）。

### Player 操作（與 YouTube 慣例一致）

| 鍵 | 功能 | | 鍵 | 功能 |
|---|---|---|---|---|
| Space / K | 播放/暫停 | | C | 字幕開/關 |
| ← / → | ±5 秒 | | **按住 H** | 字幕暫時隱形（看畫面） |
| F | 全螢幕 | | Shift+< / > | 播放速度 |
| M | 靜音 | | 單擊影片 / 雙擊 | 播放暫停 / 全螢幕 |

按鈕列另有：字幕模式（雙語/只中/只原文/無）、譯註開關、字級、透明度、速度、
「YT 介面：鎖定/開放」（開放時可直接操作原生控制列，例如畫質齒輪）。
手機（iPhone/Android）自動進 RWD 模式：直向字幕在影片下方、橫向最大化時字幕疊回畫面。
video 路由的影片另有**字卡層**（🃏 疊畫面上緣、逐句稿有標記），與對白字幕分層顯示。

## Backlog（未實作 — 接手先看這裡）

每項都有寫好的計畫文件與**留白的決策欄**；動工前先填決策欄（本專案工作風格：先計劃再動手）。

| 項目 | 計畫 | 規模 | 現況／前提 |
|---|---|---|---|
| **M5 關閉 kvsplayer** | [migration.md](docs/migration.md) §M5 | 小（多為人工）| 資料已遷完；待刪 Worker/queue、`kvs-krsub` 保留 30 天後刪；程式面要移除 KVS 綁定與 `migrate.ts` |
| **成本優化（重試效率）** | [cost-optimization.md](docs/cost-optimization.md) | 半天–1 天 | 實測：9 分鐘片 NT$10.87，**六成是重試重吐譯文**。L1 補丁式重試預估 -47%。目前用量下「省錢但不急」；要大量補翻舊片就是前置條件 |
| **PWA + 手機送片** | [pwa-plan.md](docs/pwa-plan.md) | 1–1.5 天 | 手機分享 → key-gated inbox 佇列 → 桌機 ext badge 提醒補收。**刻意不做伺服器抓字幕**（POT + IP 封鎖）|
| **Glossary 疊層** | [glossary-layers.md](docs/glossary-layers.md) | G1 半天 | 解「同頻道跨影片譯法不一致」；channel key 目前只能用頻道名 slug（ext 未抓 channelId）|

**Future ideas（還沒有計畫文件，要做先開一份）**

- **lite 級翻譯換協定**：E 組實測否決縮 chunk，病根是 index-keyed 的 id 紀律 → 唯一出路是改成
  按位置對齊的純陣列輸出（成功則成本再砍 6 倍，見 [model-experiment.md](docs/model-experiment.md)）
- **3.6-flash 重評**：`assertIdSanity` 已備妥（它當初就是被 id 對滑打回的），但仍須同料 A/B + 抽樣人工比對
- **3.7-flash**：觀望——沒有 `minimal` 檔位，thinking 稅地板墊高（見 [gemini-api-lessons.md](docs/gemini-api-lessons.md) §1）
- **ext 抓 channelId（ucid）**：glossary channel key 穩定化，順便讓頻道改名不影響鎖定表
- **Firefox Android ext 移植**：FF 128+ 已支援 `world: "MAIN"`，是手機直接 ingest 的唯一非灰色路徑

## Repo 結構與文件

| 路徑 | 內容 |
|---|---|
| `ext/` | MV3 擴充功能（攔截式 ingest），安裝見 [ext/README.md](ext/README.md) |
| `worker/` | CF Worker。部署見 [worker/README.md](worker/README.md)。主要模組：`jobs.ts`（Queues 步進引擎 + 保險絲）、`pipeline.ts`（text 路由演算法 + 路由表）、`watch.ts`（video 路由/看片）、`migrate.ts`（kvsplayer 遷移，M5 後移除）、`player.ts`（player/清單/admin 頁） |
| `phase0/` | 可行性探測工具與原始資料 |
| [docs/handoff.md](docs/handoff.md) | 原始任務書（分階段規格） |
| [docs/handoff-append-01.md](docs/handoff-append-01.md) | 影片分層策略增補 |
| [docs/migration.md](docs/migration.md) | **kvsplayer 合併方案與執行紀錄（M0–M5、保險絲設計、隱私）** |
| [docs/glossary-layers.md](docs/glossary-layers.md) | Glossary 疊層計畫（channel/genre/per-video，未實作） |
| [docs/pwa-plan.md](docs/pwa-plan.md) | PWA + 手機送片計畫（桌機補收路線，未實作） |
| [docs/cost-optimization.md](docs/cost-optimization.md) | 成本優化計畫（重試效率，未實作）+ 單片費用解剖 |
| [docs/subtitle-timing.md](docs/subtitle-timing.md) | 字幕時間軸：病因與修法（A 詞級斷句 + B 顯示鏈接，已實作） |
| [docs/model-experiment.md](docs/model-experiment.md) | 模型對決四組實測（3.5-flash+關思考勝出）+ 官方牌價外部驗證 |
| [docs/gemini-api-lessons.md](docs/gemini-api-lessons.md) | **Gemini API 跨專案教訓 v2.4（canonical）**：thinking 稅／模型 A-B 方法論／官方牌價／保險絲四層；kikemu・sukemu・manemu 實測數據已回填 |
| [docs/phase0-findings.md](docs/phase0-findings.md) | Phase 0 實測結論（POT、CORS、SPA stale…） |
| [docs/phase1-plan.md](docs/phase1-plan.md) / [docs/phase2-plan.md](docs/phase2-plan.md) | 各階段實作計畫 |
| [docs/asr-language-experiment.md](docs/asr-language-experiment.md) | 非英文 ASR 實測 + 成本事故解剖 + 端到端驗證 |
| [docs/lessons-learned.md](docs/lessons-learned.md) | **實證教訓總整理** |

## 參考資源（zh-TW 品質層的外部來源）

| 資源 | 授權 | 我們怎麼用 |
|---|---|---|
| [OpenCC](https://github.com/BYVoid/OpenCC) TWPhrases 詞表 | Apache-2.0 | **報告層**：680 條中國用語掃描（命中只進 `hints` 提示，不觸發重譯 — 批量詞表允許誤報換覆蓋）。再生：`node worker/scripts/build-twlexicon.mjs` |
| [speak-human-tw](https://github.com/Raymondhou0917/speak-human-tw)（說人話） | MIT | **執法層**：策展 16 條無歧義對照併入禁用詞掃描（命中觸發重譯）；其「按語境判斷／誤殺防護」哲學對應我們的 `BANNED_EXCEPTIONS` 與生成器 SKIP 表 |
| [kvsplayer（ytpoc）](https://github.com/clarencechien/ytpoc) | 自家姊妹專案（已吸收合併） | video 路由整套配方（分段看片/失敗階梯/清洗）與韓綜譯名表 59 條（`worker/src/data/watch-glossary-ko.json`） |

三層設計：prompt 對照表（16 條，每 chunk 付 token 故維持精簡）→ 執法層（32 條，低誤報，重譯）→ 報告層（680 條，僅提示）。
