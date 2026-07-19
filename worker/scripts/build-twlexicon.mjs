// 從 OpenCC TWPhrases.txt 產生 src/twlexicon.ts 的 EXTENDED 報告層詞表。
// 用法：node scripts/build-twlexicon.mjs
//
// 分層原則（詳見 docs/lessons-learned.md §5）：
//   prompt 對照表（16 條）— 每個 chunk 都付 token，維持精簡
//   CORE（執法層）— 人工策展、低誤報，命中觸發重譯（twlexicon.ts 內手寫）
//   EXTENDED（報告層）— OpenCC 批量詞表，命中只進 hints 提示，不觸發重譯（本腳本產生）

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'data/TWPhrases.txt'), 'utf8');

// 台灣本來就常用（他義）的詞：一放進掃描就是誤報製造機，一律跳過
const SKIP = new Set([
  '水平', // 水平線、水平方向（horizontal）
  '支持', // 我支持你
  '對象', // 交往對象
  '數字', // digits
  '文檔', // 技術圈常指「文件與檔案」合稱（speak-human-tw 建議放行）
  '落地', // 飛機落地（本專案有航太影片）
  '打法', // 棋類/遊戲
  '復盤', // 口語可保留
  '界面', // 界面活性劑（化學）
  '成人', // 常用
  '航天', // 專有語境（航天飛機另有條目會抓）
]);

// CORE 執法層已涵蓋的（含 prompts.ts 16 條 + twlexicon CORE_EXTRA）— 由生成結果去重
const CORE_SRCS = [
  '視頻', '質量', '信息', '網絡', '軟件', '硬件', '屏幕', '數據', '用戶', '默認',
  '激活', '調用', '打印', '內存', '優化', '菜單',
  '數據庫', '服務器', '鼠標', '短視頻', '移動端', '立馬', '靠譜', '性價比',
  '兼容', '卸載', '反饋', '智能', '博主', '接地氣', '顆粒度', '直播帶貨',
];

const entries = [];
const seen = new Set();
for (const line of src.split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const [from, to] = line.split('\t');
  if (!from || !to) continue;
  const target = to.split(' ')[0].trim();
  const key = from.trim();
  if (key.length < 2 || key === target || !target) continue;
  if (SKIP.has(key) || seen.has(key)) continue;
  // CORE 已管的詞（含其複合詞，如「軟件包」被「軟件」涵蓋）不重複收
  if (CORE_SRCS.some((c) => key.includes(c))) continue;
  seen.add(key);
  entries.push([key, target]);
}

const out = `// 此檔由 scripts/build-twlexicon.mjs 產生，不要手改 EXTENDED — 改 SKIP/CORE 後重跑腳本。
// 資料來源與授權：
//   EXTENDED：OpenCC TWPhrases（https://github.com/BYVoid/OpenCC，Apache-2.0）
//   CORE_EXTRA：speak-human-tw 在地化對照表的人工策展子集
//     （https://github.com/Raymondhou0917/speak-human-tw，MIT）
//     只收「零容忍且在字幕語境無他義」的條目；語境詞（水平/支持/落地…）刻意排除

// 執法層追加（低誤報，命中觸發重譯；與 prompts.ts BANNED_WORDS 合併使用）
export const CORE_EXTRA: Array<[string, string]> = [
  ['服務器', '伺服器'],
  ['鼠標', '滑鼠'],
  ['移動端', '行動裝置'],
  ['立馬', '馬上'],
  ['靠譜', '可靠'],
  ['性價比', 'CP 值'],
  ['兼容', '相容'],
  ['卸載', '移除'],
  ['反饋', '回饋'],
  ['智能', '智慧'],
  ['博主', '創作者'],
  ['接地氣', '貼近日常'],
  ['顆粒度', '細緻度'],
  ['直播帶貨', '直播銷售'],
];

// 報告層（OpenCC 批量，命中只進 hints 不觸發重譯 — 允許少量誤報換覆蓋率）
export const EXTENDED: Array<[string, string]> = ${JSON.stringify(entries)};
`;

writeFileSync(join(here, '../src/twlexicon.ts'), out);
console.log(`EXTENDED ${entries.length} 條（來源 ${src.split('\n').length} 行，跳過語境詞 ${SKIP.size} + CORE 涵蓋）`);
