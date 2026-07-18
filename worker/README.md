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
   `ytplayer-subs` 的 bucket，然後 retry deployment。這是唯一可能需要的手動步驟。
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
| GET | `/videos.json` | 公開 | 清單資料 |
| GET | `/subs/{videoId}/{file}` | 公開 | `source/sentences/glossary/bilingual/info.json`、`bilingual.srt` |
| GET | `/health` | 公開 | 狀態（`ingestKeyConfigured` 要是 `true`） |
| POST | `/ingest` | key | 收 ext payload，存 `subs/{videoId}/source.json` |
| POST | `/translate/{videoId}` | key | 手動觸發翻譯（`?force=1` 忽略 cache；平常交給 cron 即可） |

Cron（`*/5`）自動掃 R2：Tier 2 且 bilingual 缺少/過期 → 翻譯，一次一支。

## 自訂網域

Worker → Settings → Domains & Routes → Add → Custom domain → `ytplayer.ai-apps.work`
（zone 已在同帳號即可直接掛；workers.dev 網址仍然有效）

### 翻譯用法

```bash
# 跑翻譯（20 分鐘影片約 1–2 分鐘，同步等）
curl -X POST -H "x-ingest-key: $KEY" "https://ytplayer.<subdomain>.workers.dev/translate/<videoId>"
# 拿結果
curl -H "x-ingest-key: $KEY" "https://ytplayer.<subdomain>.workers.dev/subs/<videoId>/bilingual.srt"
```

回應的 `stats.warnings` 必須為空才算驗收通過（禁用詞殘留、翻譯失敗都會列在裡面）。

### Secrets / Vars

| 名稱 | 類型 | 用途 |
|---|---|---|
| `INGEST_KEY` | Secret | 所有寫入/讀取的認證（**Settings → Variables and Secrets**，不是 Builds 的環境變數） |
| `GEMINI_API_KEY` | Secret | 翻譯模型（aistudio.google.com 取得） |
| `GEMINI_MODEL` | Var（wrangler.jsonc） | 預設 `gemini-3.5-flash`，要換不用改程式 |

## 本機開發

```bash
cd worker
npm install
npm test          # vitest：payload 驗證 + json3 normalizer（fixture 來自真實 capture）
npm run dev       # wrangler dev，本機模擬 R2
```
