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
3. **紅線**：YouTube 自動翻譯軌（`tlang`）永不作為輸入；中文軌拒收（路由表 `routeSource`）；
   robots.txt **永遠 Allow**（Disallow = 爬蟲讀不到 noindex，反而被收錄）；
   爬蟲閘門**放行正牌搜尋引擎**（同一個道理，見 docs/privacy-hardening.md）
   ⚠ `ai-apps.work` 有一條 **zone 層 WAF 規則**（UA 含 bot/crawl → Managed Challenge），
   對三兄弟（kikemu/sukemu/manemu）與本專案全部生效 —— **要加 webhook 端點前先看它**，
   對方 UA 含 `bot` 會被靜默 403（privacy-hardening.md §3.1）
4. **LLM 工作只能在 queue consumer 跑**（fetch handler 含 waitUntil 會被砍 — 實測）；
   cron 是零成本看門狗，永不碰 LLM
5. **花費保險絲四層**不可拆：Google prepay → 每步 3 次重試永久失敗 → 每片 token 上限
   （計數跨重排累計，別改回歸零）→ 全域日預算。花費可視：`/health`、`/admin` 儀表板
6. 模型輸出視為敵意輸入 — 品質地板靠 deterministic 檢查（`sanityCheckItem`、禁用詞三層、
   `assertIdSanity`、**回聲對位 `t`**），不靠 LLM 自我審查。
   取捨原則：**寧可看得見地失敗（標 untranslated），也不要安靜地錯（譯文對到隔壁句）**
7. 工作風格：**先計劃再動手**（大改動先落 docs/*.md 計畫）；實驗結論回填文件的決策欄
8. **每個品質改善都要有「事後套用」的路徑** — 語料已經翻好了，`?force=1` 重跑整片是
   最貴也最笨的修法。既有模式：⏱ 修時間（零 LLM）、✏ 補譯與 📏 壓縮（以句計價）；
   新功能要問「舊片怎麼套？」（docs/subtitle-readability.md §6）
9. **deterministic 的修法排在花錢的修法前面** — 📏 壓縮會先零成本剝掉英文夾註、
   重算一次才決定要不要送模型（實績：兩支舊片 11→3、16→0，共 NT$1.55，
   subtitle-readability.md §3.2）。
   同理：儀表板的數字要能被信任，一個顯示 bug（耗時用 updatedAt 算）會讓人
   誤判成燒錢事故，白白花掉一輪查帳的時間

## 常用操作

- 測試：`cd worker && npx vitest run`（175 個，push 前必綠）
- 手動翻譯：`POST /translate/{id}?force=1`（key：`x-ingest-key`）；A/B 擂台：`&model=…`
- 補譯：`POST /patch/{id}?mode=untranslated|cps|all`（只重譯有問題的句子，不重跑整片）
  —— `untranslated`＝未譯／原文照抄（預設，assemble 自動接的那條）；`cps`＝顯示時間讀不完的句子壓短
- 進度/花費：`/subs/{id}/status.json`、`/admin` 儀表板
- 部署：merge 到 main → Workers Builds 自動部署（production branch 設定在 CF dashboard）

## 待辦與懸案

**完整 backlog 看 [README.md](README.md) 的「還剩什麼沒做」段**：目前只剩 **畫質 B 案**、
**glossary G2**（儀表板編輯／一鍵收進頻道表）、**字幕可讀性 R2–R3**（折行拆塊／前一句留著，
計畫寫好、決策欄還空著）、**F2 lite A/B**（程式好了缺證據）、
**3.6-flash 重評**（F1 上線後前提已備妥）。

已完成收工（別重做）：M0–M5 全部（kvsplayer 已關閉、合併結案）、畫質 A 案（劇場模式）、
成本優化 L1+L2（單片 -51%）、PWA 手機送片、**glossary 疊層 G1 + F1–F4**（2026-08-16）、
**字幕可讀性 R1 + R4b + R5**（2026-08-17／08-21：字數預算、📏 壓縮鈕、零成本剝夾註）。

**跑 A/B 前先確認「新功能真的有啟動」** —— 2026-08-17 白跑一輪（NT$33）：
樣本影片沒有詞級時間 → 字數預算對每一句都回 undefined → 候選組其實沒開任何功能，
而且不會報錯。ab-runner 現在每輪都印「標了預算=N」，0 就是白跑。

換模型／換協定前**先看 [docs/model-reeval-sop.md](docs/model-reeval-sop.md)**：
觸發條件 + 固定五步（先量自然變異 3 次，候選 mean 要超出基準 min–max 才算有差）+
不可省的人工抽樣。`ab-runner --repeat N` 會自動產出變異表。

已結案的實驗結論（別重跑）：
- ~~3.6-flash 重評~~：**2026-08-16 已測，維持禁用** —— 理由已更新為「沒有優勢」
  （慢 4.5 倍、tokens +34%、未譯更多）；當年的「會譯錯句」已被回聲對位擋住
- ~~lite 換協定~~：**已測，假說成立**（重試 -85%、成本 NT$0.89/片），
  但預設仍用 3.5-flash；lite + `TRANSLATE_PROTOCOL=array CHUNK_SIZE=15` 定位為大量補翻工具
- ~~lite 縮 chunk 再戰~~：**已測否決**（2026-08-14，E 組缺句反而更多 — 病根是 index-keyed
  協定對 lite 的 id 紀律要求，換協定才有救，見 model-experiment.md）
- ~~id 連號檢查~~：**已實作**（`assertIdSanity` — 重複/亂序整包打回重試）；
  3.6-flash 若要重新評估，前提已備妥，但仍需同料 A/B + 抽樣人工比對
- ~~回聲對位能修子句邊界漂移~~：**假設已否決**（2026-08-16 實測 drift 沒降）——
  它修的是「譯文對到隔壁句」，漂移是另一回事（模型把語意重新分配到相鄰 cue），
  兩者別再混為一談（future-ideas.md F1「原設計錯在哪」）
