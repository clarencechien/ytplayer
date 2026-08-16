# PWA + 手機送片計畫（桌機補收路線）

> 狀態：**已實作**（2026-08-14）。實作與計畫的差異記在 §9。
> 定案前提（2026-08-14 討論）：**不做伺服器端抓字幕**。手機送進來的片一律走
> 「待補字幕佇列 → 桌機 ext 補收」；急件用既有 video 路由（看片，明碼標價）。

---

## 1. 定性：這不是魔改 YT app

- 「魔改」= 改 YouTube 的 APK/binary（Vanced 那類）。本計畫全程碰不到：PWA 是自己的網站、
  分享連結走 OS share sheet（YouTube app 自己提供的功能）、ext 只觀察自己瀏覽器的流量
- **刻意不做的那格**：伺服器拿 link 自動抓 YouTube 字幕。不是魔改但是自動化存取——
  timedtext 有 POT 防護（phase0 實測：同源帶 cookie 也拿到空 body）、資料中心 IP 被 bot
  判定（kvsplayer 的 innertube 多 client 常全滅）。**可靠性與 ToS 都輸**，不當地基。
  （未來若想當「機會主義加速器」——先試 innertube、失敗進佇列——是選配，須另開決策）

## 2. 目標與非目標

**目標**
1. 手機/平板能把 player「安裝」起來用（PWA：主畫面 icon、standalone 全螢幕）
2. 手機看到影片 → 分享/貼上連結 → 進「待補字幕」佇列，立刻得到「已排隊」回饋
3. 桌機開 Chrome 時被提醒有待補片，一鍵開分頁 → 照既有流程攔截送出 → 佇列自動銷帳

**非目標**
- 伺服器端抓字幕（§1）
- iOS share target（iOS PWA 不支援；退路見 §4.3）
- Firefox Android 移植 ext（FF 128+ 支援 `world: "MAIN"`，理論可行 — 記 future，另開計畫）
- 離線播放/快取影片（PWA 只殼，不快取內容）

## 3. 架構總覽

```
手機（PWA）                Worker + R2                     桌機（Chrome ext）
────────────              ─────────────                   ─────────────────
分享/貼上 link ──POST /inbox──▶ inbox/{videoId}.json ◀──GET /inbox.json── popup 顯示待補清單
     ▲                              │                        │ 點擊 → 開 YouTube 分頁
「已排隊」回饋                        │                        ▼ 使用者開 CC 選原文軌（既有流程）
                                    │◀────── 自動銷帳 ──── /ingest 成功
清單頁顯示 inbox 區塊（可刪）          └─ 急件：改按「看片模式」→ 既有 /watch-job（貴 30 倍）
```

## 4. 設計細節

### 4.1 Worker：inbox 佇列（新）

- R2 形狀：`inbox/{videoId}.json` → `{ videoId, url, requestedAt, via: "share"|"paste", title? }`
  （獨立 prefix，不進 `subs/`——此時還沒有 source；title 盡力用 oEmbed 補，失敗留空）
- 端點（全部 key 認證——**inbox = 觀看意圖 = 隱私**，與 /videos.json 同級）：
  - `POST /inbox` `{ url }` → 解析 videoId（`v=`/`youtu.be`/`shorts` 同 admin 頁 regex）→ 寫入。
    已有 source/bilingual 的片回「已經有了」+ watch 連結，不重複排
  - `GET /inbox.json` → 清單（ext popup 與 PWA 頁共用）
  - `DELETE /inbox/{videoId}` → 手動移除
  - `/ingest` 成功時：順手刪 `inbox/{videoId}.json`（**自動銷帳**，補收閉環的關鍵）
- 清單頁（`/`）加「待補字幕」區塊：手機上看得到自己排了什麼、可刪、可一鍵改走看片模式

### 4.2 PWA 殼（player.ts + 新靜態路由）

- `GET /manifest.webmanifest`：name/short_name、`display: "standalone"`、theme/background 色、
  icons（192/512，先用程式生成的單色圖示即可）、`share_target`（見 4.3）
- `GET /sw.js`：**極簡 service worker**——只做安裝資格（fetch handler passthrough，
  network-first、不快取 API）。刻意不做離線快取：快取失效的維運成本 > 自用收益
- 兩個 HTML template（player/清單）補 `<link rel="manifest">` + iOS meta
  （`apple-mobile-web-app-capable`、`apple-touch-icon`）

### 4.3 手機入口

- **Android（主路徑）**：manifest `share_target`（GET 模式）→ `/share?url={link}`。
  頁面從 localStorage 拿 key（與清單頁同一套 `ytplayer-key`）→ POST /inbox →
  顯示「✅ 已排隊，桌機開 Chrome 時會提醒補收」＋兩個按鈕：「改用看片模式（≈30 倍費用）」、
  「查看佇列」。沒 key → 導去 `/?key=` 流程說明
- **iOS（退路）**：無 share target。PWA 首頁頂部給**貼上框**（paste + 解析 + 送 inbox）。
  選配：iOS 捷徑範本（POST /inbox 帶 key）——key 會存在捷徑裡，自用可接受，文件註明風險
- 桌機瀏覽器開 `/share` 一樣能用（等於手動貼 link 的第二入口）

### 4.4 桌機 ext 補收（popup 改動）

- popup 開啟時 `GET /inbox.json` → 頂部顯示「📥 待補 N 支」清單，點一項 →
  `chrome.tabs.create({ url: watch 頁 })` → 使用者照既有流程開 CC 選原文軌 → ext 攔截 →
  送出成功 → worker 自動銷帳 → popup 下次刷新消失
- **badge 提醒**：`chrome.alarms` 每 30 分鐘（或 popup 開啟時）抓 inbox 數量，
  `chrome.action.setBadgeText` 顯示數字——「桌機開瀏覽器會被提醒」靠這個成立
- 刻意**不做**自動開分頁/自動選軌：選哪條軌本來就是人的判斷
  （Tier 1 重做要選原文軌、多語言軌要挑）；自動化採收也最容易滑向灰色地帶。
  減步驟靠「記住上次語言偏好、預選同語言軌」即可（選配）

### 4.5 隱私

- inbox 全端點 key-gated（觀看意圖比觀看紀錄更私密）；noindex 全站已生效
- share target 的 URL 會短暫出現在 `/share?url=…`——頁面處理完即 `history.replaceState`
  清掉（與 key 的既有處理同款）

## 5. 驗收 Gates

| # | 驗收 | 平台 |
|---|---|---|
| G1 | Chrome/Android 與 Safari/iOS 可「加入主畫面」，standalone 開啟 player 正常播放 | 手機 |
| G2 | Android：YouTube app 分享 → ytplayer → 排隊成功訊息；iOS：貼上框排隊成功 | 手機 |
| G3 | 桌機 ext badge 出現數字；popup 列出待補片；點擊開分頁 → ingest 成功後佇列自動銷帳 | 桌機 |
| G4 | 已翻過的片再分享 → 回「已經有了」+ watch 連結，不重複排 | 兩端 |
| G5 | 無 key 情境不洩漏 inbox 內容（403），且有清楚的補 key 指引 | 兩端 |

## 6. 工作量估計

| 件 | 估計 |
|---|---|
| Worker inbox 端點 + ingest 銷帳 + 測試 | 半天內 |
| PWA 殼（manifest/SW/meta/icons）+ share 頁 | 半天內 |
| ext popup 待補清單 + badge | 半天內 |
| 清單頁 inbox 區塊 | 小 |

合計約 1–1.5 天，全程無新外部依賴、無新花費面（inbox 純 R2 讀寫，零 LLM）。

## 7. 風險與備註

- ext 更新仍是手動（`chrome://extensions` reload）——badge 功能上線時記得提醒
- share target 的 manifest 改動在已安裝的 PWA 上有更新延遲（瀏覽器週期性 revalidate），
  驗收時可能要重裝一次
- `chrome.alarms` 需要 manifest 加 `alarms` 權限；badge 輪詢帶 key（storage 已有）
- inbox 不設自動過期：自用量小，髒了手動刪；若堆積成患再加 TTL

## 9. 實作紀錄（2026-08-14）

全部照計畫做完，兩點與計畫不同：

1. **圖示用內嵌 1×1 PNG**（`/icon-192.png`、`/icon-512.png` 由 Worker 產生）——
   避免在 repo 放二進位檔；夠格取得可安裝資格。想要好看的圖示再換掉即可
2. **badge 走 `chrome.alarms`（30 分鐘）+ popup 開啟時刷新 + ingest 成功後主動刷新**——
   比計畫多了第三條，讓「送出後佇列立刻消失」的回饋是即時的

驗收 G1–G5 需要真機（手機安裝、Android 分享、ext 重載），列在下方待人工確認。

## 8. 決策（人工填寫）

```
決策：____（照此計畫實作 / 修改後實作 / 擱置）
日期：____
理由：____
```
