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

## 3. Turnstile challenge（**已實作**，2026-08-17）

> ⚠ **只加環境變數不會生效**。Turnstile 不是開關，是一段流程：
> 頁面要渲染 widget、後端要拿 token 去 `siteverify`、通過後要發通行證。
> 這三段都在 `worker/src/turnstile.ts` 與 `index.ts`。

### 流程

```
GET /watch/xxx  →  沒有通行證 cookie？
                   ├ 有 → 照常給頁面
                   └ 沒有 → 回 challenge 頁（Turnstile widget）
                             ↓ 過關拿到 token
                        POST /turnstile/verify  →  Cloudflare siteverify
                             ↓ 成功
                        Set-Cookie: ytp_pass=<exp>.<HMAC 簽章>（30 天）
                             ↓
                        location.replace(原本要去的網址)
```

### 四個「直接放行」的情況（缺一不可）

| 情況 | 為什麼 |
|---|---|
| 兩個環境變數沒設齊 | **沒設定就完全不生效** —— 半套的安全機制比沒有更糟 |
| 正牌搜尋引擎（`botVerdict` 判定） | 擋了它就讀不到 noindex（同 §2 的坑） |
| 自己人（`?key=` / `x-ingest-key` / Access 通過） | 不要讓自己每次都過閘門 |
| 已有有效通行證 cookie | 30 天內只問一次 |

### 為什麼通行證要簽章

`ytp_pass` 的值是 `到期秒數.HMAC-SHA256(secret, 到期秒數)`。
**不簽章就等於「有 cookie 就算數」**，爬蟲隨手塞一個就繞過去了。
簽章用的就是 `TURNSTILE_SECRET` —— 換掉 secret 等於一次撤銷所有通行證。
無狀態設計，不需要 KV/DO 存 session。

### ⚠ 設定方式：**兩個都要用 Secret，不能用明文變數**

`TURNSTILE_SITE_KEY` 雖然是公開資訊（會出現在 HTML 裡），但如果你把它加成
**dashboard 的明文變數**，下一次 git 部署就會被 `wrangler.jsonc` 的 `vars` 覆蓋掉
—— 這就是硬規則 #1 的 var-stomping，2026-08-13 的帳單事故成因之一。

```
Workers → Settings → Variables and Secrets → 型態選 Secret（不是 Text）
  TURNSTILE_SITE_KEY   = 0x4AAAAAAA…
  TURNSTILE_SECRET     = 0x4AAAAAAA…
```

驗證有沒有吃到（部署後）：

```bash
curl -s https://ytplayer.ai-apps.work/health | grep turnstileConfigured   # 要是 true
curl -s https://ytplayer.ai-apps.work/ | grep -o 'cf-turnstile'           # 出現 = 閘門生效
curl -s "https://ytplayer.ai-apps.work/?key=你的KEY" | grep -c cf-turnstile # 0 = 自己人不被擋
```

### 不擋的路徑（沿用 §2 的分界）

`/subs/*`、所有 API、`/health`、`/robots.txt`、`/manifest.webmanifest`、`/sw.js`、圖示。
player 頁抓字幕、ext ingest、PWA、本機 ab-runner 都不受影響。

### 二選一：Turnstile（應用層）vs WAF Managed Challenge（邊緣層）

**兩條路擇一，不要都開** —— 都開會被問兩次。

| | Turnstile（本專案程式） | WAF Managed Challenge |
|---|---|---|
| 設定在哪 | site key 進 `wrangler.jsonc`、secret 存 **Secret 型態** | dashboard 一條規則 |
| 會不會被部署踩掉 | site key 進 repo 後不會；**明文變數會**（已踩兩次）| **不會**（Zone 層設定，與 Worker 部署無關）|
| 版本控管 | ✅ 在 git 裡、有 10 個測試 | ❌ 改了沒紀錄 |
| 精細度 | 知道「自己人（key/Access）」「搜尋引擎」「已通過」 | 只能用路徑與 `cf.client.bot` 表達 |
| 自己會不會被問 | 帶 `?key=` 或 Access 就**完全不問** | 會問，過一次給 cookie（預設 30 分鐘） |
| 通行期限 | 30 天 | Challenge Passage 設定（預設 30 分鐘） |

**建議**：如果你不想再管 secret，就用 **WAF Managed Challenge** ——
Turnstile 程式碼沒設定就自動休眠，不會衝突、也不用刪。
如果你想要「自己人完全不被打擾 + 設定進版控」，就走 Turnstile。

### 2026-08-17 的實際教訓

TURNSTILE_SITE_KEY / TURNSTILE_SECRET 加在 dashboard 的**明文變數**，
下一次 git 部署就被 `wrangler.jsonc` 的 `vars` 區塊整個蓋掉（`/health` 的
`turnstileConfigured` 變回 false）。**這就是硬規則 #1**，第三次踩到。
正確做法二選一：site key 寫進 `wrangler.jsonc`（它本來就是公開值），
或兩個都存成 **Secret 型態**（Secret 不受部署影響）。

## 3.1 Cloudflare WAF challenge（替代方案，dashboard 設定）

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

| 層 | 內容 | 狀態 |
|---|---|---|
| 1 | 全站 `X-Robots-Tag: noindex, nofollow, noarchive` + meta；robots.txt 維持 Allow | 已做 |
| 2 | `workers.dev` 關閉、UA 爬蟲閘門 403 | 已做 |
| 3 | **Turnstile challenge**（頁面路徑，HMAC 簽章通行證 30 天） | 已做 —— 只要 Secret 設齊就生效 |
| 4 | 清單頁 key-gate、`/admin` Cloudflare Access、API key | 已做 |

殘餘風險不變且已接受：**拿到 `/watch/{id}` 連結的人看得到那支影片的字幕**。
真的要關掉這條，得讓 `/watch` 也走 key-gate —— 但那就不能分享了，是另一個取捨。
