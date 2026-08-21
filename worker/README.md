# ytplayer Worker — 部署（Cloudflare Git 自動部署，最小化操作）

一次性設定，之後 **push 到 production branch 就自動部署**。

## 一次性設定（約 3 分鐘）

1. [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → Workers 頁籤 → **Import a repository** → 授權 GitHub 並選 `clarencechien/ytplayer`
2. 設定欄位：
   | 欄位 | 值 |
   |---|---|
   | Project name | `ytplayer` |
   | Production branch | `main`（想先不合併就部署的話，改成目前的開發分支） |
   | Root directory | `worker` |
   | Build command | （留空） |
   | Deploy command | `npm run deploy:ci` |
3. 按下 Deploy。`deploy:ci` 會先嘗試建立 R2 bucket `ytplayer-subs` 再部署；
   若 log 顯示 bucket 建立失敗（build token 權限不足），到 **R2 → Create bucket** 手動建一個叫
   `ytplayer-subs` 的 bucket，然後 retry deployment。
   另需 **Queues**（Workers Paid）：Dashboard → **Queues → Create** → 名稱 `ytplayer-jobs`
   （翻譯 pipeline 拆成小步在 queue 上自我續鏈，見 [docs/migration.md](../docs/migration.md) §2）。
4. **（建議）鎖上寫入權限**：Worker `ytplayer` → Settings → Variables and Secrets →
   Add → type 選 **Secret**，名稱 `INGEST_KEY`，值隨便一串長隨機字串。
   沒設也能動（方便先跑通），但任何知道網址的人都能寫入你的 bucket。

## 驗證

開 `https://ytplayer.<你的 subdomain>.workers.dev/`，應回：

```json
{ "service": "ytplayer", "ok": true, "ingestKeyConfigured": true }
```

然後把這個網址與 key 填進 `ext/config.js`。

## 端點

| 方法 | 路徑 | 認證 | 說明 |
|---|---|---|---|
| GET | `/` | 公開 | 影片清單頁（player 入口） |
| GET | `/watch/{videoId}` | 公開 | Player 頁（iframe + 雙語字幕層 + 逐句稿） |
| GET | `/videos.json` | **key** | 清單資料（等於觀看紀錄，不對外） |
| GET | `/subs/{videoId}/{file}` | 公開 | `source/sentences/glossary/bilingual/info/status.json`、`bilingual.srt` |
| GET | `/health` | 公開 | 狀態（`ingestKeyConfigured` 要是 `true`） |
| GET | `/robots.txt` | 公開 | 允許抓取（全站另有 `X-Robots-Tag: noindex` — 擋爬會讓 noindex 看不見） |
| GET | `/admin` | Access | 儀表板：任務狀態、今日花費、看片路線送片、每列的修正按鈕 |
| GET | `/jobs.json` | **key** | 儀表板資料（順便回填舊片缺的 `untranslated`／`cpsOver`／`doneAt`）|
| GET | `/share`、`/manifest.webmanifest`、`/sw.js` | 公開 | PWA（手機分享送片） |
| GET/POST/DELETE | `/inbox*` | key | 手機送片的待補佇列（桌機 ext 補收後銷帳）|
| POST | `/ingest` | key | 收 ext payload，存 source 並**直接排入翻譯佇列** |
| POST | `/translate/{videoId}` | key | 手動排入佇列（202 ack，進度看 `status.json`）。`?force=1` 忽略 cache、清除失敗標記重跑 |
| POST | `/watch-job/{videoId}` | key | 看片路線（video）送片 |
| POST | `/retime/{videoId}` | key | ⏱ 重算顯示時間軸（**零 LLM**、冪等可重按）|
| POST | `/patch/{videoId}` | key | 只重譯有問題的句子。`?mode=untranslated`（預設）｜`cps`（📏 壓縮，先零成本剝英文夾註）｜`all` |
| POST | `/turnstile/verify` | 公開 | 人機挑戰回呼（程式已備妥，目前休眠 —— 擋爬蟲的是 zone 層 WAF）|

執行架構：翻譯拆成有界小步（plan → repair → glossary → translate → assemble → patch；
看片路線是 plan → watch）在 **Queues** 上自我續鏈，每步 1–2 分鐘、做完即落地 checkpoint；
cron（`*/5`）只是零成本看門狗（補漏，不碰 LLM）。
花費保險絲四層：Google 端配額（人工設）→ 每步 3 次重試後永久失敗 → 每片 token 上限 → 全域日預算
（`VIDEO_TOKEN_CAP` / `DAILY_TOKEN_CAP` vars 可調，預設 500k / 2M tokens）。

認證分層：**寫入**（ingest／translate）一律要 key；**影片清單**要 key（等於觀看紀錄）；
**單片**（`/watch/{id}`、`/subs/{id}/*`）維持公開 —— videoId 本來就是 YouTube 公開資訊，連結才好分享。
瀏覽器帶不了 header，故清單同時接受 `?key=`：首次用 `https://ytplayer.ai-apps.work/?key=你的KEY`
開啟，頁面會存進 localStorage 並把 key 從網址清掉，之後直接開 `/` 即可。

## 自訂網域

Worker → Settings → Domains & Routes → Add → Custom domain → `ytplayer.ai-apps.work`
（zone 已在同帳號即可直接掛）
⚠ `workers.dev` 與 preview URL **已在 `wrangler.jsonc` 關閉**（`workers_dev: false`／`preview_urls: false`）——
自訂網域是唯一入口，見 [../docs/privacy-hardening.md](../docs/privacy-hardening.md)

### 翻譯用法

```bash
# 排入翻譯（立刻回 202；queue 上分步跑完，長影片不會被斷線砍掉）
curl -X POST -H "x-ingest-key: $KEY" "https://ytplayer.ai-apps.work/translate/<videoId>?force=1"
# 看進度（stage/step/tokensUsed；failed 時有 failReason）
curl "https://ytplayer.ai-apps.work/subs/<videoId>/status.json"
# 拿字幕
curl "https://ytplayer.ai-apps.work/subs/<videoId>/bilingual.srt"
```

完成後 `bilingual.json` 的 `warnings` 必須為空才算驗收通過（禁用詞殘留、翻譯失敗都會列在裡面）。

### Secrets / Vars

| 名稱 | 類型 | 用途 |
|---|---|---|
| `INGEST_KEY` | Secret | 所有寫入/讀取的認證（**Settings → Variables and Secrets**，不是 Builds 的環境變數） |
| `GEMINI_API_KEY` | Secret | 翻譯模型（aistudio.google.com 取得） |
| `GEMINI_MODEL` | Var（wrangler.jsonc） | 預設 `gemini-3.5-flash` + 關思考（四組同片實測勝出，docs/model-experiment.md）。**只能改 wrangler.jsonc**：git 部署會用它蓋掉 dashboard 的明文變數（Secret 不受影響）— 在 dashboard 改會被下次部署踩回來 |
| `GEMINI_THINKING_LEVEL` | Var（選填） | text 路由 thinking 檔位，**預設 `minimal`**（唯一實測 thoughts=0 的旋鈕；`GEMINI_THINKING_BUDGET` 為 legacy 逃生口，兩者永不同時送出） — 翻譯是機械轉換不需推理，thinking 以輸出價計費（2026-08-13 帳單事故主因：Output 是 Input 的 3–4 倍全是思考）。看片路由不受此限（維持模型預設） |
| `COST_IN_NTD_PER_M` / `COST_OUT_NTD_PER_M` | Var（選填） | 儀表板雙費率估算，預設 47/280（= 3.5-flash 牌價 $1.5/$9 × 31 匯率）。舊單費率 `COST_NTD_PER_M` 設了會蓋過雙費率 |

## 本機開發

```bash
cd worker
npm install
npm test          # vitest：payload 驗證 + json3 normalizer（fixture 來自真實 capture）
npm run dev       # wrangler dev，本機模擬 R2
```
