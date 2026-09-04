# 清單頁的規模上限（觸發式待辦）

> 狀態：**已量測、已延後**。並行讀已上線（2026-09-04），目前 34 支 1.7 秒可接受。
> **觸發條件：影片數接近 100，或 `/videos.json` 超過 3 秒** —— 到了再做，別提早做。
> 決策欄在 §5。

## 1. 起因與現況

使用者回報「第一次開站一直 loading」。量出來：

```
/            HTML 骨架 <0.5s（所以看到的是頁面上的「載入中…」）
/videos.json TTFB 8.2 / 5.6 / 5.0 秒   ← 不是冷啟動
```

成因：`listVideos` 對每支影片 **await 一次 R2 GET**（`subs/{id}/info.json`），
34 支就是 34 趟來回。改成**分批並行**（一批 `LIST_CONCURRENCY = 10`）後：

| | 之前 | 之後 |
|---|---|---|
| `/videos.json` | 5–8s | **1.7–2.1s** |

`/jobs.json`（儀表板）同一個病、同一個修法，而且它更貴 ——
舊片要回填計數就得讀 `bilingual.json`（好幾 MB）。

## 2. 但這只改了常數，沒改複雜度

還是 O(N) 次 GET，只是變成 ⌈N/10⌉ 趟。單次 R2 來回實測 **0.29–0.52 秒**：

| 影片數 | 批數 | 推估 |
|---|---|---|
| 34（現在）| 4 | **1.7s**（實測）|
| 100 | 10 | ~4.3s |
| 300 | 30 | ~13s |

**約 100 支開始會再度難用** —— 那就是動工的訊號。

## 3. 修法：R2 customMetadata + 一次 `list()`

寫 `info.json` 時把摘要（title / channel / cueCount / generatedAt）一併寫進
**customMetadata**；讀清單時：

```js
list({ prefix: 'idx/', include: ['customMetadata'] })   // 一趟來回，最多 1000 支
```

- Workers R2 API 支援 `include: ['customMetadata']`，需要
  compatibility date ≥ `2022-08-04`（本專案是 `2026-07-01`，沒問題）
- ⚠ **帶 metadata 時單次回傳筆數會變少** —— 一定要照 `truncated`/`cursor` 分頁，
  **不能**用「回傳數 < limit」判斷結束（官方文件明講）
- 舊資料沒有 metadata → 退回讀那一支的 `info.json` 並順手補寫（自癒），
  跟現在 `info.json` 的回填是同一個模式
- 用獨立的 `idx/{videoId}` 空物件當索引，一支影片一個 key，
  1000 支才需要第二次 list（掛在 `subs/` 前綴下的話一支有 7–8 個檔，會提早分頁）

## 4. 為什麼**不是**單一 `list.json`

直覺的做法是維護一份 `list.json`，但它是 **read-modify-write**：
兩支影片同時翻完 → 各自讀舊的、各自寫新的 → 後寫的把前一個蓋掉。
queue 的 `max_concurrency` 是 2，加上隨時可能 ingest，這個競態會發生。

而且它**安靜地錯**（清單少一支，沒有任何錯誤訊息）—— 正是 CLAUDE.md 硬規則 #7
要避免的那類失敗。customMetadata 的做法沒有共享可變文件，
每支影片只寫自己那個 key，結構上就沒有這個問題。

其他考慮過的：

| 方案 | 為什麼不 |
|---|---|
| 單一 `list.json` | 見上：read-modify-write 競態，且安靜地錯 |
| 提高 `LIST_CONCURRENCY` | 只是把常數再壓一次，治標；而且要先確認 Workers 對 R2 binding 的並行上限 |
| 快取 `/videos.json` | 剛 ingest 的片不會出現，使用者會以為壞了 —— 這種困惑比慢兩秒糟 |
| 分頁／無限捲動 | 自用規模不需要 UI 複雜度；而且第一頁還是要讀 N 筆才排得了序 |

## 5. 決策

```
決策：**先不做**（2026-09-04）—— 34 支 1.7 秒可接受
觸發條件：影片數接近 100，或 /videos.json 超過 3 秒
到時候做什麼：§3（customMetadata + 一次 list），約半天
理由：現在做要改 assemble 的寫入路徑 + 回填全部舊片，
   而收益只有 1.7s → 0.5s。等真的痛了再做，回填成本也還好
```

> 重量方式（別重新發明）：
> `curl -o /dev/null -H "x-ingest-key: …" -w "%{time_starttransfer}\n" https://…/videos.json`
> 連打四次取穩定值；順便量一支 `info.json` 當「一次 R2 來回」的基準。
