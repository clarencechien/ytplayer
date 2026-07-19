# kvsplayer × ytplayer 合併評估（ADR + Go/No-Go）

> 目的：把「要不要合、怎麼合」的決策材料一次備齊。**結論由人工決定**，本文件只負責誠實分析。
> 依據：ytpoc（kvsplayer）repo `3b05e62` 實地閱讀 + ytplayer 現況。
> 狀態：**待決策**（見文末決策欄）。

---

## 1. 兩專案現況快照

| 面向 | ytplayer | kvsplayer（ytpoc） |
|---|---|---|
| 題目 | 英文（+任何人工原文軌）→ 台灣正體雙語字幕 | 韓綜（Tier 3 非英文）→ 台灣正體字幕 + 畫面字卡 |
| ingest | **Chrome ext 攔截 CC 軌**（使用者 IP，ground truth） | 貼連結全自動：innertube 碰運氣 → **Gemini 看片**（Google 抓片，繞過 CF IP 封鎖） |
| 時間軸信任 | CC 軌 = **確定的 ground truth** | **模型估算**（會漂，播放驗收要盯對嘴） |
| 轉寫 | 不需要（CC 即原文）；英文 ASR 有修稿 pass | Gemini 一次呼叫 = 聽寫 ko + 讀字卡 + 翻 zh |
| 任務驅動 | **cron */5 掃 R2**（免費方案） | **Queues 自驅動**（Workers **Paid**）：退避重試、斷點續跑、多支並行 |
| 認證 | header key（寫入）；讀公開 | **Cloudflare Access（Google SSO）**+ email 白名單；讀公開 |
| 儲存 | R2 `ytplayer-subs`：`subs/{id}/source|sentences|glossary|bilingual|info` | R2 `kvs-krsub`：cues + 分段中間產物（可免費重建） |
| cue schema | `{start, end, en, zh, note?, untranslated?}` | `{id, start, end, kind: speech\|card, ko, zh}` |
| glossary | 每片自動抽 + 白話註（觀眾導向） | genre 40 詞 + 頻道譯名表（**鎖定**，跨片沿用） |
| player | Worker 內 TS template：`/watch/{id}`，熱鍵/點擊層/譯註 | 靜態 `public/index.html`（assets binding）：`/?v=id`，字卡疊畫面 |
| 程式 | TS 模組化，**63 個測試** | 單檔 JS 890 行，無測試 |
| 成本結構 | 純文字：20 分鐘片 ≈ 2 萬 token（趨近零） | 看片：MEDIUM ≈ 300 tok/秒，30 分鐘 ≈ 54 萬 tok（仍便宜但差 ~30 倍；毒段×重試曾燒 NTD 200） |
| 特有資產 | fail-fast 檢查、修稿 pass、自動譯註、切半分治 | 分段掃描階梯、確定性清洗器、免費重建、成本可視化、字卡去重規則 |

## 2. 本質差異（決定合不合的關鍵）

兩專案在 **ingest 與信任模型**上是不同物種：

1. **資料信任等級不同**：ytplayer 的時間軸與原文是確定的；kvsplayer 的一切（含時間戳）是機率性的。
   合併後同一個 player/清洗層要同時服務兩種信任等級 — 可行，但 schema 與驗收邏輯都要帶「來源信任」標記
2. **任務形狀不同**：ytplayer 單支 1–2 分鐘、cron 一次一支剛好；kvsplayer 單支 5–15 分鐘牆鐘（10 段 × 30–90 秒）+
   重試階梯 + 斷點續跑 — **這是 Queues 的形狀，cron 硬塞會很難看**。合併 = ytplayer 也綁上 Workers Paid
3. **驅動入口不同**：ext 手動點（ytplayer 的「看到想看的才處理」）vs admin 貼連結全自動（kvsplayer 的「餵連結就好」）。
   合併後兩種入口都要留
4. **翻譯層之後高度同構**：glossary → 翻譯 → 清洗 → R2 → player 的骨架兩邊一致；
   zh-TW 規範、禁用詞、簡體偵測、譯註系統、player UX 這些資產**與輸入來源無關**

## 3. ADR：三個候選方案

### 方案 A — 完全合併（ytplayer 為基底，看片路線移植進來）

單一 Worker、單一 player、單一清單頁；kvsplayer 變成 ytplayer 的「Tier 3 非英文 ingest 路線」。

- ✅ 單一站點單一體驗；品質資產改一次兩題受益；schema 統一（`orig` 取代 en/ko + `kind` + `trust` 欄位）；
  kvsplayer 的 890 行無測試 JS 趁移植改寫成有測試的 TS
- ❌ 工作量最大（估 6–10 個工作天等級）：看片 pipeline 移植改寫、Queues 整合、Access + key 雙認證並存、
  R2 資料遷移、兩邊 player 功能聯集（字卡層 + 譯註層）
- ❌ ytplayer 從此依賴 Workers Paid（Queues）
- ❌ 移植期間 kvsplayer（live 且在用）有 regression 風險

**A 的 TODO（若選 A）**
1. schema v2 定案：`{start, end, kind: speech|card, orig, zh, note?, trust: cc|asr-repaired|model, untranslated?}`；舊資料寫轉換器
2. 看片 pipeline 移植成 TS 模組（分段掃描階梯、清洗器、免費重建、成本計數）+ 單元測試（用 ytpoc 既有 R2 資料當 fixture）
3. Queues 整合：ext ingest 路線維持 cron 也行，或一併改 Queues（統一心智模型）
4. 認證：Access 蓋 `/admin`，key 蓋 API — 並存可行，規則寫清楚
5. player 聯集：字卡層（cardLayer）移植 + kind 感知的逐句稿；韓中「不同級」與英中「同級」變成設定
6. glossary 統一：per-channel 鎖定表（kvsplayer 的做法）+ per-video 自動抽（ytplayer 的做法）疊加，這本來就是 ytplayer Phase 4 想要的
7. R2：搬 `kvs-krsub` → `ytplayer-subs` 或雙 bucket 綁定過渡
8. 網域轉址與舊連結相容（`/?v=id` → `/watch/{id}`）

### 方案 B — 不合 Worker，抽共用資產（輕量同步）

兩個 Worker 照跑，把「與輸入無關」的資產做成可搬運的模組：zh-TW 規範（禁用詞+例外+簡體表）、
fail-fast 檢查、譯註系統、player template。個人專案沒有 registry，實務上是**有紀律的複製**（來源標註 + 單向同步：ytplayer 為 upstream）。

- ✅ 零遷移風險、kvsplayer 不動；品質資產仍可流動（複製成本低，這些檔案都 <300 行）
- ✅ 保留兩邊各自最適的任務驅動（cron vs Queues）與付費邊界
- ❌ 複製會漂移（改了 A 忘了 B）；player 兩套要各自維護（UX 改進要做兩次 — 這次的熱鍵/點擊層/逃生口 kvsplayer 就沒有）
- ❌ 兩個站點兩個入口，使用體驗不統一

**B 的 TODO（若選 B）**
1. 把 `BANNED_WORDS/EXCEPTIONS`、`SIMPLIFIED_CHARS`、`sanityCheckItem`、`cleanJson` 抽成單檔 `zh-tw-quality.ts`，標 upstream 註記
2. kvsplayer 引入上述檔案 + 這輪的 player UX（點擊層/逃生口/熱鍵/原生 CC 關閉）
3. 兩邊 README 互相連結、lessons-learned 單一維護（放 ytplayer，kvsplayer 指過來）

### 方案 C — 不合、不同步（現狀）

- ✅ 零成本
- ❌ 品質資產與 UX 改進不流動；已知 bug（如原生 CC 疊影）在 kvsplayer 繼續存在

## 4. Go / No-Go 判準（可檢驗，供人工決策）

| # | 判準 | 傾向 Go（A） | 傾向 No-Go（B/C） |
|---|---|---|---|
| 1 | 韓綜是**持續**需求還是一次性玩具？ | 每週都在看 | 偶爾 |
| 2 | 未來半年會不會出現「同一支影片兩邊都要」（英文 CC + 畫面字卡並存的內容）？ | 會 | 不會 — 兩題受眾內容不重疊 |
| 3 | player/UX 改進的重複勞動實際發生頻率 | 每次改都想同步 | 這次補完就穩定了 |
| 4 | Workers Paid 綁定對 ytplayer 可接受？ | 反正已付 | 想保持免費自足 |
| 5 | 有沒有 6–10 天等級的整塊時間（或願意讓 agent 跑長工程 + 驗收）？ | 有 | 沒有 |
| 6 | kvsplayer live 服務可以容忍遷移期抖動？ | 可以 | 正在追的節目不能斷 |

## 5. 分析結論（我的傾向，非決定）

**先 B、把 Go 條件留給時間驗證。** 理由：

- 兩專案的本質差異在 ingest 與信任模型（§2），這部分合併沒有綜效，純粹是搬家
- 真正的綜效（品質資產、player UX）用 B 的輕量同步就能拿到 80%，成本是 A 的十分之一
- A 最大的單一風險是動到 **live 且在用**的 kvsplayer；而 A 最大的誘因（單一站點）目前只是「整潔」，還沒有實際痛點
- 判準 #2 或 #3 若在未來變成「是」，隨時可升級成 A — B 做過的資產抽取工作在 A 裡全部可沿用，沒有白工

## 6. 決策（人工填寫）

```
決策：____（A / B / C）
日期：____
理由：____
若 A：預計時程與驗收方式：____
```
