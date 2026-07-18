# Phase 0 Findings：可行性驗證

> 狀態：**部分完成**。
> 已在雲端環境完成「server 端能不能抓字幕」的實證（結論：不能，證據如下）。
> 需要真實瀏覽器（住宅 IP）的四個項目，工具已備好（`phase0/devtools-probe.js`），等使用者執行後回填。

---

## 1. 已驗證：server 端（datacenter IP）抓不到字幕 ✅

Handoff 的架構決策假設「Cloudflare IP 被 YouTube 封鎖，server 端抓不到」。
本次在雲端 sandbox（datacenter egress IP）做了實測，**假設成立**，而且封鎖比預期更全面：

| 路徑 | 結果（2026-07-18 實測） |
|---|---|
| `GET /watch?v=...`（曾短暫成功一次） | 之後全部 `429` 或 `302 → google.com/sorry`（CAPTCHA 頁） |
| Innertube `youtubei/v1/player`，`WEB` client | `200`，但 `playabilityStatus = LOGIN_REQUIRED`，reason = "Sign in to confirm you're not a bot"，**無 captionTracks** |
| Innertube，`TVHTML5` client | 同上 |
| Innertube，`MWEB` client | 同上 |
| Innertube，`ANDROID` client | `400 FAILED_PRECONDITION`（舊版 client 已被要求 PO token / 直接拒絕） |

**結論（影響架構）**：
- CF Worker（或任何 datacenter 端）**不可能**直接抓 caption track。ext 走使用者自己的 IP + cookie 是唯一可靠的 ingest 路徑。→ **Phase 1 的 ext 方案確定必要，不是備案。**
- Phase 4 的「住宅 IP fetch node」如果要做，也必須跑在家用網路，不能上雲。

## 2. 環境限制備忘（開發用，與產品無關）

- 這個雲端 session 的 egress proxy 會 reset Chromium（BoringSSL）的 TLS ClientHello（curl/openssl 正常），所以 **sandbox 內無法用 Playwright 開真實瀏覽器測 YouTube**。已試過關 post-quantum、ECH、HTTP/2、QUIC 均無效 — 屬 proxy 端限制。
- 因此以下第 3 節的實測必須在使用者自己的 Chrome 上執行。

## 3. 待使用者執行：瀏覽器端實測 ⏳

**執行方式**：
1. 開一支 YouTube 影片頁 → DevTools Console → 整段貼上 `phase0/devtools-probe.js` → 會自動下載 `phase0-<videoId>.json`
2. Console 會印出一行 CORS 測試 snippet → 到 `https://example.com` 的 Console 貼上，記下輸出（`CORS OK` 或 `CORS BLOCKED`）
3. 至少跑三支：一支**官方英文字幕**、一支**只有 ASR**、一支**多語系**
4. 把下載的 JSON 丟進 repo 的 `phase0/out/`，連同 CORS 結果回報

### 3.1 caption track 結構實例（3 支影片）

_待回填（來源：`phase0/out/*.json` 的 `captionTracks` 欄位）_

### 3.2 `baseUrl&fmt=json3` 回傳格式範例

_待回填（來源：`trackSamples[].firstEvents`）_

### 3.3 CORS 測試結果（關鍵問題）

_待回填。判定：_
- _若 `CORS BLOCKED`（預期）→ ext 是唯一 ingest 路徑，維持 handoff 架構_
- _若 `CORS OK` → player 頁可直接在瀏覽器端抓軌，ext 可省_

_輔助證據：probe 也會記錄 timedtext 回應的 `Access-Control-Allow-Origin` 標頭（`trackSamples[].corsHeaders`）；若為 `null`，跨域 fetch 必被擋。_

### 3.4 ASR 軌 vs manual 軌內容差異

_待回填（標點、大小寫、斷句的實例比較）_

### 3.5 附帶要驗證的陷阱：SPA 導航後的 stale global

probe 會回報 `globalVar.staleAfterSpaNav`：在站內點擊切換影片後，`window.ytInitialPlayerResponse` 是否還停留在上一支影片。這決定 Phase 1 ext 要不要一律走「重新 fetch HTML 再 parse」的路徑。

---

## 附錄：本次探測工具

| 檔案 | 用途 |
|---|---|
| `phase0/devtools-probe.js` | **主要工具**。貼進 YouTube 影片頁 Console，產出完整 findings JSON |
| `phase0/probe-server.mjs` | server 端探測（本次用它證明 datacenter IP 被封）；`NODE_USE_ENV_PROXY=1 node probe-server.mjs <videoId>` |
| `phase0/probe.mjs` | Playwright 版（sandbox 內因 proxy TLS 限制跑不了；在本機裝了 playwright 可用） |
