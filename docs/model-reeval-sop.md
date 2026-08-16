# 模型重評 SOP（什麼時候該重測、怎麼測）

> 狀態：**已採用為常規**（2026-08-16，future-ideas F3 落地）。
> 存在理由：`model-experiment.md` 的結論會過期。沒有明文的觸發條件與流程，
> 就只有兩種下場 —— 永遠不敢動，或憑印象亂換。兩種都會出事。

## 1. 觸發條件（滿足任一才值得花錢重測）

| 觸發 | 為什麼 |
|---|---|
| **3.6-flash**：F1 回聲對位上線後 | 它當初就是被「id 對滑」打回的（`model-experiment.md`），而回聲對位正是為了擋這件事。前提已備妥 → 該重測 |
| **3.7-flash**：官方補上 `minimal` 檔位 | 沒有 minimal 就有 thinking 稅地板，成本結構整個不同（`gemini-api-lessons.md` §1） |
| **任何模型**：3.5-flash 被標 deprecated | 被動觸發，沒得選 |
| **任何模型**：牌價變動 > 30% | 成本結構變了，原本「贏在便宜」的結論可能翻盤 |
| **協定改動**（如 F1、F2） | 協定會改變模型的表現差距 —— lite 級尤其明顯 |

不在表上的理由（「新模型看起來很強」「有人說很好用」）**不是**觸發條件。

## 2. 固定五步（每次都一樣，不要臨場發明）

1. **固定樣本**：`hK9fypJKHyY`（英 ASR、274 句、9 分鐘）與 `9gHJwbSHPus`（日 ASR、686 句）。
   換樣本就等於換尺，歷史數據不能比。
2. **先量自然變異**：現行設定跑 **3 次**，記下每個指標的 min/max/mean。
   ```bash
   node /tmp/ab-runner.mjs hK9fypJKHyY gemini-3.5-flash /tmp/ab/base --repeat 3
   ```
   **沒有這把尺就不要往下走** —— 單次差距落在自然變異裡的話，它什麼都不是。
3. **跑候選**：同樣 3 次、同一支片、只改一個變因（模型 or 協定 or chunk 大小，一次只改一個）。
4. **硬指標**（`summary.json` 的 variance 區塊直接可比）：
   `untranslated`／`warnings`／`drift`／`echoRejects`／`tokens`／`estNTD`／`retries`。
   判讀規則：**候選的 mean 要超出基準的 min–max 區間才算有差**。
5. **軟指標（不可省）**：抽樣 10–15 句人工比對。
   id 對滑與「穩定地錯」自動指標測不到 —— 這是 3.6-flash 當初被抓到的方式。

結論回填 `model-experiment.md`（含**負面結果**：否決的實驗和勝出的一樣值錢），
勝出者才改 `worker/wrangler.jsonc`（模型的單一事實來源，dashboard 改的會被部署蓋掉）。

## 3. 復現指令

```bash
npx esbuild worker/scripts/ab-runner.ts --bundle --platform=node --format=esm --charset=utf8 \
  --outfile=/tmp/ab-runner.mjs --loader:.json=json \
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"

NODE_EXTRA_CA_CERTS=… gemini_key=… \
  node /tmp/ab-runner.mjs <videoId> <model> <outDir> --repeat 3
# 變因用環境變數：CHUNK_SIZE=20、TRANSLATE_PROTOCOL=array
```

runner 不碰 production R2（source 從公開端點抓、輸出寫本機），所以隨時可跑，
不會污染線上資料，也不會被線上的 job 干擾。

## 4. 成本

單支英文樣本一輪 ≈ NT$5–7（lite 約 NT$0.9）→ **基準 3 次 + 候選 3 次 ≈ NT$35**；
兩支樣本都跑 ≈ NT$90。這是「換模型」這個決定的合理價格：
2026-08-13 的帳單事故一天就是 NT$1000+。

⚠ **費率逐模型分開**：runner 的 `RATES` 表按模型名比對（lite / 3.6-flash / 其他）。
拿 flash 費率去估 lite 會高估 5 倍 —— 2026-08-16 差點因此誤判 F2 的成本 gate
（「只降 37%」實際是「降 85%」）。加新模型時**先確認費率表有它**，否則會落到保守的 flash 費率。

## 5. 紀錄

| 日期 | 觸發 | 候選 | 結論 | 文件 |
|---|---|---|---|---|
| 2026-08-14 | 帳單事故後盤點 | 3.5-flash / 3.6-flash × thinking 開關 | 3.5-flash + minimal 勝 | [model-experiment.md](model-experiment.md) |
| 2026-08-14 | lite 缺句 | 3.5-flash-lite + chunk 20 | 否決（缺句更多） | 同上 E 組 |
| 2026-08-16 | F1 協定改動 | v4 vs v5（回聲對位） | 採用（抓到真實對滑，代價 +14%） | [future-ideas.md](future-ideas.md) F1 |
| 2026-08-16 | F1 上線 → 前提備妥 | 3.6-flash | **維持禁用**（慢 4.5 倍、更貴、未譯更多）| [exp-2026-08-16.md](exp-2026-08-16.md) E3 |
| 2026-08-16 | F2 協定改動 | lite × id vs 位置對齊 | 假說成立（-85% 成本），但預設仍用 flash | 同上 E4 |
