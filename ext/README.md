# ytplayer ingest — Chrome Extension（load unpacked 自用）

把 YouTube 播放器實際載入的字幕軌送到自己的 Worker。
只做 ingest 一件事；不疊字幕、不自動觸發。

## 安裝

1. 部署 Worker（見 `worker/README.md`），拿到網址
2. `chrome://extensions` → 開啟「開發人員模式」→「載入未封裝項目」→ 選這個 `ext/` 資料夾
3. 點 ext 圖示 → popup 底部「⚙ 設定」→ 填 Worker URL 與 INGEST_KEY → 儲存
   （設定存在瀏覽器的 `chrome.storage.local`，**key 不進 repo**；網址沒打 `https://` 會自動補）

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

## 待補字幕佇列（手機送片的另一半）

手機沒有擴充功能、攔不到字幕，所以 PWA（`/share`）只把影片**排進待補佇列**；
真正的 ingest 仍在桌機這裡完成：

1. 擴充功能圖示上會顯示待補數量（每 30 分鐘更新一次，`chrome.alarms`）
2. 點開 popup → 上方列出待補影片 → 點一下開 YouTube 分頁
3. 照平常流程開 CC 選原文軌 → 送出 → Worker 收到後**自動把該片從佇列銷帳**

刻意不做自動開分頁／自動選軌：選哪條軌（原文？多語言的哪一條？）本來就是人的判斷，
而且全自動採收會滑向灰色地帶。詳見 [docs/pwa-plan.md](../docs/pwa-plan.md)。

> 更新擴充功能後記得到 `chrome://extensions` 按「重新載入」——
> 這版新增了 `alarms` 權限與背景 service worker，不重載不會生效。
