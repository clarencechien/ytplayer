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

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/ingest` | 收 ext 的 payload，驗證後存 `subs/{videoId}/source.json`（header `x-ingest-key`） |
| GET | `/subs/{videoId}/source.json` | 讀回存好的字幕（驗收與後續 Phase 用） |
| GET | `/` | health / 設定狀態 |

## 本機開發

```bash
cd worker
npm install
npm test          # vitest：payload 驗證 + json3 normalizer（fixture 來自真實 capture）
npm run dev       # wrangler dev，本機模擬 R2
```
