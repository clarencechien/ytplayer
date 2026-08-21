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
4. 有句子沒翻到：正常情況系統翻完會**自己補**（最多 2 輪）；補不動的會在 `/admin` 顯示
   「⚠ N 句未譯」，按該列的「✏ 補譯」再補一次（只重譯那幾句，不重跑整片）
5. 字幕「來不及讀」：`/admin` 該列顯示「⏩ N 句讀不完」時按「📏 壓縮 N」
   （只重譯超標那幾句，以句計價；壓出來更長就保留原譯）
6. 舊片字幕「太快消失」：`/admin` 儀表板該列按「⏱ 修時間」（零 LLM 費用、冪等可重按）。
   ASR 句界要貼齊語音則需 **ext 更新後重新 ingest**（詞級時間，見
   [docs/subtitle-timing.md](docs/subtitle-timing.md)）

**字卡型韓綜 / 無 CC 的影片（video 路由）**
開 `/admin` 貼連結（建議填片長），Gemini 分段看片：聽寫 + 讀字卡 + 翻譯一次完成。
時間軸為模型估算（player 會標示 ⏱），成本約 text 路由 30 倍，長片會吃大半日預算。

## 現況

**合併結案、全功能可用**（2026-08-13 一日完成 kvsplayer 吸收合併，2026-08-14 關閉 kvsplayer；
過程見 [docs/migration.md](docs/migration.md)）：

- **text 路由**：ingest →（ASR 修稿）→ glossary → 分塊翻譯 → deterministic 驗證/fail-fast → 自動譯註。
  日文 ASR 端到端實測通過（`Zold8`→`Z Fold8` 修復 0 殘留、untranslated 0）
- **video 路由**：kvsplayer 看片配方移植（分段掃描/截斷接續/失敗階梯/片尾偵測）+ 播放卡卡修正
  （時間軸單調不重疊、字卡獨立圖層）；舊資料 9 支已遷入 schema v2，kvsplayer 的 Worker/queue 已刪除
- **手機**：PWA（加到主畫面）+ 分享／貼連結進 key-gated inbox 佇列，桌機 ext badge 提醒補收
  （刻意不做伺服器抓字幕 — POT + IP 封鎖，見 [docs/pwa-plan.md](docs/pwa-plan.md)）
- **執行架構**：Queues 分步自我續鏈（每步落地 checkpoint、斷鏈由 cron 看門狗自癒 — 實戰驗證過）
- **花費保險絲四層**：Google 端 prepay 配額 → 每步 3 次重試後永久失敗 → 每片 token 上限
  （text 500k / video 3M）→ 全域日預算 2M；成本事故的教訓見
  [docs/asr-language-experiment.md](docs/asr-language-experiment.md) §4.2
- **隱私三層**：全站 noindex（robots.txt 維持 Allow — Disallow 反而害死自己）→
  關掉 `*.workers.dev` + UA 爬蟲閘門（正牌搜尋引擎放行讓它讀到 noindex，語料/SEO 爬蟲 403）
  → **WAF Managed Challenge**（UA 型、zone 層，`ai-apps.work` 全站台涵蓋；真人零摩擦）。
  應用層 Turnstile 程式已備妥但刻意休眠。清單 key-gate、`/admin` Access、API key
  （[docs/privacy-hardening.md](docs/privacy-hardening.md)）
- **glossary 疊層**：channel 鎖定表 > genre 通用表 > 當片自動抽，同 term 上層贏、合併上限 80 條；
  兩條路由同源（text 吃三層、video 吃前兩層）。實測人工表對模型有實際約束力
  （鎖定譯法 0/7 → 6/7 句，見 [docs/exp-2026-08-16.md](docs/exp-2026-08-16.md) E2）
- **對位防線**：翻譯輸出帶回聲欄位 `t`（原文前 12 字），對不上就丟回重譯 ——
  實測抓到模型「整段位移一格」的真實案例
- **未譯句自動補譯**：翻完自己檢查（未譯旗標／原文照抄，deterministic），只重譯那幾句、
  最多 2 輪；儀表板顯示「⚠ N 句未譯」+ **✏補譯** 鈕
  （[docs/patch-untranslated.md](docs/patch-untranslated.md)）
- **字幕閱讀速度**：顯示時間換算成字數上限寫進 prompt（12 字/秒），讓模型自己壓縮 ——
  實測讀不完的句子少 29%、成本不變、沒被標的句子完全不動。
  舊片走 `/admin` 的 **📏壓縮** 鈕事後套用（只重譯超標那幾句；壓出來更長就不換）。
  壓縮前先**零成本剝掉英文夾註**（`原廠（First-party）追蹤器`→`原廠追蹤器`）。
  production 實績：兩支舊片 11→3、16→0，**合計只花 NT$1.55**（整片重翻要 NT$32）
  （[docs/subtitle-readability.md](docs/subtitle-readability.md) §3.1、§6；`CPS_BUDGET=off` 可關）

prompt 目前 **v6**；worker 測試 **175 個**。品質防線與所有實證教訓見
**[docs/lessons-learned.md](docs/lessons-learned.md)**；合併決策材料見
[docs/kvsplayer-merge-todo.md](docs/kvsplayer-merge-todo.md)。

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

## 還剩什麼沒做（接手先看這裡）

日常使用該有的功能都齊了。以下依「要寫程式 / 要你動手 / 隨時可開 / 決定不做」分四類。

### A. 還沒寫的程式（都有計畫文件，動工前先填決策欄）

| 項目 | 計畫 | 規模 | 為什麼還沒做 |
|---|---|---|---|
| **播放畫質 B 案** | [video-quality.md](docs/video-quality.md) | 1 天 | A 案（劇場模式）已解尺寸門檻。要 4K／Premium 只剩「ext 在 youtube.com 原生頁疊字幕」——僅桌機、且要**兩套渲染並存**，維護成本高 |
| **Glossary G2 養表流程** | [glossary-layers.md](docs/glossary-layers.md) §6 | 半天 | 儀表板編輯 + 「把自動抽的好譯法一鍵收進頻道表」。E2 已證明頻道表對模型真的有約束力（0/7 → 6/7 句），所以這筆投資現在有回報 |
| **字幕可讀性 R2–R3**（R1、R4b、R5 已上線）| [subtitle-readability.md](docs/subtitle-readability.md) | 1.5 天 | 實測尾巴 3% 的句子同時違反三條業界規範（最糟 18 CPS = Netflix 上限兩倍、36 字擠一行、單句掛 14 秒）。**R1 已實測上線**（CPS>12 -29%、tokens +0.3%），**R4b 📏壓縮鈕 + R5 零成本剝夾註**讓舊片也修得掉（實績 11→3、16→0，兩支共 NT$1.55）；剩 R2 折行與拆塊、R3 前一句留著（行數預算 + 三態設定）、R4a ✂修排版（綁 R2b）。**2026-08-21 重量完畢**（§3.3）：行長是另一個量級的問題 —— **37.5% 的句子一行放不下**（CPS 只剩 3.9%），建議做 R2a+R3、R2b 等它們上線後再量 |
| **子句邊界漂移** | 只有方向，還沒有計畫 | 大 | F1 實測證實回聲對位管不到它。可能的方向是「翻譯前先把 ASR 碎片合併成完整句、翻完再按詞級時間切回 cue」—— 比回聲對位大得多的改動，先觀察它到底多礙眼再說 |

### B. 程式做完了、等你動手驗收（都是 5 分鐘內的事）

| 驗什麼 | 怎麼驗 | 為什麼沒自動驗 |
|---|---|---|
| **ext 抓 ucid**（F4）| `chrome://extensions` 重新載入 ext → 送一支片 → 看 `/subs/{id}/source.json` 有沒有 `meta.channelId` | 容器內連不到 YouTube（429／connection reset）—— 與「不做伺服器抓字幕」是同一道牆 |
| **PWA 手機送片** | 手機開站台 → 加到主畫面 → 用 YouTube 分享或貼連結 → 桌機 popup 看待補佇列 | 需要真手機 |
| **三兄弟有沒有 webhook** | zone 層 challenge 規則對 `ai-apps.work` 全部主機生效 —— 若 kikemu／sukemu／manemu 有接 LINE／Slack／GitHub 等 UA 含 `bot` 的機器推送，會被靜默 403。有的話加一條 Skip 規則（[§3.1](docs/privacy-hardening.md)）| 我看不到那三個專案的流量 |
| **劇場模式畫質**（畫質 A 案）| player 頁按 `T` → 看畫質標示有沒有升上去 | 需要真螢幕與真播放器 |
| **G1 跨影片一致性** | 送同一個頻道的第二支片，看 `glossary.json` 的 `layers.channelKey` 是否命中同一張表 | 手上沒有同頻道的第二支已 ingest 影片 |

### C. 隨時可開、按需啟動的工具（不是待辦）

- **大量補翻舊片**：`TRANSLATE_PROTOCOL=array CHUNK_SIZE=15` + `gemini-3.5-flash-lite`
  = 一片 NT$0.89（預設 flash 是 NT$6.08），品質可接受、失敗看得見（[exp-2026-08-16.md](docs/exp-2026-08-16.md) E4）
- **模型／協定重評**：`ab-runner --repeat 3` + [model-reeval-sop.md](docs/model-reeval-sop.md)，一輪約 NT$35

### D. 決定不做／已結案（別重新發明）

- ~~Firefox Android ext 移植~~：手機路線已由 PWA + 桌機補收覆蓋
- ~~伺服器端抓字幕~~：POT + datacenter IP 封鎖（這次補測又撞到一次：HTTP 429）
- ~~3.6-flash~~：2026-08-16 重評，維持禁用（慢 4.5 倍、tokens +34%、未譯更多）
- ~~lite 縮 chunk~~：否決；換協定才有救（已驗證，見 C）
- **日文 F1 攔截率**是常態還是雜訊：不另外花錢測（要 NT$140），
  production 每支片的 hints 都會記 `echoRejects` 與未譯數，下幾支日文片自己會回答

### 2026-08-16 這批做完的（依相依順序 F4 → G1 → F1 → F3 → F2）

| | 內容 | 實測結果 |
|---|---|---|
| **F4 ext ucid** | `videoDetails.channelId` → channel key（名稱 slug 後備）| 頻道改名不影響鎖定表；真實抓取待 B 類驗收 |
| **G1 glossary 疊層** | channel > genre > 自動抽，上層贏、上限 80 條；兩條路由同源 | 鎖定譯法 0/7 → **6/7 句**；video 路由不再把 A 節目人名塞進 B 節目 |
| **F1 回聲對位** | 譯文帶 `t`（原文前 12 字），對不上就丟回重譯（prompt v5）| **抓到真實的整段位移**；但**不會**改善子句邊界漂移，成本 +14% |
| **F3 重評 SOP** | [model-reeval-sop.md](docs/model-reeval-sop.md) + `ab-runner --repeat N` 變異表 | 「先量自然變異」變成工具預設行為；已用它跑完 3.6 與 lite 兩組重評 |
| **F2 位置對齊協定** | `TRANSLATE_PROTOCOL=array`（**預設關閉**）| 假說成立：重試 -85%、成本 -85%；預設仍用 flash（品質優先）|

## Repo 結構與文件

| 路徑 | 內容 |
|---|---|
| `ext/` | MV3 擴充功能（攔截式 ingest），安裝見 [ext/README.md](ext/README.md) |
| `worker/` | CF Worker。部署見 [worker/README.md](worker/README.md)。主要模組：`jobs.ts`（Queues 步進引擎 + 保險絲）、`pipeline.ts`（text 路由演算法 + 路由表）、`watch.ts`（video 路由/看片）、`player.ts`（player/清單/admin 頁） |
| `phase0/` | 可行性探測工具與原始資料 |
| [docs/handoff.md](docs/handoff.md) | 原始任務書（分階段規格） |
| [docs/handoff-append-01.md](docs/handoff-append-01.md) | 影片分層策略增補 |
| [docs/migration.md](docs/migration.md) | **kvsplayer 合併方案與執行紀錄（M0–M5 全數完成、保險絲設計、隱私）** |
| [docs/future-ideas.md](docs/future-ideas.md) | **F1–F4 設計 + 實測結果**（回聲對位／lite 換協定／重評 SOP／ucid，含「原假設錯在哪」）|
| [docs/model-reeval-sop.md](docs/model-reeval-sop.md) | **模型重評 SOP**：觸發條件、固定五步、判讀規則（候選 mean 要超出基準 min–max）|
| [docs/exp-2026-08-16.md](docs/exp-2026-08-16.md) | **上線後補測**：G1 頻道表約束力、3.6-flash 重評、lite × 協定總表（含還沒測的誠實清單）|
| [docs/patch-untranslated.md](docs/patch-untranslated.md) | **未譯句自動偵測 + 補譯**：三種病因解剖、P0 預防、P1 補譯步驟（後來一般化成 `?mode=`）、實測 |
| [docs/subtitle-readability.md](docs/subtitle-readability.md) | **字幕可讀性計畫**：Netflix 繁中規範（16 字/行、2 行、9 CPS）對照實測、R1 壓縮譯文／R2 折行拆塊／R3 行數預算 roll-up／R4 舊片事後套用／R5 剝夾註。§3.2 有 R4b 上線後的實戰數據與「剩下壓不動的是什麼」 |
| [docs/privacy-hardening.md](docs/privacy-hardening.md) | **隱私三層**：workers.dev 關閉、UA 爬蟲閘門、Managed Challenge 的正確設法與雷區 |
| [docs/glossary-layers.md](docs/glossary-layers.md) | Glossary 疊層（channel/genre/per-video）：G1+G3 已實作、G2 未做 |
| [docs/pwa-plan.md](docs/pwa-plan.md) | PWA + 手機送片計畫與執行紀錄（桌機補收路線，已實作） |
| [docs/cost-optimization.md](docs/cost-optimization.md) | 成本優化 L1+L2（已實作，單片 -51%）+ 單片費用解剖 + 漂移發現 |
| [docs/video-quality.md](docs/video-quality.md) | 播放畫質：iframe 720p 成因；A 案劇場模式已實作、B 案 ext 原生疊層未實作 |
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
