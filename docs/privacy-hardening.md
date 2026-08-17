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

## 3. Turnstile challenge（程式已實作，**目前休眠**）

> 📌 **先看 §3.1**：實際採用的是 WAF 的 UA 型 Managed Challenge，
> ytplayer 這套 Turnstile 沒設環境變數所以不生效（保留為隨時可啟用的選項）。
>
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

### Turnstile vs WAF challenge：**要看規則怎麼寫，不是二選一**

> ⚠ 我一開始說「兩個都開會被問兩次」—— **只有路徑型規則才會**。修正如下：

| challenge 規則的觸發條件 | 與 app 端 Turnstile 共存？ |
|---|---|
| **路徑型**（挑戰所有頁面瀏覽） | ❌ 會問兩次 —— 真人先過 WAF、再過 Turnstile |
| **UA 型**（UA 含 bot/crawl 才挑戰） | ✅ **不重疊** —— 真人 UA 不含 bot/crawl，WAF 根本不匹配，直接交給 app 自己的 Turnstile |

| | Turnstile（應用層程式） | WAF Managed Challenge（邊緣層） |
|---|---|---|
| 設定在哪 | site key 進 `wrangler.jsonc`、secret 存 **Secret 型態** | dashboard 一條規則 |
| 會不會被部署踩掉 | site key 進 repo 後不會；**明文變數會**（已踩三次）| **不會**（Zone 層，與 Worker 部署無關）|
| 版本控管 | ✅ 在 git 裡、有 10 個測試 | ❌ 改了沒紀錄 |
| 精細度 | 知道「自己人（key/Access）」「搜尋引擎」「已通過」 | 只能用 UA／路徑／`cf.client.bot` 表達 |
| 自己會不會被問 | 帶 `?key=` 或 Access 就**完全不問** | 看規則；UA 型的話真人完全不會被問 |
| 通行期限 | 30 天 | Challenge Passage 設定（預設 30 分鐘） |
| 涵蓋範圍 | 只有這個 Worker 的頁面 | **整個 zone 的所有主機與路徑** |

### 2026-08-17 的 var-stomping 教訓（第三次）

TURNSTILE_SITE_KEY / TURNSTILE_SECRET 加在 dashboard 的**明文變數**，
下一次 git 部署就被 `wrangler.jsonc` 的 `vars` 區塊整個蓋掉（`/health` 的
`turnstileConfigured` 變回 false）。**這就是硬規則 #1**。
正確做法二選一：site key 寫進 `wrangler.jsonc`（它本來就是公開值），
或兩個都存成 **Secret 型態**（Secret 不受部署影響）。

## 3.1 實際採用的方案（2026-08-17 定案，別重新研究）

**WAF Managed Challenge + UA 條件**，建在 `ai-apps.work` zone 底下，
所以 **ytplayer 與三兄弟（kikemu／sukemu／manemu）全部涵蓋**：

```
(http.user_agent contains "bot" and not cf.client.bot)
  or (http.user_agent contains "crawl" and not cf.client.bot)
→ Managed Challenge
```

`not cf.client.bot` = 放行 Cloudflare **驗證過的**正牌爬蟲（讓它讀到 noindex），
冒名的 Googlebot 照樣被擋。

**ytplayer 的 Turnstile 程式碼維持休眠**（沒設環境變數 = 自動不生效），
三兄弟各自的 Turnstile **繼續用**，兩者不衝突（UA 型規則不碰真人）。

### 實測驗證（2026-08-17，不用再測一次）

| 測試 | 結果 | 判讀 |
|---|---|---|
| UA 含 `bot`／首頁 | 403 `cf-mitigated: challenge` | WAF 生效 |
| UA 含 `crawl`／`/subs/*.json` | 403 challenge | 規則沒設路徑條件 → **連字幕檔也包到** |
| 一般瀏覽器 UA | 200、無 challenge 標頭 | 真人零摩擦 |
| 假 Googlebot（機房 IP） | 403 challenge | `cf.client.bot` 只認驗證過的，冒名照擋 |
| `python-requests` | 403、**無** cf-mitigated | 是 Worker 的 UA 名單擋的，不是 WAF |
| manemu 真人 UA | 200、無 challenge | **三兄弟的訪客不會被問兩次** |

### 分工結論

```
自報身分的爬蟲   → WAF Managed Challenge（zone 層，全站台涵蓋）
偽裝成瀏覽器的   → 各站自己的 Turnstile（三兄弟有；ytplayer 靠 UA 名單 + noindex）
搜尋引擎收錄     → noindex（challenge 不管這件事）
```

**這套擋不到什麼**：偽裝成 Chrome 的 scraper、無頭瀏覽器 —— 兩層都穿得過。
要擋它們就得改成路徑型規則，代價是每個真人訪客（含你分享連結給的人）都要過閘門。
以「noindex + 網址不可猜的自用工具」的威脅模型來說**不划算，所以刻意不做**。

### ⚠ zone 層規則的副作用（三兄弟都要想一遍）

1. **連結預覽會消失**：Slackbot／Twitterbot／Discordbot 的 UA 都含 `bot`，
   在聊天軟體貼連結不會有預覽卡。對刻意 noindex 的站台算附贈的好處
2. **機器對機器的 callback 會靜默失敗**：LINE／Telegram／Slack 推送、
   GitHub webhook（UA `GitHub-Hookshot`）、金流回呼、外部 cron ——
   只要 UA 含 `bot` 就被 challenge 擋掉，對方收到 403，你這邊毫無動靜。
   **有這類流量的話**：加一條 **Skip** 規則排除那些路徑（Free 版 5 條規則，還剩 4 條），
   順序放在 challenge 規則之前；或給 challenge 規則加主機條件

### 方案成本（2026-08-17 查證）

| | Free 方案 |
|---|---|
| WAF Custom Rules | **5 條**，動作除了 Log 以外全部可用（含 Managed Challenge）|
| Turnstile | 免費：每帳號 20 個 widget、每月 100 萬次 siteverify |

來源：[WAF custom rules](https://developers.cloudflare.com/waf/custom-rules/)、
[Turnstile plans](https://developers.cloudflare.com/turnstile/plans/)

## 3.2 沒採用的方案（別重新提案）

- ❌ **路徑型 challenge**（挑戰所有頁面）：真人也要過閘門，且與三兄弟的 Turnstile 疊成兩次
- ❌ **Bot Fight Mode**（Security → Bots）：全站無差別，會連 `/ingest`、`/subs` 一起挑戰，
  ext 與 player 都會壞。要路徑豁免得用 Super Bot Fight Mode（付費）
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
| 3 | **WAF Managed Challenge（UA 型，zone 層）** —— ytplayer + 三兄弟全涵蓋 | 已做（§3.1，實測過）|
| 3b | Turnstile（應用層，HMAC 簽章通行證 30 天） | 程式好了、**刻意休眠**；三兄弟各自有自己的 |
| 4 | 清單頁 key-gate、`/admin` Cloudflare Access、API key | 已做 |

殘餘風險不變且已接受：**拿到 `/watch/{id}` 連結的人看得到那支影片的字幕**。
真的要關掉這條，得讓 `/watch` 也走 key-gate —— 但那就不能分享了，是另一個取捨。
