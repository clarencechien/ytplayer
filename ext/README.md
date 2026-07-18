# ytplayer ingest — Chrome Extension（load unpacked 自用）

把 YouTube 播放器實際載入的字幕軌送到自己的 Worker。
只做 ingest 一件事；不疊字幕、不自動觸發。

## 安裝

1. 部署 Worker（見 `worker/README.md`），拿到網址
2. 編輯 `ext/config.js`：填 `WORKER_URL` 與 `INGEST_KEY`（與 Worker secret 一致；沒設 secret 就留空）
3. `chrome://extensions` → 開啟「開發人員模式」→「載入未封裝項目」→ 選這個 `ext/` 資料夾

## 使用流程

1. 開一支 YouTube 影片
2. **開啟播放器的 CC，選「原文」字幕軌**（例如 English；不要選「自動翻譯」）
   — timedtext 有 POT 防護，ext 只能攔截播放器自己發出的請求，所以這步是必要的
3. 點 ext 圖示 → popup 會顯示影片的 Tier 判定與攔到的字幕軌
4. 選軌 → 「送出到 Worker」→ 顯示 ✅ 與 R2 key

## 行為說明

- **Tier 1**（創作者已有繁中）：提示直接用 YouTube 原生，但仍可送原文軌供比對
- **Tier 4**（無任何 CC）：無法送出
- **自動翻譯軌（URL 帶 `tlang`）**：一律拒收並提示切回原文軌（紅線規則）
- SPA 站內切換影片後：popup 一律以**網址列的 videoId** 為準，重新抓頁面資料，不會送到舊影片
- 若 popup 說「還沒攔到」：先開/關一次 CC 再重開 popup
