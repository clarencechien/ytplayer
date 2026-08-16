# Migration：kvsplayer 併入 ytplayer（方案 A 執行計畫）

> 決策已定（2026-08-13）：**方案 A 完全合併，以 ytplayer 為基底，完成後關閉 kvsplayer**。
> 前提變更：Workers **Paid 已付**（$5/月）→ Queues 可用，任務驅動不再受免費方案限制。
> 本文件 = 完整設計 + 分階段執行 + 驗收 gate + 需要人工操作的清單。
> 相關：[kvsplayer-merge-todo.md](kvsplayer-merge-todo.md)（決策材料）、
> [asr-language-experiment.md](asr-language-experiment.md)（ASR 閘門依據 + 成本事故 §4.2）。

---

## 0. 設計原則（從事故學來的，全案適用）

1. **無人看管的組件（cron、queue retry）單次決策成本必須為零** — 花錢步驟一律過保險絲
2. **先存檔後花更多錢**：每個花錢步驟完成即落地 checkpoint，被砍只損失一步
3. **失敗必須可見**：開工即寫狀態，每步更新 — 「沒被選中」與「選中後死掉」要能分辨
4. **重試必須有界**：任何自動重試都有次數上限，超過即永久標記失敗、只有人工能重啟

## 1. 統一 Tier 路由表（合併後的核心）

輸入判定改為「路由」概念，每支影片走 `text`（純文字翻譯）或 `video`（Gemini 看片）之一：

| Tier | 情境 | 路由 | 說明 |
|---|---|---|---|
| 1 | 有人工 zh 軌 | `native`（預設）| 提示用 YouTube 原生；不滿意時 ingest 原文軌 → 走 `text` 重做 |
| 2 | 人工原文 CC | `text` | 既有主路徑，不變 |
| 3（各語言 ASR）| 僅 ASR，任何語言 | `text`（**閘門開放**）| 修稿 pass（sourceLang 感知）→ 翻譯。實驗已證明 `variant=gemini` 世代的 ASR 內容正確性高、錯誤集中在專有名詞＝修稿標的。**這格吃掉大部分情況** |
| 3（字卡型）| ASR 有，但**畫面字卡承載語意**（韓綜）| `video`（**使用者手動選**）| ASR 聽不到字卡。字卡重不重要機器判不了 → ext popup / admin 頁提供「看片模式」選項 |
| 4 | 無任何 CC | `video`（唯一選項）| kvsplayer 原本的主場 |
| 紅線 | `tlang` 自動翻譯軌 | 永不輸入 | 不變 |

- `canTranslate` 重構為 `route(source, opts): 'text' | 'video' | 'native' | 'reject'`
- `video` 路由**永遠是明示選擇**（成本差 ~30 倍：MEDIUM 300 tok/秒，30 分鐘 ≈ 54 萬 token），
  唯 Tier 4 在 UI 上主動建議它
- `.allow-any-asr` 標記制**廢除**（它是事故共犯）：路由是確定性規則，不再有旁路豁免檔

### schema v2（兩邊資料統一）

```jsonc
// bilingual.json v2
{
  "videoId": "...", "schema": 2,
  "sourceLang": "ja",
  "trust": "cc" | "asr-repaired" | "model",   // 時間軸與原文的信任等級
  "route": "text" | "video",
  "cues": [
    { "start": 1.2, "end": 3.4, "kind": "speech" | "card",
      "orig": "原文", "zh": "譯文", "note": "詞：解釋", "untranslated": true? }
  ]
}
```

- `orig` 取代 `en`/`ko`；`kind` 來自 kvsplayer（text 路由全是 `speech`）
- `trust: "model"`（video 路由）→ player 可提示「時間軸為模型估算」
- 舊資料轉換器：ytplayer v1（`en/zh`）與 kvsplayer（`ko/zh` + `kind`）各寫一個，讀取端只認 v2

## 2. 執行架構：全面改 Queues（採 kvsplayer 已驗證的形狀）

### 為什麼是 Queues 而不是 Workflows

兩者都能解「長工作 + checkpoint + 有界重試」。選 Queues 因為：
kvsplayer 的「1 訊息 = 1 小步、做完落地、自我續鏈、`max_retries: 3`、毒段縮小重試階梯、
`covered_s` 截斷接續、token 計數」**已經是量產驗證過的完整配方**，移植 = 翻寫成 TS + 加測試；
改 Workflows 等於今天要把這套控制流重新架構一次，風險高於收益。
（Workflows 記為候補：若未來 Queues 維運出現痛點，狀態機/重試/狀態查詢它都是原生的。）

### 任務形狀

一個 queue（`ytplayer-jobs`），訊息 = `{videoId, step, ...}`，consumer 一次處理一步，
做完寫 checkpoint + 更新 `status.json`，再 enqueue 下一步：

```
text 路由:  plan → repair:0..N（僅 ASR；每步 ≤4 chunks）→ glossary
            → translate:0..N（每步 ≤4 chunks ≈ 160 cues，~1 分鐘）→ assemble
video 路由: plan → watch:0..N（3 分鐘/段，kvsplayer 原樣）→ assemble
```

- 每步工作量壓在 1–2 分鐘內（遠低於 consumer 上限），被砍只損失一步、重試只重付一步
- `sentences.json`（repair 後）與 `glossary.json` 本來就是天然 checkpoint；translate 步的
  中間產物存 `parts/translate_NN.json`
- **fetch handler 從此不跑任何 LLM 工作**（實測它跑不了）：`/translate` 只 enqueue + 202；
  `?wait=1` 廢除
- **cron 降級為零成本看門狗**：掃 R2 找「pending 且無活躍 job」→ enqueue `plan`，本身不碰 LLM。
  ext ingest 成功時由 `/ingest` 直接 enqueue（cron 只是漏接保險）

### status.json（每片、可公開讀，取代 last-run.json）

```jsonc
{ "stage": "translate", "step": "3/7", "startedAt": "...", "updatedAt": "...",
  "attempts": 2, "tokensUsed": 123456, "estCostNTD": 3.2,
  "failed": false, "failReason": null }
```

開工即寫、每步更新 — 這次事故「全程隱形」的直接解。

## 3. 花費保險絲（四層，缺一不可）

| 層 | 機制 | 擋什麼 |
|---|---|---|
| 1 外部 | **Google 端日配額上限 + 預算警報**（人工設定，見 §8）| 我們沒想到的一切 bug |
| 2 每步 | Queues `max_retries: 3` → 超過寫 `failed: true` + `failReason`，**永不自動重試**，只有 `?force=1` 能重啟 | 毒段/毒 chunk 無限重試 |
| 3 每片 | `status.tokensUsed` 累計（kvsplayer 已有），超過每片上限（text 20 萬 / video 200 萬 token，可調）→ 中止標記失敗 | 單片失控（開放式掃描、截斷循環） |
| 4 全域 | R2 `budget/YYYY-MM-DD.json` 日計數器，consumer 每次 LLM 呼叫前檢查、後累加；超過日上限（預設 ~NT$100 等值 token）→ 當日拒開新工作，`/health` 顯示 | 多片同時失控、以及第 2、3 層自己的 bug |

## 4. Player 聯集（ytplayer 為基底）

kvsplayer 的 274 行靜態 player 退役，其內容併入 ytplayer player：

1. **cardLayer**：`kind === "card"` 的 cue 疊在畫面上緣、短促字卡樣式（與下方 speech 字幕層分離）；
   字幕模式選單加「字卡開/關」
2. **kind 感知逐句稿**：transcript 中 card 標示圖示
3. `trust: "model"` 的片顯示「⏱ 時間軸為模型估算」小提示
4. 韓中「不同級」、英中「同級」變成依 `sourceLang` 的預設 + 可切換
5. 舊連結相容：`/?v={id}` → 302 `/watch/{id}`
6. kvsplayer 沒有的（熱鍵、手機 RWD、原生 CC 關閉、welcome、透明度/速度）合併後**自動獲得**

### 播放「卡卡」的修法（timestamps 是主因）

video 路由時間軸是模型估算，目前只 clamp 到段界 → 疊字、閃爍、對不上嘴。移植時加確定性後處理：

- cue 排序後**強制單調不重疊**（重疊時後推 start）；最短顯示 0.3s；speech 上限 15s（原有）
- 段界縫合：跨段重複句（原 dedup 規則）合併並取聯集時間
- player 端本來就有 150ms 輪詢 + 二分搜尋 + 1.5s 寬限，比 kvsplayer 原 player 平滑

## 5. 隱私與搜尋引擎（artifacts 事件的預防）

現況風險盤點：`/watch/{id}` 與 `/subs/{id}/*` 是公開的（連結可分享是既定決策）。
Claude public artifacts 的教訓是：**「沒有連結就沒人知道」不成立** — 只要 URL 曾出現在任何
可爬到的地方（貼文、referrer、聚合器），Google 就會索引，然後「我看過/翻過哪些影片」變成可搜尋的。

對策（全部進 M0，一次做完）：

1. **所有回應加 `X-Robots-Tag: noindex, nofollow, noarchive`**，HTML 再加
   `<meta name="robots" content="noindex">` — 這是 artifacts 事件後 Anthropic 採用的同一帖藥
2. **robots.txt 不要 Disallow**（陷阱：擋了爬取，爬蟲就**看不到 noindex**，URL 仍可能以
   「無內容連結」形式進索引）。正確組合 = 允許抓 + noindex 宣告
3. 清單頁維持 key-gate；`?key=` 進頁即轉存 localStorage 並 `history.replaceState` 清掉
   （已實作）— key 永不出現在可被記錄的 URL 上
4. 已接受的殘餘風險（記錄在案）：videoId 可枚舉，任何人可探測 `/subs/{id}/info.json` 200/404
   得知「某支影片有沒有被我翻過」。自用容忍；若未來介意，升級為 watch/subs 也要 key + 每片分享 token
5. 合併後的 `/admin`（video 路由貼連結頁）沿用 kvsplayer 的 **Cloudflare Access（Google SSO）**，
   path 範圍鎖 `/admin/*`；API 寫入維持 key。兩種認證並存，規則：**人用 Access、程式用 key**

## 6. kvsplayer 內容移植清單（全部 TS 化 + 測試）

| 資產 | 去處 | 移植時修的「卡卡」 |
|---|---|---|
| Gemini 看片呼叫（`fileUri` + `videoMetadata` offset、3 分鐘/段、MEDIUM）| `worker/src/watch.ts` | — |
| 分段掃描階梯（`covered_s` 接續、`try_len` 縮段重試、open 模式 CAP=60）| 同上 | 重試納入 §3 保險絲 |
| JSON 截斷修復（尾端逐 `}` 回退）| 已與 ytplayer `cleanJson` 同構 → 合一 | — |
| 確定性清洗（card/speech 去重、15s cap、名牌排除規則）| `worker/src/cues-clean.ts` | 加單調不重疊 + 段界縫合（§4）|
| genre glossary 40 詞 + 頻道譯名鎖定表 | R2 `glossary/channel-{id}.json`，與 per-video 自動抽疊加（鎖定表優先）| ytplayer Phase 4 本來就要這個 |
| innertube 多 client 嘗試 | **降級為 fallback**：合併後韓文片也能用 ext ingest（自己的 IP，拿到真 metadata/軌清單），admin 貼連結才走 innertube 碰運氣 | 「各 client 都抓不到」的挫折大減 |
| 成本計數（`tokens_used`）| `status.json.tokensUsed`，全路由統一 | 升級成 §3 的三、四層保險絲 |
| Cloudflare Access 認證 | `/admin` 沿用 | — |
| R2 `kvs-krsub` 既有資料 | 轉 schema v2 → `ytplayer-subs`（§7 M4）| — |

## 7. 執行階段（今天開跑，每階段有 gate）

### M0 — 隱私加固（獨立、最小、先出）
noindex 全域 header + meta、robots.txt。**Gate**：`curl -I` 看到 `X-Robots-Tag`。

### M1 — 地基：Queues + 保險絲 + text 路由搬家
queue 綁定、step 訊息協定、`status.json`、四層保險絲（2–4）、text pipeline 拆步、
cron 降級看門狗、`/translate` 只 enqueue、schema v2 + 轉換器。既有 69 測試遷移 + 新增 step/保險絲測試。
**Gate**：一支英文片走新路徑全綠；手動注入毒 chunk 驗證「3 次後永久失敗且可見」。

### M2 — 開 ASR 閘門 + 日文端到端
路由表上線（`.allow-any-asr` 廢除）。**Gate**：`9gHJwbSHPus` 日文 ASR 686 cues 跑完，
驗證修稿把 `Zold8` 修回 `Z Fold8`（懸案結案）、字幕正常播放。

### M3 — video 路由移植 + player 聯集
watch.ts / cues-clean.ts + 測試（拿 ytpoc R2 既有段落產物當 fixture）、cardLayer、
admin 頁 + Access、genre glossary。
**Gate**：一支韓綜從 admin 貼連結 → 看片 → `/watch` 播放，字卡疊層正常、成本落在 status 可見。

### M4 — 資料遷移 + 轉址
`kvs-krsub` 全量拉出 → schema v2 → 寫入 `ytplayer-subs`；`/?v=` 302；
kvsplayer.ai-apps.work DNS 指向 ytplayer（或加 301 轉址）。
**Gate**：抽 3 支舊韓綜在 ytplayer 正常播放（含字卡）；舊連結可達。

### M5 — 關閉 kvsplayer（**2026-08-14 完成，合併結案**）

程式面：移除 KVS 綁定、刪除 `migrate.ts` 與其路由/測試；看片譯名表改為
「R2 有自訂版就用、否則用 repo 內建 `src/data/watch-glossary-ko.json`」——
不再依賴任何一次性匯入動作。

人工面（已執行）：kvsplayer Worker 與 `kvs-jobs` queue 已刪除。
`kvs-krsub` bucket 依保險原則保留 30 天（2026-09 中旬後可刪）；ytpoc repo 封存為選配。

**合併專案至此結案** — 之後的工作都是 ytplayer 自身的演進，不再有跨專案遷移項目。

## 8. 需要你操作的清單（程式碼做不到的）

| 時機 | 操作 | 位置 |
|---|---|---|
| **現在就設** | Gemini API 日配額上限 + 預算警報（§3 第 1 層）| Google AI Studio / Cloud Console → Quotas |
| M1 前 | 建 queue `ytplayer-jobs` | CF Dashboard → Queues → Create |
| M1 前 | 確認 ytplayer Worker 在 Paid plan 下（Queues 綁定 build 才會過）| Dashboard → Worker → Settings |
| M3 前 | Cloudflare Access 建 `/admin/*` policy（沿用 kvsplayer 的 email 白名單）| Zero Trust → Access |
| M4 | kvsplayer.ai-apps.work DNS 改指 ytplayer | DNS |
| M5 | ~~刪 kvsplayer Worker + queue~~（**已做**）；30 天後刪 `kvs-krsub`；封存 ytpoc | Dashboard / GitHub |
| 各階段 | 合併 PR 觸發部署（Workers Builds 跟 production branch）| GitHub |

## 9. 明確不做 / 已否決

- ~~本機 CLI 跑 pipeline~~：Paid + Queues 已解執行時限，維持「ingest 完不用管」的全自動 UX
- ~~Workflows~~：候補，理由見 §2
- ~~`.allow-any-asr` 標記~~：廢除，路由確定性化
- ~~混合路線（ASR 翻語音 + 看片只抓字卡）~~：成本誘人（字卡段落遠短於全片）但對齊複雜，
  記入 future work，等 video 路由穩定後評估
- 韓文 ASR 文字路線：**不主動開**（未量測）。韓綜走 video 路由本來就繞過這題；
  若遇到「無字卡的韓文教學片」再拿它當樣本量測
