# Glossary 疊層計畫（channel / genre / per-video）

> 狀態：**G1 + G3 已實作**（2026-08-16，`worker/src/glossary.ts`）；G2（儀表板編輯 + 一鍵提升）未做。
> 起因：2026-08-13 合併 kvsplayer 後盤點發現 glossary 是「兩套制度並存 + 一個缺口」。
> 實作與本文的差異記在 §7.1，決策欄在 §8。

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

### channel key 的現實問題（已解，但兩種鍵值要並存）

原本 `source.json` 的 meta 只有 **channel 名稱字串**。名稱可改、可重複 —— G3（= future-ideas F4）
已讓 ext 補抓 `videoDetails.channelId`（`UC…`），**新 ingest 一律有 ucid**。
但舊 source 沒有這欄，所以查找是**兩種鍵值並存、ucid 優先**：

```
channelKeys(meta) = [ meta.channelId（驗過 /^UC[\w-]{22}$/）, slug(meta.channel) ]
→ 依序找 glossary/channel-{key}.json，第一個「有內容」的層勝出
```

頻道改名後 ucid 仍命中；舊資料仍走名稱 slug（`channel-トバログ.json`）。
video 路由（admin 貼連結）沒有 channel meta → **由送件表單的「頻道鎖定表」欄位指定鍵值**
（`watch.json` 的 `channel`）；留空就只吃 ②，這正是「A 節目的人名不會塞進 B 節目 prompt」的修法。

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
| `glossary.ts`（新） | 疊層的全部邏輯：`parseGlossaryDoc` / `mergeGlossary` / `channelKeys` / `loadGenreLayer` / `loadChannelLayer` |
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
| **G1** ✅ | 拆遷 watch-ko.json → genre/channel 兩檔；glossaryStep/watchStep 讀取合併（含優先序與上限）；測試 | 同頻道兩支影片，channel 表術語譯法一致；video 路由 prompt 含合併表 |
| **G2** | `PUT /glossary/{scope}` + 儀表板編輯 + 「收進頻道表」按鈕 | 從儀表板提升一條 ③ → 下次重翻該頻道影片時生效 |
| **G3** ✅ | ext 抓 channelId（ucid）穩定鍵值 + 兩種鍵值並存查找 | 頻道改名不影響鎖定表 |

工作量：G1 約半天內、G2 約半天、G3 小。

## 7.1 實作與本文的差異（G1 實際落地時的決定）

| 本文原訂 | 實際做法 | 為什麼 |
|---|---|---|
| 40 genre / 19 channel | **44 / 15** | `피디`、`세계관`、`무한도전`、`1박 2일` 是任何韓綜都成立的通用詞／人盡皆知的節目名，歸 genre 才不會綁在單一頻道 |
| channel 檔鍵值用節目名 | 內建表鍵值取 **`15ya`**（十五夜） | 看片路線要人工在表單打這個鍵值，韓文 slug 不好輸入 |
| G2 才加 watch-job 的 channel 欄 | **G1 就加**（表單 + API） | 不加的話，拆表當下就會讓既有韓綜掉 15 條人名鎖定 —— 拆表不該造成品質回退 |
| — | genre 讀取多一層舊檔後備 `glossary/watch-{lang}.json` | R2 上可能還有 kvsplayer 遷入的舊檔，不該因為改名而突然失效 |

另外：`term` 欄位在舊檔是語言碼（`{"ko":"막내","zh":"忙內"}`），parser 兩種都吃；
壞掉的 glossary 檔一律當「這層沒有」而不是讓整支影片翻譯失敗（人工檔案同樣視為敵意輸入）。

## 8. 決策（人工填寫）

```
決策：**G1 先做**（2026-08-16，同批做掉 G3 路由同源）；G2 儀表板編輯留在 backlog
日期：2026-08-16
理由：先驗證「人工表對模型有沒有約束力」再談養表工具 —— 實測鎖定譯法 0/7 → 6/7 句
   （docs/exp-2026-08-16.md E2），約束力成立，所以 G2 的投資現在才有回報。
   目前手動編輯 R2 的 glossary/*.json 還撐得住。
```
