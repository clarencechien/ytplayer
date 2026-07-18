# Phase 2 實作計畫：翻譯 Pipeline（核心價值，先計劃再動手）

> 依據：handoff §4、append-01 §E/§F（**只處理 Tier 2**）、開發原則 #1/#2。
> 目標：品質高於 YouTube 內建自動翻譯的道地台灣正體中文，全片術語一致，零中國用語。

---

## 1. 跑在哪裡（決策）

**跑在同一個 `ytplayer` Worker**，新增 key 保護的觸發端點。理由：

- R2 綁定、部署管線、secret 管理全部現成，push 即部署
- LLM 呼叫是 I/O 等待，不吃 Worker CPU 限額；同步處理（client 等 1–2 分鐘）對自用完全夠
- 不用 Queues（handoff §7 有提，但 POC 階段同步就好 — 原則 #3：每個 Phase 能獨立停下）

模型：**Gemini Flash**（handoff §7 成本考量）。
- secret：`GEMINI_API_KEY`（AI Studio 取得）
- 模型名用 wrangler var `GEMINI_MODEL`，預設 `gemini-flash-latest`（官方 alias，不 pin 舊版號；要指定再改）

## 2. 端點

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/translate/{videoId}` | 跑完整 pipeline。`?force=1` 忽略 cache 重跑。tier ≠ 2 → 422 拒絕 |
| GET | `/subs/{videoId}/bilingual.json` | 翻譯結果（player 頁用） |
| GET | `/subs/{videoId}/bilingual.srt` | 中英雙行 SRT（丟桌面播放器驗收用） |
| GET | `/subs/{videoId}/glossary.json` | 術語表（檢查一致性用） |

Cache key：`(videoId, track.languageCode, model, promptVersion)` 寫進 `bilingual.json`；
命中且無 `force=1` → 直接回舊結果。改 prompt 必改 `promptVersion`。

## 3. Pipeline 步驟

### Step A — 重新斷句（deterministic，不用 LLM）

- cue 合併成句：以「句末標點（. ! ? …）+ 下一 cue 首字大寫」為主要邊界，輔以時間 gap（> 2s 硬切）與長度上限（約 60 詞硬切防跑飛）
- 保留 `cueIds` 映射（翻完要映回時間軸）
- Tier 2 輸入有完整標點（人工 CC），deterministic 規則足夠；ASR 修稿分支已移出（Phase 2.5）
- 輸出 `sentences.json` 存 R2：`[{ id, text, cueIds }]`

### Step B — Glossary Pass（1 次便宜呼叫）

- 輸入：全片句子 + 影片 meta（標題/頻道/簡介）
- 抽：人名、公司/產品名、領域術語、縮寫展開
- 輸出 `glossary.json`：`[{ term, suggested_zh, note }]`（`suggested_zh` 可以是「保留英文」）
- **注入後續每個 chunk 的 prompt**（全片術語一致的唯一手段）

### Step C — 分塊翻譯

- chunk：40 句；前後 overlap 各 2 句（只當上下文，輸出丟棄）
- 每個 chunk prompt 注入：影片 meta + glossary + overlap
- 並發 4（subrequest 保守；20 分鐘影片約 3–6 chunks）
- Prompt 要求（handoff §4.4 全文照辦）：台灣正體、禁用詞對照表、避免翻譯腔、專有名詞保留英文、`note` 譯註（20 字內）、輸出純 JSON `[{id, zh, note?}]`

### Step D — Deterministic 驗證與組裝（品質地板）

模型輸出視為敵意輸入：

1. JSON parse：先原樣 → 失敗則剝 markdown fence / 前後雜訊再試 → 再失敗重打該 chunk（最多 1 次）
2. id 檢查：缺 id / 多 id / 對不上 → 重打該 chunk 一次，仍錯 → 該句 fallback 填英文原文並標 `untranslated: true`
3. **禁用詞掃描**（程式端 hard check，詞表與 prompt 相同）：命中 → 重打該 chunk 一次 → 仍命中則記錄在回應的 `warnings`（驗收要求零命中，warnings 非空就是沒過）
4. 映回時間軸：句子 zh 對應到其 `cueIds` 的時間範圍 → `bilingual.json` cues：`{ start, end, en, zh, note? }`
5. 產 `bilingual.srt`（中上英下兩行）

回應：`{ ok, stats: { sentences, chunks, retries, glossaryTerms, warnings, tokensIn/Out(粗估), elapsedMs } }`

## 4. R2 檔案佈局

```
subs/{videoId}/source.json      （Phase 1）
subs/{videoId}/sentences.json   （Step A）
subs/{videoId}/glossary.json    （Step B）
subs/{videoId}/bilingual.json   （Step D，含 promptVersion/model）
subs/{videoId}/bilingual.srt    （Step D）
```

## 5. 測試策略

- 斷句（Step A）：真實 fixture 單元測試（已有 SpaceX 707 cues；斷句邏輯與 tier 無關可先測）
- 驗證/組裝（Step D）：mock LLM 輸出（正常 / 缺 id / 帶 fence / 含禁用詞）測清洗路徑
- Prompt 品質：**無法單元測試**，靠驗收流程 — 這是 handoff 說「整個專案最重要的驗收點」

## 6. 驗收（handoff §4，過不了就停下調 prompt）

1. 挑三支**你真的想看**的 Tier 2 影片（建議：技術演講 / 財經訪談 / 半導體製造）ingest + translate
2. 與 YouTube 內建自動翻譯並排比對（可開 YouTube 自動翻譯截圖對照 bilingual.srt）
3. 回答：**好到值得自己維護一套系統嗎？**
4. 全片術語一致檢查（glossary.json 對照全文）
5. 禁用詞掃描零命中（stats.warnings 必須為空）

## 7. 需要你做的（動工前）

1. **設好 `INGEST_KEY`**（上次還沒成功 — 位置是 Worker → Settings → Variables and Secrets，
   不是 Builds 的 environment variables；設完 health 的 `ingestKeyConfigured` 要變 `true`）
2. **`GEMINI_API_KEY` secret**：AI Studio（aistudio.google.com）拿 API key，同一個地方加 Secret
3. **ingest 一支 Tier 2 影片**（例如 Phase 0 那支 Claude 頻道 `ksfm6jeTg3Q`，或任一支有官方英文 CC 且你想看的）
   — pipeline 只吃 Tier 2，現在 R2 裡只有 Tier 3 的 SpaceX
4. （建議）GitHub repo 轉 private
