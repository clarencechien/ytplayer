# Gemini API 教訓 — manemu 摘要版

> 建議放 `GEMINI-LESSONS.md`（repo 根目錄，與 `voice-pipeline-decision-map.md` 並列），
> 並在 README 的「Repo 結構」表加一列連結（順手把 voice-pipeline-decision-map.md 也連上 — 它目前是孤兒文件，全 repo 沒有任何地方引用它）。
> Canonical 完整版：[ytplayer/docs/gemini-api-lessons.md](https://github.com/clarencechien/ytplayer/blob/main/docs/gemini-api-lessons.md)（2026-08-13 v2，已對官方文件核實）。

---

## 通用教訓 TL;DR（完整論證見 canonical）

1. **Thinking 稅**：generateContent 系模型預設開推理，thinking token 以輸出價計費（官方明載）。
   機械性任務（翻譯/抽取/分類）用 `thinkingLevel: "minimal"` 或 `thinkingBudget: 128` 關掉，
   備 400 fallback（拿掉 thinkingConfig 重試）；budget 與 level 永不同時給。
   **好消息：Live API 路徑 thoughts=0（kikemu 114 次實測），本 repo 主力的 Live 口譯不在災區。**
2. **換模型先同料 A/B**：3.6-flash 有公開社群 regressions 回報 + ytplayer 實測 batch id 對滑；
   便宜（輸出 $7.50 < $9.00）不等於可用。
3. **牌價**（2026-08-14 官方核實）：3.5-flash $1.50/$9.00、3.5-flash-lite $0.30/$2.50；
   3.6-flash 與新出的 3.7-flash 促銷 **$0.75/$3.75（至 2026-12-31，之後 $1.50/$7.50）**；
   `gemini-3.6-flash-lite`/3.7-lite 不存在；模型 ID 先 `GET /v1beta/models` 驗證。
   3.7-flash **不支援 Live API** — 本 repo 主力路徑不受影響、也換不過去；
   且 3.7 沒有 minimal 思考檔，機械任務（backtranslate）別遷。
4. **wrangler.jsonc `vars` 蓋 dashboard 明文變數**（本 repo 已守規矩：模型 ID 全在 vars）；
   HKG colo → "User location is not supported" 400，重試有效只因換 colo — 更穩是查 `request.cf.colo` 改路由。
5. **保險絲計量單位要對齊計費單位**（本 repo 最大缺口，見下）。
   供應商端旋鈕已到位：AI Studio Spend 頁每專案花費上限 + prepaid，開工先設。

## 本 repo 專屬 findings（這次盤點發現）

- **本 repo 沒有任何地方設 thinkingConfig**（grep 零筆）。Live 路徑不需要；
  但 `/api/backtranslate`（3.5-flash-lite，`temperature:0` only）是機械任務 —
  findings.md 自己量到 3.5-flash 預設 p50 3.3s 並註記「thinking 預設開啟，太慢」，
  lite 的預設是 minimal（不是 off），仍有未計量的稅。
- **findings.md §3.6 的「thinking off → ~0.8s」是無法重現的數字**：repo 裡沒有任何 code path
  關過 thinking。當未驗證主張看待，不要引用。
- **manemu 首創的兩個好招值得寫進所有專案**：計費單位套利（自己按牆鐘秒計量、供應商按 token/音訊計費
  → 結構性安全邊際）＋「沒有輸出就不計費」（relay.ts 只在 gotOutput 才扣配額）。
- **Live setup 的 config 放錯位置 → WS 1007 無聲斷線**（findings.md §2 實測）—
  別把 generateContent 的 thinkingConfig 直接複製進 Live setup。
- `turnComplete` 在 live-translate 不會來，audioStreamEnd 後模型無限吐靜音 —
  **RMS 偵測強制收斂就是計費停損**，不只是 UX。

## 待辦清單（依風險排序，我不動你的 code，列給你決定）

1. **全域日預算未實作**：`m3-spec.md:101` 規格了 `GLOBAL_DAILY_SECONDS`（超過 → 全站暫停），
   wrangler vars 與 relay.mjs 都沒有 — 每人配額擋單人濫用，擋不住帳號數 × 配額的總爆量。
2. **synth.mjs 的靜默成本升級**：主模型 3 次失敗後 fallback 到 **pro 級** TTS 再試 2 次 —
   一次壞輸入最多付 3 次 flash + 2 次 pro。至少加 log/計數，或把 fallback 也鎖 flash 級。
3. **backtranslate 加 `thinkingLevel: "minimal"`（或 budget 128）+ 400 fallback**：
   一行改動，`backtranslate.mjs` 現成 p50/p90 harness 可直接量收益（延遲與成本雙收）。
4. **harness 重試迴圈沒有成本計數器**：`run.mjs`/`judge.mjs`/`synth.mjs` 全是 3 次線性 backoff，
   API 全面故障時 = 每件事 3 倍花費。跑大批前先看 or-plan.md 那套「預先宣告預算」的做法，值得制度化。
5. 所有配額都以秒計 — 若未來加任何 token 計價的批次功能（如逐字稿摘要），先補 token 保險絲再上線。
