# 字幕時間軸：病因與修法（A 治本 + B 治標，含存量修正鈕）

> 狀態：**已實作**（2026-08-13，與本文件同一個 PR）。
> 症狀：ASR 來源的影片「翻得不錯但時間點不準」「字幕太快消失、語音還在繼續」。

---

## 1. 病因（有證據）

以真實 capture（`worker/test/fixtures/json3-asr.json`）驗證：

1. **ASR 的 json3 有逐詞時間戳**：每個 cue 的 `segs[]` 帶 `tOffsetMs`
   （`When`→0ms、`you're`→120ms、`dealing`→240ms…）。**但 ext 的 normalize 把 segs
   串成純文字時丟掉了逐詞時間**，只留 cue 級 start/dur。
2. **邊界量化誤差（時間點不準的根源）**：斷句合併只能落在「cue 邊界」上。ASR cue 是碎片，
   常常「前半是上一句的尾、後半是下一句的頭」，整個 cue 只能判給一句 —
   誤差上限 = 一個 cue 的長度（1–4 秒）。
3. **句間空隙（太快消失的根源）**：句子顯示結束 = 末 cue 的 `start+dur`，ASR 的 dur
   不保證等於語音真正結束；句與句之間一有空隙字幕就先消失。player 原有 +1.5s 寬限不夠。

不採用的路：抓音檔做 forced alignment（成本/依賴都重）；LLM 對時（看片路線 `trust: model`
的弱點，不能拿弱點當藥）。

## 2. 修法

### A. 治本 — 把逐詞時間撿回來（詞級斷句）

| 層 | 改動 |
|---|---|
| `ext/normalize.js` | ASR cue 保留 `segs: [[offsetSec, word], …]`（相對 cue start；單 seg 的人工軌不帶，payload 不變胖） |
| `worker/src/validate.ts` | `Cue.segs?` 選填驗證 |
| `worker/src/segment.ts` | 合併模式下，cue 帶 segs → **詞流斷句**：句界落在「詞」上（句尾標點/2 秒詞間 gap/長度上限），句子自帶 `start/end`（詞級精度）。無 segs 的軌與 line 模式（歌詞）走原路 |
| `worker/src/pipeline.ts` | `assembleBilingual` 優先用句子自帶的 start/end |

**限制：舊 source 沒有詞資料 — A 只對「重新 ingest（ext 更新後）」的影片生效。**

### B. 治標 — 顯示鏈接（chaining）＋最短顯示時長

業界常規（Netflix 式）：句尾自動延伸到下一句開始（有上限）＋依譯文長度的最短顯示時間。
Deterministic 純函式 `retimeCues`（`worker/src/retime.ts`）：

- 與下一句有空隙 → `end = min(下一句 start − 0.05, end + 3s)`
- 最短顯示：`end ≥ start + clamp(0.9 + 0.05×中文字數, 1.0, 6.0)`（不越過下一句）
- 末句 +1.5s；`kind === "card"`（字卡）不動 — 字卡的短促是刻意的
- **冪等**：套兩次結果不變 — 可以放心重按

掛載點（三處，涵蓋新舊與例外）：

1. **新 run 內建**：text/video 兩路由的 assemble 寫出前先 retime — 之後的影片天生正確
2. **存量修正鈕**：`POST /retime/{videoId}`（key 認證，**零 LLM、不重跑翻譯**）—
   讀 bilingual.json（v1/v2 皆可）→ retime → 寫回 + 重生 SRT + 記 `retimedAt`。
   admin 儀表板每列有「⏱ 修時間」鈕
3. **player 兜底**：載入後對 speech cue 做輕量 chaining（+2s cap）— 沒按過鈕的舊片也立即改善

## 3. A/B 的分工

| | 邊界不準（起訖點錯） | 太快消失 |
|---|---|---|
| A 詞級斷句 | **根治**（句界貼齊語音） | 部分改善（end 較準） |
| B chaining | 無解（只是遮掉） | **根治** |

兩者疊加：B 先無條件生效（含全部存量），A 隨重新 ingest 逐片替換為精準時間。

## 4. 驗收

- [x] normalize 測試：真實 ASR fixture 產出的 cue 帶 segs 且 offset 遞增
- [x] segment 測試：一個 cue 內含句界 → 兩句的 start/end 落在詞級 offset 上
- [x] retime 測試：空隙鏈接有上限、最短時長、不重疊、字卡不動、冪等
- [x] assemble 整合：新 run 輸出即為 chained 時間
- [ ] 實地：對舊片按「⏱ 修時間」→ 播放不再提早消失（部署後人工驗）
- [ ] 實地：ext 更新後重 ingest 一支 ASR 片 → 句界貼齊語音（部署後人工驗）
