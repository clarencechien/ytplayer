# 隱私加固：關掉 workers.dev + 爬蟲閘門 + challenge

> 威脅模型（migration.md §5）：`/watch/{id}` 是公開可分享的，連結一旦外流又被收錄，
> 「我看過哪些影片」就變成可搜尋的。已有的防線是**全站 noindex**；
> 這份加的是第二、第三層。

## 1. 關掉 `*.workers.dev`（已做，程式碼裡）

```jsonc
"workers_dev": false,
"preview_urls": false,
```

- 對外只留自訂網域 `ytplayer.ai-apps.work`
- 為什麼重要：`workers.dev` 子網域**可以枚舉**，而且它不吃掛在自訂網域上的
  任何 Zone 層設定 —— WAF 規則、Access policy、challenge 全都繞過。
  留著等於在正門旁邊開一道沒鎖的側門。
- 代價：**分支預覽網址也沒了**，要預覽請用本機 `wrangler dev`
- ⚠ 這是 `wrangler.jsonc` 管的（硬規則 #1）：在 dashboard 手動關會被下次部署覆蓋，
  反之亦然 —— 以檔案為準

## 2. Worker 端爬蟲閘門（已做，不需要 dashboard）

`botVerdict(ua)` 對**頁面路徑**（`/`、`/watch/*`、`/admin`、`/share`）分三類：

| UA | 處置 | 為什麼 |
|---|---|---|
| Googlebot／bingbot／DuckDuckBot… | **放行** | ⚠ **關鍵**：擋住它們，它們就讀不到 `X-Robots-Tag: noindex`，反而可能只憑外部連結把網址收進索引 —— 與「robots.txt 用 Disallow 會害死自己」是同一個坑 |
| GPTBot／CCBot／ClaudeBot／Bytespider／AhrefsBot／Scrapy／python-requests… | **403** | 這些不理會 noindex，是真正會把內容抓走的 |
| 沒有 UA | **403** | 瀏覽器不會這樣 |
| 其他（含 curl） | 放行 | curl 是我們自己 debug 用的；UA 本來就能偽造，這層是提高成本不是保證 |

**不擋的路徑**：`/subs/*`（player 頁要抓、本機 ab-runner 也要抓）、
所有 API（`/ingest`、`/patch/*`… 本來就 key-gated）。
擋住頁面就足以讓爬蟲拿不到影片清單與字幕內容 —— 它得先知道 11 碼 videoId 才能碰 `/subs`。

驗證（部署後）：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -A 'GPTBot/1.2' https://ytplayer.ai-apps.work/watch/xxxxxxxxxxx   # 403
curl -s -o /dev/null -w '%{http_code}\n' -A 'Googlebot/2.1' https://ytplayer.ai-apps.work/                  # 200（讀得到 noindex）
curl -s -o /dev/null -w '%{http_code}\n' -H 'user-agent;' https://ytplayer.ai-apps.work/                    # 403（空 UA）
```

## 3. Cloudflare challenge（**要你在 dashboard 點**，我沒有這把鑰匙）

### 這擋得住什麼、擋不住什麼

| | 有效嗎 |
|---|---|
| 無頭爬蟲、腳本 scraper、語料抓取 | ✅ 大多擋得掉（要跑 JS + 通過指紋檢查） |
| 拿到連結、用瀏覽器打開的人 | ❌ 完全擋不住（本來也不該擋 —— 分享是功能） |
| 搜尋引擎收錄 | ⚠ 靠 noindex，不是靠 challenge |

所以 challenge 是**第三層**：noindex（第一層）→ UA 閘門（第二層）→ challenge。

### 建議設定（Free 方案就有）

WAF → Custom rules → Create rule：

```
名稱：challenge-pages
運算式：
  (http.request.uri.path eq "/" or starts_with(http.request.uri.path, "/watch/")
   or http.request.uri.path eq "/admin")
  and not cf.client.bot
動作：Managed Challenge
```

要點：

- **只挑頁面路徑**。千萬別把 `/subs/*` 與 POST API 放進去：
  player 頁抓字幕、ext 送 ingest、PWA 送 `/share` 都會直接壞掉
- `not cf.client.bot` = 放行 Cloudflare 已驗證的正牌爬蟲（同樣是為了讓 noindex 被讀到）
- Managed Challenge 對真人多半是**無感的**（不是圖片點選），且會給 cookie，不會每頁都跳
- `/admin` 若已經掛在 Cloudflare Access 後面，這條對它只是多一層，可留可不留

### 不建議

- ❌ **Bot Fight Mode**（Security → Bots）：它是全站無差別的，會連 `/ingest`、`/subs` 一起挑戰，
  ext 與 player 都會壞。要用得先確認能對路徑豁免（Super Bot Fight Mode 才有，付費）
- ❌ **robots.txt 加 Disallow**：老陷阱 —— 禁止爬取 = 爬蟲讀不到 noindex，
  網址反而可能因為外部連結被收錄（robots.txt 必須維持 Allow）

## 3.5 排錯：`/admin` 登入被導到 kvsplayer（2026-08-17 實例）

症狀：開 `https://ytplayer.ai-apps.work/admin` → 走完 Access 登入後，
瀏覽器停在 `https://kvsplayer.ai-apps.work/cdn-cgi/access/authorized?...` 不動。

診斷（把網址的 `state` 參數 base64 解開就看得到）：

```
hostname    = ytplayer.ai-apps.work     ← 目標其實是對的
redirectURL = /admin/
isSSO       = true                      ← 關鍵
```

Access 登入是**跨 application SSO**：認證完會逐一造訪帳號下每個 app 的
`/cdn-cgi/access/authorized` 去種 cookie。kvsplayer 的 Worker 早就刪了、
主機連不上（curl 直接 status 000），但**保護它的 Access application 還在** ——
於是整條登入鏈斷在那個死掉的主機上。

修法：Zero Trust → Access → Applications → 刪掉 `kvsplayer.ai-apps.work` 的 application。
當下的繞路：卡住後直接重打 `https://ytplayer.ai-apps.work/admin`
（ytplayer 的 cookie 多半已經種好了）。

> 通則：**下線一個服務時，保護它的東西要一起下線**（Access app、DNS、WAF 規則），
> 否則會留下這種只有在登入時才發作的幽靈。已補進 migration.md 的 M5 收工清單。

## 4. 現況總表

| 層 | 內容 | 誰做 |
|---|---|---|
| 1 | 全站 `X-Robots-Tag: noindex, nofollow, noarchive` + meta；robots.txt 維持 Allow | 已做 |
| 2 | `workers.dev` 關閉、UA 爬蟲閘門 403 | 已做（本次） |
| 3 | Managed Challenge on 頁面路徑 | **等你在 dashboard 點** |
| 4 | 清單頁 key-gate、`/admin` Cloudflare Access、API key | 已做 |

殘餘風險不變且已接受：**拿到 `/watch/{id}` 連結的人看得到那支影片的字幕**。
真的要關掉這條，得讓 `/watch` 也走 key-gate —— 但那就不能分享了，是另一個取捨。
