// Glossary 疊層（docs/glossary-layers.md G1）：把「兩套制度並存」收成一套有優先序的合併表。
//
//   ① channel  glossary/channel-{key}.json   人名/節目專名/頻道慣用譯法（人工養，跨影片沉澱）
//   ② genre    glossary/genre-{lang}.json    跨頻道通用（韓綜詞彙、日系 3C 用語…）
//   ③ auto     每支影片 Step B 自動抽          當片專有詞的最後一道網
//
// 同 term 衝突時上層贏；合併總量設上限（每個 chunk 都付 prompt token，表不能無限長）。
// text 路由吃 merge(①②③)、video 路由吃 merge(①②) —— 兩路由同源是這次改動的重點。

import genreKo from './data/glossary-genre-ko.json';
import channel15ya from './data/glossary-channel-15ya.json';

export interface GlossaryEntry {
  term: string;
  zh: string; // 呈現形式：「中文（English）」／保留英文／純中文
  note?: string; // 給非本科觀眾的白話解釋（30 字內）
}

export type GlossaryLayer = 'channel' | 'genre' | 'auto';
export interface LayeredEntry extends GlossaryEntry {
  layer: GlossaryLayer; // 除錯用：看得出這條是誰貢獻的
}

// 上限：每 chunk 的 prompt 都會帶整張表。80 條 ≈ 1.5k tokens/chunk，是可接受的常駐成本
export const GLOSSARY_CAP = 80;

const UCID = /^UC[\w-]{22}$/;

// 比對用正規化（大小寫/全半形/前後空白）；顯示一律用原字串
const normTerm = (t: string): string => t.normalize('NFKC').trim().toLowerCase();

export const langKey = (lang: string | undefined): string => (lang || '').split('-')[0].toLowerCase() || 'xx';

// 頻道名稱 → 檔名安全的 slug（ucid 抓不到時的後備鍵值）
export const channelSlug = (name: string): string =>
  name
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s/\\?#%&+.]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

// 查找順序：ucid 優先（頻道改名不影響），沒有才退回名稱 slug。
// 舊 source 沒有 channelId → 只有 slug；兩種鍵值並存查找是刻意的（docs/future-ideas.md F4）
export function channelKeys(meta: { channel?: string; channelId?: string } | undefined): string[] {
  const keys: string[] = [];
  if (meta?.channelId && UCID.test(meta.channelId)) keys.push(meta.channelId);
  const slug = meta?.channel ? channelSlug(meta.channel) : '';
  if (slug && !keys.includes(slug)) keys.push(slug);
  return keys;
}

// 解析 glossary 檔：接受兩種形狀（陣列 / {entries:[…]}）與兩種欄位名
//（新檔用 term；kvsplayer 遷入的舊檔用語言碼欄位如 ko）— 模型輸出與人工檔案一律當敵意輸入清洗
export function parseGlossaryDoc(raw: unknown): GlossaryEntry[] {
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { entries?: unknown[] } | null)?.entries)
      ? (raw as { entries: unknown[] }).entries
      : [];
  const out: GlossaryEntry[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const zh = typeof o.zh === 'string' ? o.zh.trim() : '';
    const term =
      typeof o.term === 'string'
        ? o.term.trim()
        : // 舊檔：第一個非 zh/note 的字串欄位就是原文（{"ko":"막내","zh":"忙內"}）
          String(Object.entries(o).find(([k, v]) => k !== 'zh' && k !== 'note' && typeof v === 'string')?.[1] ?? '').trim();
    if (!term || !zh) continue;
    const note = typeof o.note === 'string' && o.note.trim() ? o.note.trim().slice(0, 60) : undefined;
    out.push({ term, zh, ...(note ? { note } : {}) });
  }
  return out;
}

export function mergeGlossary(
  layers: { channel?: GlossaryEntry[]; genre?: GlossaryEntry[]; auto?: GlossaryEntry[] },
  cap = GLOSSARY_CAP
): LayeredEntry[] {
  const seen = new Set<string>();
  const out: LayeredEntry[] = [];
  // 順序即優先序：先進的贏；也讓超量截斷天然地先砍掉 ③（自動抽是可再生的，人工表不是）
  for (const layer of ['channel', 'genre', 'auto'] as const) {
    for (const e of layers[layer] ?? []) {
      const term = e?.term?.trim();
      const zh = e?.zh?.trim();
      if (!term || !zh) continue;
      const k = normTerm(term);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ term, zh, ...(e.note ? { note: e.note } : {}), layer });
    }
  }
  return out.length <= cap ? out : out.slice(0, cap);
}

// R2 只用到 get，抽成最小介面（測試/ab-runner 的 MemR2 也吃得下）
export interface GlossaryStore {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

// repo 內建表：讓兩條路由都不依賴任何一次性匯入動作（M5 刪掉 migrate.ts 後仍可用）
const BUILTIN_GENRE: Record<string, unknown> = { ko: genreKo };
const BUILTIN_CHANNEL: Record<string, unknown> = { '15ya': channel15ya };

async function readDoc(store: GlossaryStore, key: string): Promise<GlossaryEntry[] | null> {
  try {
    const obj = await store.get(key);
    if (!obj) return null;
    return parseGlossaryDoc(JSON.parse(await obj.text()));
  } catch {
    return null; // 壞檔不該擋住翻譯：當作沒有這層
  }
}

// ② genre：R2 新檔 → R2 舊檔（watch-{lang}.json，kvsplayer 遺產）→ repo 內建
export async function loadGenreLayer(store: GlossaryStore, lang: string): Promise<GlossaryEntry[]> {
  const k = langKey(lang);
  return (
    (await readDoc(store, `glossary/genre-${k}.json`)) ??
    (await readDoc(store, `glossary/watch-${k}.json`)) ??
    parseGlossaryDoc(BUILTIN_GENRE[k] ?? [])
  );
}

// ① channel：依 keys 順序找第一個有東西的（ucid → 名稱 slug → repo 內建）
export async function loadChannelLayer(
  store: GlossaryStore,
  keys: string[]
): Promise<{ entries: GlossaryEntry[]; key?: string }> {
  for (const key of keys) {
    if (!key) continue;
    const entries = (await readDoc(store, `glossary/channel-${key}.json`)) ?? parseGlossaryDoc(BUILTIN_CHANNEL[key] ?? []);
    if (entries.length > 0) return { entries, key };
  }
  return { entries: [] };
}
