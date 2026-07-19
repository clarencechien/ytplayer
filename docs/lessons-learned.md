# Lessons Learned（實證教訓總整理）

> 目的：讓後續迭代與 **kvsplayer 合流**不必重踩。每條格式：現象 → 決策 → 依據。
> 時間範圍：2026-07-18 dogfood journey（Phase 0 → MVP）。

---

## 1. YouTube 生態（Phase 0–0.5 實證，別再猜）

| 現象 | 決策 | 依據 |
|---|---|---|
| timedtext 有 **POT 防護**：`baseUrl` 直接 fetch 一律 `200 + 空 body`，連在 youtube.com 頁內帶 cookie 都一樣 | ingest 唯一路徑 = **攔截播放器自己發出的請求**（MAIN world 包 XHR+fetch） | 3 支影片 28 條軌全中；播放器實際請求帶 BotGuard 產生的 `pot=` |
| timedtext 回應**無 CORS 標頭** | player 頁不可能自己抓軌；ext 不可省 | ACAO 全部為 null |
| **server/datacenter IP 全面 bot-block** | CF Worker 永遠不要嘗試抓 YouTube；住宅 IP node 才可行 | watch 頁 429/302→sorry；Innertube WEB/TVHTML5/MWEB 全回 LOGIN_REQUIRED |
| SPA 站內導航後 `ytInitialPlayerResponse` **stale**（停在上一支影片） | meta/track 清單一律重新 fetch HTML 再 balanced-brace parse；global 只當 fallback | 實測 global videoId ≠ 網址列 |
| 播放器字幕請求用 **XHR** 不是 fetch | 兩者都包，XHR 為主 | probe2 攔截記錄 |
| `vssId` 前綴：`a.` = ASR、`.` = 人工；與 `kind==='asr'` 交叉驗證一致 | tier 判定用兩者交叉 | 三支影片驗證 |
| baseUrl `expire` 約 **7 小時**、`ip=0.0.0.0`（不綁 IP）；攔到的 URL 同 session 可原樣重放 | 但架構上直接存回應 body，不依賴重放 | phase0b 重放實測 200 非空 |
| ASR 出現 **`variant=gemini`**：有標點、大小寫、`[music]` 標記 | 英文 ASR 修稿負擔比預期輕；「ASR 無標點」的舊假設過時 | SpaceX 軌實測 |
| YouTube 自動翻譯（`tlang`）輸出**不穩定**：同 URL 兩次請求 events 數不同、字詞不同 | 紅線：tlang 軌永不作為輸入（payload 出現即 400） | phase0b 同 URL 比對 |
| 使用者真的會開著自動翻譯軌看片 | tlang 過濾是必要防線不是理論：ext 標灰拒送 + Worker 再驗一層 | probe2 前兩筆 capture 都是 tlang=zh-Hant |

## 2. Ingest ext

- **多 ext 共存是常態**（廣告攔截器、繁化字幕 ext 都在包 XHR）：攔截只讀不改、不吞例外、容忍多層包裝
- 設定（Worker URL/key）放 `chrome.storage.local` + popup 內建設定 UI，**永不進 repo**
- URL 防呆：自動補 `https://`、去尾斜線（實測踩過的 B 級雷）
- 權限最小化可以做到只剩 `*://*.youtube.com/*`：Worker 端開 CORS + key 認證，連 workers.dev 的 host_permission 都不用

## 3. Cloudflare 部署（Workers Builds）

- Git 連結自動部署可用，但三個坑：**production branch 與程式碼所在分支要一致**、Root directory 要指到 `worker/`、
  secret 要設在 Worker 的 **Variables and Secrets**（不是 Builds 的 environment variables — 實測設錯過，health 的 `ingestKeyConfigured` 是照妖鏡）
- R2 bucket 建立：deploy command 先 `wrangler r2 bucket create ... || true` best-effort，失敗再手動一次
- 認證模型：**讀公開、寫入要 key**（字幕非敏感）— player 頁因此不用帶 key，瀏覽器可直接看輸出
- 非同步策略：**cron（*/5）掃 R2 佇列**勝過 long-request（kvsplayer 的教訓）與 ext fire-and-forget（popup 一關 fetch 就死、Worker 被取消）。
  規則：bilingual 缺少或比 source 舊 → 翻；`.translating` 鎖檔防重疊（10 分鐘 stale）；重新 ingest 即自動重翻；改 promptVersion 需手動 `force=1`（避免版本一 bump 全庫自動重燒）
- **Gemini API「User location is not supported」400 是間歇性的**：Worker 出口 colo 會變（台灣流量常經香港，該區不被支援），
  同一請求重打常換到支援的出口 → 把這種 400 列為可重試（上限 4 次）。實測分治救援也因此能撈回整包失敗的 chunk。
  若未來變頻繁，治本選項是 Vertex AI（可指定 region）或固定出口的代理

## 4. 斷句（品質的分水嶺，也是最多迭代的地方）

- **合併斷句只對「演講/訪談型」正確**：YouTube 把一句話切成多 cue，拼回完整句再翻是勝過 YouTube 自動翻譯的核心手段
- **歌詞/逐行字幕合併是破壞**：原始 cue 邊界本身就是創作者的斷句與時間軸資訊。
  軌型態偵測：**句尾標點比例 < 10% → 逐行模式**（一 cue 一句、時間軸原封不動）
- 英文中心是隱性 bug：句尾標點要含 CJK（`。！？」』`）；長度上限 CJK 用字元數（60 字）、英文用詞數（60 詞），分開算才不互相誤殺
- 實際案例：日文歌人工歌詞軌無英文標點 → 整首糊成 7 句巨型字幕。翻譯沒壞，斷句壞了 — **先看 sentences 再怪模型**

## 5. 翻譯品質工程（prompt 管天花板、程式碼管地板）

### Prompt 側（天花板）— v1→v4 的演進

- **目標觀眾要明寫**（台灣大學生/非本科、看懂六～八成），否則「保留英文」的判準會默認為業界慣用 → 非本科觀眾看天書
- **術語呈現形式的決策權集中到 glossary pass**：「中文（English）」／保留英文／純中文，三選一寫死在表裡；
  保留英文者必附 30 字白話 note。翻譯 pass 照表使用，不即興
- 譯註格式「**詞：解釋**」— 沒有前綴的註，觀眾不知道在解釋誰（實測回饋）
- prompt 不寫死語言（「英文字幕」→「原文（語言：xx）」），glossary/翻譯/修稿都帶 sourceLang
- 改 prompt 必 bump `PROMPT_VERSION`（cache key），否則吃到舊譯文

### 程式側（地板）— 全部 deterministic

- **attachGlossaryNotes**：術語「全片第一次出現」的句子自動附白話註 — chunk 平行翻譯下模型不可能知道全域首次出現，這件事只能程式做。一句最多 3 條（滿了退到下一次出現處）；三條救不了 = 跨領域，超出字幕的責任
- **fail-fast 逐句檢查**（不用 LLM 自我審查 — 同一副眼鏡檢查自己沒有意義）：
  簡體獨有字形表（繁簡同形字不收，避免誤殺「行、里、干、据」）／原文照抄／無中文／長度爆走／同句重複 ≥3（崩塌）。
  沒過 = 視同缺句 → 自動進重試管線
- **禁用詞掃描要有例外表**：「質量流量（Mass flow）」是物理正確用法（SpaceX 實測誤傷）
- **詞表分三層，誤報容忍度決定層級**（外部資源引入的原則）：
  prompt 對照表（16 條）每 chunk 付 token 維持精簡；執法層（+speak-human-tw 策展 16 條）低誤報才可觸發重譯；
  報告層（OpenCC TWPhrases 680 條）批量詞表必有誤報 → 只能進 `hints` 提示、與 warnings 驗收分離。
  台灣本有他義的詞（水平/支持/落地/對象…）在生成器 SKIP 表排除 — speak-human-tw 的「按語境判斷」清單是現成的排除依據
- **ASR 雜訊清除不能靠 LLM**：`[music]`/`>>` 程式硬刪，純雜訊句整句移除
- **截斷 JSON 修復**：砍到最後一個完整物件補 `]`，救回部分結果
- **切半分治**：整包兩次失敗後對半切各自重打 — 輸出截斷與單點毒句，整包重打救不了
- **失敗原因必須可觀測**：chunk 編號 + 原因 + 模型輸出開頭進 `stats.warnings` — 「21 句沒翻但不知道為什麼」的狀態不可接受
- **LLM 呼叫數硬上限**（含分治預算）：防重試失控燒錢
- 缺譯 fallback 英文原文並標 `untranslated` — 寧可看得出沒翻，不可默默吞掉

## 6. Player

- 樣式基底來自 kvsplayer（深色、字幕疊影片、右側逐句稿點擊跳轉）— 已驗證的版型直接繼承
- 差異：**中英同級**（同字級同權重，僅顏色區分）— 雙語「對照學習」的定位 vs kvsplayer 的「輔助原文」定位
- 譯註 `pre-line` 多行顯示；設定存 localStorage（顯示模式/譯註開關/跟隨捲動/字級/透明度/速度）
- 翻譯還沒好時自動每 20 秒重試 — 配合 cron 佇列，使用者體感是「點完 ext 過幾分鐘自己出現」

### 疊在跨域 iframe 上的互動層（實戰教訓）

- **焦點模型是熱鍵的生死線**：熱鍵掛在自己頁面，點了 iframe 焦點就丟。解法＝透明點擊層接管播放控制
  （單擊播放/暫停、雙擊全螢幕，走 IFrame API），焦點永遠留在本頁 → 全螢幕下熱鍵照常
- **點擊層必留逃生口**：原生 UI 的功能列舉不完（畫質齒輪…），精準挖洞（「留 90px」）會失敗 —
  控制列要 hover 才浮現，而點擊層把 mousemove 吃掉了。正解是「YT 介面：鎖定/開放」一鍵讓開整層
- **原生 CC 要用 API 關，而且時序要對**：ingest 時開的 CC 是帳號黏性設定，embed 會繼承成雙層字幕。
  captions 模組是播放後懶載入 — onReady 時 unload 是對空氣揮拳，要掛 **onApiChange**（模組載入時點）
  用 `setOption('captions','track',{})` + `unloadModule` 雙保險
- 熱鍵盡量沿用 YouTube 慣例（Space/K、←→、F、M、C、Shift+</>），學習成本零；
  `setPlaybackQuality` API 已廢棄 — 畫質交給原生齒輪（經逃生口），別做假按鈕

## 7. 影片分層（Tier）與 kvsplayer 合流接軌

### Tier 定義（append-01）與各自的解法歸屬

| Tier | 定義 | 本專案（ytplayer） | kvsplayer |
|---|---|---|---|
| 1 | 創作者自製多語言（有人工 zh-TW/zh-Hant 軌） | 預設提示用原生；**使用者主動 ingest 原文軌 = 明示重做**，照 Tier 2 流程 | — |
| 2 | 創作者自製原文 CC（人工、僅原文） | ✅ 主路徑：斷句 → glossary → 分塊翻譯 | — |
| 3 + 英文 | 僅 ASR，英文 | ✅ Phase 2.5：LLM 修稿（聽寫錯/標點）→ 進 Tier 2 流程 | — |
| 3 + 非英文 | 僅 ASR，日/韓等 | 🚫 拒收（轉寫不可信，修稿是在修錯的文字） | ✅ **Gemini 看片路線**（唯一划算的那格） |
| 4 | 無任何 CC | 🚫 直接報錯 | （同左，或看片路線） |

**可譯性判準最終版：看「被 ingest 的軌」不看 tier** — 中文軌拒收；人工原文軌不分語言可翻；ASR 僅限英文。

### 合流時可直接共用的資產

- **Worker 骨架**：R2 佈局（`subs/{videoId}/*`）、cron 佇列 + 鎖、認證模型（讀公開/寫 key）、cache key（videoId, lang, model, promptVersion）
- **Player 頁**：逐行模式字幕正好是韓綜對話軌的型態；kvsplayer 的字卡（card）概念可反向移植
- **zh-TW 品質資產**：禁用詞表 + 例外表、簡體字形偵測、譯註系統（詞：解釋、每句上限、程式端首現附註）、glossary 呈現形式三分法 — 這些與「輸入是 CC 還是影片」無關，全部可重用
- **fail-fast 檢查**：對 Gemini 看片輸出同樣適用（時間軸單調、崩塌、簡體、長度）
- 兩專案的分流點在 **ingest**（CC 軌 vs 影片）與**轉寫來源**，翻譯層之後的一切可以是同一套

### 合流時要小心的差異

- kvsplayer 的看片路線輸出是機率性的（時間軸會漂）— ytplayer 的時間軸來自 CC 是 ground truth，合流後兩種來源的信任等級要分開標
- 韓綜有字卡（畫面文字）維度，ytplayer 資料模型目前只有對話；合流 schema 要預留 `kind: speech|card`
