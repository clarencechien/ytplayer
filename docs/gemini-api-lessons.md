# Gemini API 實戰教訓（跨專案通用）v2.4

> 2026-08-13 初版整理自 ytplayer + kvsplayer 的帳單事故與四組模型實驗。
> **v2（同日）：經官方文件與社群查證，並回填 kikemu / sukemu / manemu 三個姊妹專案的實測數據。**
> **v2.1（2026-08-14）：加入 gemini-3.7-flash（8/13 發布）查證結論 — 促銷半價、無 minimal 檔、翻譯行為零數據。**
> **v2.2（2026-08-14）：ytplayer 稽核回填 — id 連號檢查已實作；「lite 縮 chunk 再戰」實測否決（E 組）。**
> **v2.3（2026-08-14）：與早期 ytplayer 版合併為單一檔案。本檔是 canonical（姊妹 repo 的摘要版都連到這個路徑）。**
> **v2.4（2026-08-14）：三個姊妹 repo 當日實驗回填 — `budget:128` 通吃說被 kikemu 推翻（`thinkingLevel:"minimal"` 才是唯一實測歸零的旋鈕）；sukemu P1/P2 A/B 成對反例 + A/B 方法論兩條必要控制；座標回退更正為 thinking 檔位效應。**
> 寫給下一個用 Gemini 的專案：把這頁複製過去或直接引用，不要再用一次 NT$2000 學同樣的課。
> 詳細數據：[model-experiment.md](model-experiment.md)、[asr-language-experiment.md](asr-language-experiment.md) §4。
> 各 repo 專屬摘要**已各自入庫**（2026-08-14）：kikemu/sukemu `docs/gemini-api-lessons.md`、
> manemu `live-translate-poc/docs/gemini-lessons-manemu.md`（本頁 §7 有現況表）。
> 本 repo 的三份草稿 `docs/{kikemu,sukemu,manemu}geminilessons.md` 已完成任務，**2026-08-14 已刪**。

---

## 1. Thinking 稅（最貴的一課）

- **症狀識別（第一線診斷，不用讀 code）**：用量圖 **Output tokens ≫ Input tokens** 就是中招 —
  翻譯／抽取／分類這類工作的正常形狀是輸入遠大於輸出（ytplayer 帳單事故就是這樣抓到的：
  Output 是 Input 的 3–4 倍）。先看圖形狀，再去查 `thoughtsTokenCount` 對帳
- **官方證實**：pricing 頁明寫輸出價 "including thinking tokens"，thinking token 以輸出價計費，
  用量在 `usageMetadata.thoughtsTokenCount` / `total_thought_tokens`
- **各模型預設（官方 thinking doc，2026-08）**：3.6-flash = medium、3.5-flash = medium、
  3.5-flash-lite = **minimal（不是 off）**、3.1-pro / 3-flash-preview = high；
  2.5-flash-lite 是唯一預設 off 的例外 —「全系列預設開」大致成立，例外要查表
- **官方旋鈕已換代**：3.x 建議用 `thinkingConfig.thinkingLevel`（`minimal`/`low`/`medium`/`high`）；
  `thinkingBudget` 僅向下相容，**兩者同時給 → 400**。官方明講 `minimal` **不保證完全關閉**
- **Thinking 下限逐代升高（趨勢，2026-08-14 確認）**：3.5-flash 可 budget 0 → 3.6-flash 拒收 0 →
  **3.7-flash 連 `minimal` 都不支援（官方 model 頁：僅 low/medium/high）** —
  機械性任務的「關思考」策略在 3.7 上**不可用**，最低只有 low（稅率未實測）。
  這是把機械任務留在 3.5-flash（minimal）或 lite 級的獨立理由，與品質無關
- **定案旋鈕：`thinkingLevel: "minimal"`，不要用 `thinkingBudget`（v2.4 更正）**。
  kikemu 用凍結口譯 prompt 同料 A/B（2026-08-14）推翻了本檔早期的「budget 128 兩者通吃且 thoughts=0」：

  | thinkingConfig | 3.5-flash | 3.6-flash |
  |---|---|---|
  | （不設） | 29.1× | 29.6× |
  | `thinkingLevel: "minimal"` | **0×** ✅ | **0×** ✅ |
  | `thinkingBudget: 128` | **18.5×** ❌ | **12.0×** ❌ |
  | `thinkingBudget: 0` | 0× | 400 拒收 |
  | level + budget 同給 | 400「only one of thinking budget and thinking level」| 同左 |

  **`thinkingBudget` 是預算不是硬上限**，實際 thoughts 可以超過它；ytplayer 早前在自己任務上
  量到 budget 128 → thoughts=0，是**任務形狀相依的巧合，不可依賴**。
  **ytplayer 獨立複驗（2026-08-14，真實 10 句日譯中 prompt，3.5-flash）**：不設 → thoughts 1909（5.5×）、
  `budget:128` → thoughts **507**（1.5×）、`level:"minimal"` → **0**、`budget:0` → 0。
  早前的 0 是用玩具 prompt（「回覆 JSON: {ok:1}」）量的 —— **玩具 prompt 量不出 thinking 稅，
  一定要用生產 prompt 複驗**。ytplayer 已於同日改為 `thinkingLevel:"minimal"`。
  minimal 品質無退化（kikemu 三句抽樣人工比對，專名/台灣用語皆正確）。
  一律備 400 fallback（拿掉 thinkingConfig 重試）；budget 與 level 永不同時給
- **機械性任務（翻譯、格式轉換、抽取、分類）一律關思考**。效果實測：同片同 prompt 關思考 tokens **-31%**
- **kikemu 回填的硬數據**：歷史 usageMetadata 逐句翻譯 thoughts/output **3–8 倍**（最糟 8.3×）、
  逐句凍結 prompt A/B 更高達 **29×**；judge 用 pro 級 18×；`gemini-flash-lite-latest` 同工作 thoughts=0；
  **Live API 路徑 thoughts=0**（108+ 次實測）— thinking 稅是 generateContent 的問題，不是 Live 的
- **已證實機制：thinking token 會吃 `maxOutputTokens` 額度** → JSON 尾端被截斷。
  kikemu 對照實驗（同 prompt，`maxOutputTokens: 300`）：預設思考 → thoughts 287 / output **9** /
  finishReason=MAX_TOKENS（JSON 壞掉）；minimal → thoughts 0 / output 206 / STOP（JSON 完整）。
  看到截斷先懷疑 thinking 佔額度，不要急著怪輸出太長
- **成對反例（sukemu，同專案兩趟結論相反，ADR 0002）**：「關思考」的決策單位是**趟**，不是專案 —
  P2（JSON 進出改寫，機械）降 minimal：12.0s→2.8s、tokens **-81%**、NT$0.56→0.13，
  修訂反而更多更細、id 全數有效 ✅；P1（bounding box 定位，reasoning-shaped）降 minimal：
  框「穩定地歪」（橫向漂移、跨欄）且座標規格掉回 0–1000 → **維持預設** ❌。
  兩段式設計（P1 視覺 / P2 純文字）讓「該想的」與「機械的」分開計價，重試也不用重付圖片 token。
  reasoning-shaped 的判斷也適用呼叫粒度：kikemu 的 researchTerms（自主決定查什麼）不關、
  translateSentence / extractVocab（機械）關

## 2. 模型選擇：用同片 A/B，不要用印象

同一支影片、同一套 prompt 四組對決的結論（樣本：日文 ASR 686 句，有官方人工譯文對照）：

| 模型 | 結果 | 教訓 |
|---|---|---|
| 3.5-flash + 思考關 | **勝**：0 缺句、品質同思考版 | 日常翻譯的甜蜜點 |
| 3.6-flash + 思考關 | **多處「譯文對錯句」**（batch 內 id 對滑）| 量化指標抓不到 — **必須抽樣人工比對** |
| 3.5-flash-lite | 缺 27 句（可見的失敗）| 縮 chunk 到 20 **反而更糟**（30 句，E 組）— 病根是 index-keyed 協定的 id 紀律，不是 batch 大小；lite 要再戰得換協定（按位置對齊的純陣列）|
| 3.5-flash + 思考開 | 品質最完整（譯註最多）但成本形狀最差 | 思考的邊際品質不值 3 倍輸出費 |

- **社群佐證（2026-08）**：3.6-flash 上線以來 Google AI 論壇大量回報 regressions
  （coding 變弱、指令遵循差、跳步驟、AI Studio 隨機 Invalid Argument），第三方評測也非全面進步；
  但「batch id 對滑」**尚無公開報告** — 這是我們自己的發現，抽樣人工比對仍是必要程序
- **定價倒掛**：3.6-flash 輸出 $7.50 **比** 3.5-flash 的 $9.00 便宜、輸入同 $1.50 —
  便宜不等於可用，換模型永遠先同料 A/B
- **反向資料點（sukemu）**：視覺任務上 3.6-flash 勝過 3.5-flash-lite（lite 有 box 漂移、多語黏連 —
  且框漂移事後證實主因是 **thinking 不足**，不只是模型級別，見 §6）；
  P2 的 id 對滑風險已補「範圍 + 去重 + t 回聲對位」三道防線（見 §6）
- **A/B 方法論的兩條必要控制（sukemu P1 實驗差點翻車，v2.4 新增）**：
  1. **先量同設定的自然變異，再談差異** — baseline 自己重跑兩次 IoU 只有 0.571，
     比候選對 baseline 的 0.875 還低：變異比訊號大時，**n=1 的比較會給出相反的結論**。
     凡是「候選 vs 基準」的分數，都要先有「基準 vs 基準」的分數當尺（同設定至少重複 3 次）
  2. **一致 ≠ 正確，數字要配目視/抽樣人工比對** — minimal 在所有量化指標上更好
     （框數 11/11/11、組內 IoU 更高），把框疊回照片才看見它「每次都用同樣的方式歪掉」。
     高一致性可能來自**穩定地錯**，與 id 對滑同一母題：輸出看起來很好、對到錯的東西，
     自動指標測不出來
- **3.7-flash（2026-08-13 發布，三個月內第三款 flash；本表 2026-08-14 查證）**：
  AA 智慧指數 56（+4 vs 3.6）、340 tok/s（同級最快）、1M ctx、輸出上限 65,536；
  多模態輸入齊全（text/image/video/audio/PDF，輸出僅 text）；**不支援 Live API**。
  benchmark 全面偏 coding/agentic（FrontierCode 43.6% vs 34.4%、DeepSWE 65.3% vs 49.0%、
  AutomationBench 30.4% vs 17.0%、文件 QA GDP.pdf 34% vs 22%）。
  **翻譯與 batch JSON 行為：官方與社群皆零數據（發布未滿一天）** — 3.6 的教訓正是
  「benchmark 進步 ≠ 你的任務進步」，遷移前必跑同料 A/B + id 連號檢查 + 抽樣人工比對。
  再加上它沒有 minimal 檔（§1），**對我們的機械翻譯工作，3.7 目前不是候選；
  對 coding/agent 類新專案才值得試**
- 方法論：LLM batch JSON 任務的模型評測，**抽樣人工比對是必要的** —
  「id 對滑」讓譯文看起來通順卻對到錯的時間點，任何自動指標都測不出來

## 3. 官方牌價（2026-08-14 已對官方 pricing 頁核實）

| 模型 | 輸入 $/M | 輸出 $/M（含 thinking）| 備註 |
|---|---|---|---|
| gemini-3.7-flash | **0.75**（2027-01-01 起 1.50）| **3.75**（起 7.50）| 促銷至 2026-12-31；無 minimal 檔；無 Live API |
| gemini-3.6-flash | **0.75**（2027-01-01 起 1.50）| **3.75**（起 7.50）| 同促銷（原價 1.50/7.50 已半價）|
| gemini-3.5-flash | 1.50 | 9.00 | 無促銷 |
| gemini-3.5-flash-lite | 0.30 | 2.50 | |
| gemini-3.1-flash-lite | 0.25（音訊 0.50）| 1.50 | |

- **促銷價是限時的**：3.7/3.6 促銷期間名目上比 3.5-flash 便宜一半，2027-01-01 漲回 —
  **成本試算必須標查價日期與適用期間**，用促銷價做的單位經濟在 4.5 個月後失效
- 促銷便宜也要先過 §2 的同料 A/B 才算數：對機械翻譯任務，3.6 是實測踩雷（id 對滑）、
  3.7 是零數據 + 無 minimal 檔（thinking 稅地板墊高，實付未必較便宜）— 帳面單價不等於實付成本
- 換算成本時**輸出佔比**比單價重要（thinking 計輸出價，官方明載）
- **`gemini-3.6-flash-lite` 確認不存在**（models / pricing 頁皆無；3.7 也沒有 lite — lite 級停在 3.5）—
  「聽起來應該有」的 ID 一律先 `GET /v1beta/models` 驗證（kikemu 也踩過：`gemini-3-pro-preview` 曾 404）
- 抄成本表時對準模型級別：kikemu 曾把 3.5-flash 抄成 lite 價（$0.30/$2.50），
  **成本低估 3.6 倍**且一路寫進 PRD 與儀表板（**2026-08-14 已修**，修正+關思考後兩跳 $0.35/hr）—
  牌價永遠附 URL 與查價日期
- **內建價表/單位經濟刻意用牌價，不用促銷價**（sukemu 定的規矩）：保險絲寧可高估；
  要對齊實際帳單用可覆寫的價表變數（如 `MODEL_PRICES`）

## 4. 設定管理陷阱（Cloudflare Workers 特有）

- **git 部署會用 wrangler.jsonc 的 `vars` 蓋掉 dashboard 明文變數**（只有 Secret 倖存）
  → 模型等設定的單一事實來源放 git（sukemu 獨立踩過同一雷，已在 wrangler 註解裡立碑）
- **CF Worker 出口 colo 會變：官方證實香港不在 Gemini API 支援地區**，台灣流量常經 HKG
  → 「User location is not supported」400。重試常有效，但**只因換到別的 colo、並非保證**；
  更穩的做法（CF 社群共識）：檢查 `request.cf.colo`，遇 HKG/受限 colo 改走代理或重排路由；
  Durable Object location hint 也可用；Smart Placement 實測不可靠。
  另：掛了 billing 的 paid tier 據報會放寬部分地區限制
- **未知 generationConfig 欄位 → 400 → 拿掉該欄位重試**是通用防禦
  （我們的 thinkingBudget、sukemu 的 `mediaResolution: HIGH` 都是同款失敗形狀）
- **Live API（WS）的 setup 更兇**：放錯位置的 key 不給 400，直接 **WS 1007 無聲斷線**（manemu 實測）
  → 不要把 generateContent 的 config 直接複製進 Live setup

## 5. 花錢系統的保險絲（架構級，四層）

任何「無人看管 + 會呼叫付費 API + 會重試」的系統，事故公式 = 無人看管 × 花錢 × 重試 × 失敗不可見。

1. **供應商端**：prepay / 日配額上限（程式再錯也燒不破）。
   **官方工具已到位（2026-08 核實）**：新戶強制 prepaid（2026-03 起，$10–$5000 儲值）；
   AI Studio Spend 頁可設**每專案花費上限**（batch 工作可能超收 ~10 分鐘）；
   tier 月上限（Tier 1 $250/月）；spend velocity（Tier 1 $10/10min → 429）；RPD 太平洋午夜重置
   → 第 1 層現在有官方旋鈕，每個專案開工先去設
2. **每步重試上限**：連續 N 次失敗 → 永久標記、只有人工能重啟
3. **每件工作 token 上限**：計數器要**跨重排累計**（重排歸零 = 保險絲被繞過，實際踩過）
4. **全域日預算**：超過 → 暫停非失敗，隔日自動續
+ **花費即時可視**（per-step 落地 tokens、prompt/output/thoughts 拆解）— 看不見的花費才是危險的花費
+ 付費呼叫「先存檔再花下一筆」：checkpoint 化，被砍只損失一步
+ **保險絲的計量單位要對齊計費單位**（manemu 的反面教訓）：它的配額全用「秒」計，
  token 計價的呼叫等於沒有保險絲。正面技巧：自己對使用者的計量單位（牆鐘秒）
  與供應商計費單位（token/音訊秒）刻意錯開，可以創造結構性安全邊際；「沒有輸出就不計費」也是好原則

## 6. 翻譯 pipeline 的品質地板（prompt 是天花板、程式是地板）

- 模型輸出視為敵意輸入：JSON 截斷修復（尾端逐 `}` 回退）、逐句 deterministic fail-fast
  （簡體字形表、原文照抄、長度異常）、崩塌偵測（同譯文 ≥3 次）
- 缺句處理：重試 → 切半分治（對付截斷與毒句）→ 仍缺標 `untranslated` 顯示原文（**可見的失敗**優於沉默）
- 禁用詞三層：prompt 對照表（付 token，精簡）→ 執法掃描（低誤報，觸發重譯）→ 大詞表（僅提示）
- **座標/數值格式指示會被無視 — 主因是 thinking 檔位（v2.4 更正歸因）**：sukemu 實測同一個
  3.6-flash，`low`/`minimal` 一律把座標掉回 0–1000 訓練慣例、`default`/`high` 不會 —
  先前歸咎「lite 比較笨」的框漂移其實是 **thinking 不足的效應**。
  → 規則：**模型不照 prompt 的格式指示時，先檢查 thinking 檔位再換模型**；
  防禦仍然要有（從值域反推實際格式，不要相信宣稱）
- **index-keyed batch JSON 要驗 id，防線三層**：id 連號/範圍/去重檢查（ytplayer `assertIdSanity`，
  重複/亂序整包打回重試）→ **回聲對位**（sukemu：要求每筆帶原文前 8 字的 `t` 欄位回聲，
  對不上丟棄該筆 — 寧缺勿錯）→ 抽樣人工比對（§2 的 id 對滑，自動指標測不到）
- 長工作放對執行環境：CF Worker 的 fetch handler（含 waitUntil）跑不完分鐘級工作，
  只有 scheduled/queue consumer 可以 — Queues 分步自我續鏈 + 冪等 checkpoint 是正解

## 7. 各專案現況（記憶同步區，2026-08-14 各 repo 落地後更新）

| 專案 | 狀態 | Gemini 用法 | 保險絲 | 重點風險/待辦 |
|---|---|---|---|---|
| **ytplayer** | 本 repo，active | text 路由（3.5-flash 思考關）+ video 路由（MEDIUM 300 tok/s）| 四層完備 | ~~id 連號檢查~~ **已實作**（`assertIdSanity`）；~~lite 縮 chunk~~ **已測否決**（E 組，換協定才有救）；~~thinking 改 level~~ **已改**（`thinkingLevel:"minimal"`，`GEMINI_THINKING_LEVEL` var 可調、budget 留 legacy 逃生口；生產 prompt 複驗 507→0）；video 路由刻意維持預設 thinking（reasoning-shaped，程式碼已立碑）|
| **kvsplayer（ytpoc）** | 已併入 ytplayer，待關閉 | 看片配方全數移植 | — | M5 關閉作業 |
| **manemu** | 封測上線 | Live API 為主（3.1-flash-live + 口譯 prompt）；backtranslate 3.5-flash-lite + **minimal + 400 fallback** ✅ | 秒數配額 + **`GLOBAL_DAILY_SECONDS` 全站日預算已實作**（36000s ≈ US$14/日，壞掉時放行不鎖站）；harness 印重試放大倍率 | synth 的 pro fallback 保留但已可視（計數+警示）；**長期守則：未來任何 token 計價功能上線前必補 token 計量**（秒數保險絲對它無效）|
| **sukemu** | active | 3.6-flash 兩段式；**ADR 0002：P1 維持預設 thinking、P2 `minimal`（-81% tokens，var 可調）** ✅ | P1/P2 同套三道門檻：張數 + `DAILY_TWD_LIMIT`（每人每日 TWD）+ `GLOBAL_DAILY_TWD`（全站）✅ | P2 id 防線已上（範圍+去重+t 回聲對位）；內建價表刻意用牌價不用促銷價；10s 目標得從縮短 P1 輸出下手（降 thinking 這條路已確認走不通）|
| **kikemu** | 評測完、產品初期 | 逐句翻譯 3.5-flash，**translate/extractVocab 皆 `minimal` + 400 fallback、researchTerms 保留思考** ✅（`THINKING_LEVEL` var 可調）| `MAX_RETRY_PER_SEQ=3` + `SESSION_TOKEN_CAP` + QUOTA DO 逐日累計 tokens/calls + `/admin` 顯示 thoughts 拆解 + `judge.py` 有 `BUDGET_USD`/`DRY_RUN` ✅ | ~~成本表 lite 價~~ **已修**（真價+關思考後兩跳 **$0.35/hr**，「比一體式貴一倍」說法不再成立）；全域日上限尚未設值（計數已在）；AI Studio Spend 頁上限要人工去設 |

## 參考（查價/查規格入口，2026-08-13）

- 定價：https://ai.google.dev/gemini-api/docs/pricing
- Thinking（level 預設表）：https://ai.google.dev/gemini-api/docs/thinking
- 模型清單：https://ai.google.dev/gemini-api/docs/models
- 支援地區：https://ai.google.dev/gemini-api/docs/available-regions
- 帳務/花費上限：https://ai.google.dev/gemini-api/docs/billing
- 速率限制：https://ai.google.dev/gemini-api/docs/rate-limits
