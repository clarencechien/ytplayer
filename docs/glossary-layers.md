# Glossary 疊層計畫（channel / genre / per-video）

> 狀態：**計畫，未實作**。決策欄在 §8。
> 起因：2026-08-13 合併 kvsplayer 後盤點發現 glossary 是「兩套制度並存 + 一個缺口」。

---

## 1. 現況（兩套並存）

| 路由 | 來源 | 範圍 | 生命週期 |
|---|---|---|---|
| text（主路徑） | 每次 run 的 Step B：LLM 從**該支影片**內文自動抽 ≤60 條（顯示形式 + 白話註解） | **by video** | 當次有效（`subs/{id}/glossary.json`），下支影片重抽 |
| video（看片） | R2 `glossary/watch-ko.json`（kvsplayer 遷入的 59 條），prompt 內「強制鎖定」 | **by language 全域** | 靜態人工維護 |

`watch-ko.json` 實際上是兩種東西混裝（kvsplayer 單一節目所以沒事）：
- **genre 通用詞** 40 條：忙內、前輩/後輩、字卡、戲份、剪輯…任何韓綜都成立
- **頻道譯名鎖定** 19 條：特定節目的人名/專名

## 2. 缺口與實際後果

1. **同頻道跨影片不一致**：text 路由每支重抽、無記憶 — 同一頻道的同一術語，兩支影片可能翻出兩種樣子
2. **好的翻譯決定無法沉澱**：某支影片抽出了很棒的譯法，下一支它就消失了
3. **混層無法演化**：video 路由的鎖定表不分頻道，多頻道時會把 A 節目的人名塞進 B 節目的 prompt（token 浪費 + 偶爾誤導）

## 3. 疊層設計

```
優先序高 → 低（同 term 衝突時上層贏）
① channel 鎖定表   glossary/channel-{key}.json    人名/節目專名/頻道慣用譯法，人工養
② genre 通用表     glossary/genre-{lang}.json     跨頻道通用（韓綜詞彙、日系 3C 用語…）
③ per-video 自動抽 （現有 Step B，不變）          當片專有詞的最後一道網
```

- **兩路由同源**：text 的翻譯 prompt 術語表 = merge(①, ②, ③)；video 的看片 prompt 鎖定表 = merge(①, ②)
- merge 規則：term 正規化（大小寫/全半形）後比對，上層贏；合併總量設上限（~80 條，超過先砍 ③ 的低頻詞）— 每 chunk 都付 prompt token，表不能無限長
- 現有 `watch-ko.json` 拆遷：40 條 → `genre-ko.json`、19 條 → 對應節目的 `channel-{key}.json`

### channel key 的現實問題

`source.json` 的 meta 只有 **channel 名稱字串**（ext 未抓 channelId/ucid）。名稱可改、可重複，
但自用場景可接受：**先用名稱 slug 當 key**（`channel-トバログ.json`），ext 補抓 ucid 列入 §7 G3。
video 路由（admin 貼連結）沒有 channel meta → 只吃 ②，channel 表由人工在表單指定（G2 加欄位）。

## 4. 資料格式

```jsonc
// glossary/genre-{lang}.json — 陣列，與現行 watch-ko.json 同形
[{ "term": "막내", "zh": "忙內", "note": "團體/劇組最年幼者" }]

// glossary/channel-{key}.json
{
  "channel": "トバログ",          // 顯示名（比對用）
  "lang": "ja",                  // 主要原文語言（僅記錄）
  "entries": [{ "term": "Galaxy Z Fold8", "zh": "Galaxy Z Fold8", "note": "產品名照抄不譯" }]
}
```

`term` 一律存**原文**（text 路由拿原文句子比對、video 路由給模型鎖定），`zh` 是強制顯示形式。

## 5. 掛載點（實作備忘）

| 位置 | 改動 |
|---|---|
| `jobs.ts` glossaryStep | 讀 ①②（R2 兩個 get，miss 就空表）→ 與 ③ 自動抽合併後寫入 `subs/{id}/glossary.json`（**含層來源標記** `layer: "channel"|"genre"|"auto"`，除錯用） |
| `jobs.ts` translateStep | 不變（讀合併後的 glossary.json） |
| `jobs.ts` watchStep | glossary 字串改為 merge(①, ②)（現在只讀單檔） |
| `prompts.ts` | 不變（吃合併後的表） |
| 快取鍵 | glossary.json 已標 `sourceUploaded`；①② 更新後要重翻需 `?force=1`（表變更不自動觸發重翻 — 便宜、可預期） |

## 6. 養表流程

- **初期（G1）**：直接手編 R2 物件（dashboard 連結到現有檔案方便看）
- **G2**：admin API `PUT /glossary/{scope}`（key 認證）+ 儀表板編輯畫面；
  加「⬆ 收進頻道表」：在 player/儀表板看到 ③ 自動抽的好譯法，一鍵提升為 ① 的永久條目
- 原則：**③ 是苗圃、① 是倉庫** — 自動抽負責發現，人工提升負責沉澱

## 7. 實作階段

| 階段 | 內容 | Gate |
|---|---|---|
| **G1** | 拆遷 watch-ko.json → genre/channel 兩檔；glossaryStep/watchStep 讀取合併（含優先序與上限）；測試 | 同頻道兩支影片，channel 表術語譯法一致；video 路由 prompt 含合併表 |
| **G2** | `PUT /glossary/{scope}` + 儀表板編輯 + 「收進頻道表」按鈕；watch-job 表單加 channel 欄 | 從儀表板提升一條 ③ → 下次重翻該頻道影片時生效 |
| **G3**（選作） | ext 抓 channelId（ucid）穩定鍵值 + 既有 channel 檔改鍵遷移 | 頻道改名不影響鎖定表 |

工作量：G1 約半天內、G2 約半天、G3 小。

## 8. 決策（人工填寫）

```
決策：____（G1 先做 / G1+G2 一起 / 先不做，被不一致煩到再說）
日期：____
理由：____
```
