// 非英文 ASR 品質量測：把 pipeline 的產出與「創作者人工軌」在時間軸上對齊，
// 輸出可人工判讀的對照樣本。用來驗證 handoff-append-01 §C 的假設
//（「非英文 ASR 轉寫不可信」）在 2026 年是否仍成立。
//
// 用法：
//   node compare-tracks.mjs <bilingual.json 網址或路徑> <參考 source.json 路徑> [樣本數]
//
// 參考軌可以是：
//   - 創作者的人工繁中軌 → 比對「意思」（端到端：ASR + 翻譯是否正確）
//   - 同語言的人工軌（若有）→ 比對「轉寫」（純 ASR 錯誤率）

import { readFileSync } from 'node:fs';

const [outArg, refArg, sampleArg] = process.argv.slice(2);
if (!outArg || !refArg) {
  console.error('用法: node compare-tracks.mjs <bilingual.json> <參考 source.json> [樣本數]');
  process.exit(1);
}
const SAMPLES = Number(sampleArg || 25);

const load = async (p) =>
  JSON.parse(p.startsWith('http') ? await (await fetch(p)).text() : readFileSync(p, 'utf8'));

const out = await load(outArg);
const ref = await load(refArg);

// 參考軌正規化：source.json 的 cues 是 {start, dur, text}
const refCues = (ref.cues || []).map((c) => ({ start: c.start, end: c.start + c.dur, text: c.text }));
const ours = out.cues || [];

// 時間重疊對齊：取與我方 cue 有交集的參考 cue，串起來
function alignedRef(cue) {
  const hit = refCues.filter((r) => r.end > cue.start + 0.3 && r.start < cue.end - 0.3);
  return hit.map((r) => r.text).join(' ').replace(/\s+/g, ' ').trim();
}

const pairs = ours
  .map((c) => ({ start: c.start, end: c.end, orig: c.en, zh: c.zh, note: c.note, ref: alignedRef(c) }))
  .filter((p) => p.ref.length > 0);

const coverage = ours.length ? ((pairs.length / ours.length) * 100).toFixed(1) : '0';
const refDur = refCues.length ? refCues[refCues.length - 1].end : 0;
const ourDur = ours.length ? ours[ours.length - 1].end : 0;

console.log('='.repeat(70));
console.log(`我方（${out.sourceLang} ${out.track?.kind ?? out.tier === 3 ? 'ASR' : ''}）：${ours.length} cues，片長 ${Math.round(ourDur)}s，model=${out.model} prompt=${out.promptVersion}`);
console.log(`參考（人工軌）：${refCues.length} cues，片長 ${Math.round(refDur)}s`);
console.log(`時間對齊涵蓋率：${coverage}%（${pairs.length}/${ours.length}）`);
if (out.warnings?.length) console.log(`warnings：${out.warnings.join(' | ')}`);
console.log('='.repeat(70));

// 均勻取樣，避免只看開頭
const step = Math.max(1, Math.floor(pairs.length / SAMPLES));
const picked = pairs.filter((_, i) => i % step === 0).slice(0, SAMPLES);
for (const p of picked) {
  const t = `${String(Math.floor(p.start / 60)).padStart(2, '0')}:${String(Math.floor(p.start % 60)).padStart(2, '0')}`;
  console.log(`\n[${t}]`);
  console.log(`  原文(ASR修稿後) ${p.orig}`);
  console.log(`  我方譯文        ${p.zh}`);
  console.log(`  創作者人工      ${p.ref}`);
  if (p.note) console.log(`  譯註            ${p.note}`);
}
console.log(`\n（共 ${pairs.length} 組可對齊，上列為均勻取樣 ${picked.length} 組）`);
