import { describe, it, expect } from 'vitest';
import {
  cleanJson,
  scanBanned,
  scanExtended,
  cleanAsrText,
  chunkSentences,
  translateChunk,
  repairChunk,
  sanityCheckItem,
  assembleBilingual,
  attachGlossaryNotes,
  toSrt,
} from '../src/pipeline';
import type { BilingualCue } from '../src/pipeline';
import type { Sentence } from '../src/segment';
import type { Cue } from '../src/validate';

const sent = (id: number, text = `sentence ${id}.`): Sentence => ({ id, text, cueIds: [id] });
const meta = { title: 't', channel: 'c', description: 'd' };

describe('cleanJson', () => {
  it('接受純 JSON、markdown 圍欄、前後雜訊三種', () => {
    expect(cleanJson('[{"id":0}]')).toEqual([{ id: 0 }]);
    expect(cleanJson('```json\n[{"id":0}]\n```')).toEqual([{ id: 0 }]);
    expect(cleanJson('好的，以下是翻譯：\n[{"id":0}]\n以上。')).toEqual([{ id: 0 }]);
  });
  it('無法解析就丟錯', () => {
    expect(() => cleanJson('完全不是 JSON')).toThrow();
  });
  it('中途截斷的 JSON 救回已完整的部分', () => {
    expect(cleanJson('[{"id":0,"zh":"甲"},{"id":1,"zh":"乙"},{"id":2,"zh":"丙')).toEqual([
      { id: 0, zh: '甲' },
      { id: 1, zh: '乙' },
    ]);
  });
});

describe('scanBanned', () => {
  it('抓中國用語、放過台灣用語', () => {
    expect(scanBanned('這個視頻的質量很好')).toEqual(['視頻', '質量']);
    expect(scanBanned('這支影片的品質很好，軟體與硬體都讚')).toEqual([]);
  });
  it('speak-human-tw 策展追加詞也在執法層', () => {
    expect(scanBanned('服務器不兼容，用鼠標卸載')).toEqual(['服務器', '鼠標', '兼容', '卸載']);
    expect(scanBanned('伺服器不相容，用滑鼠移除')).toEqual([]);
  });
  it('物理的質量（mass）是正確用法，不誤傷', () => {
    expect(scanBanned('龐大的質量流量（Mass flow）與能量')).toEqual([]);
    expect(scanBanned('火箭的質量（Mass）非常大')).toEqual([]);
    expect(scanBanned('質量流量很大，但翻譯質量很差')).toEqual(['質量']);
  });
});

describe('scanExtended（OpenCC 報告層）', () => {
  it('詞表載入正常且能命中（僅提示用）', async () => {
    const { EXTENDED } = await import('../src/twlexicon');
    expect(EXTENDED.length).toBeGreaterThan(500);
    const [bad, good] = EXTENDED.find(([b]) => b === '網吧')!;
    expect(scanExtended(`他在${bad}打電動`)).toEqual([`${bad}→${good}`]);
    expect(scanExtended('他在網咖打電動')).toEqual([]);
  });
  it('執法層與報告層不重疊（視頻只歸執法層）', () => {
    expect(scanExtended('這個視頻的質量')).toEqual([]);
  });
});

describe('cleanAsrText', () => {
  it('去除 [標記] 與 >> 記號，摺疊空白', () => {
    expect(cleanAsrText('When dealing [music] with rockets')).toBe('When dealing with rockets');
    expect(cleanAsrText('>> Hello there')).toBe('Hello there');
    expect(cleanAsrText('so >> what now')).toBe('so what now');
  });
  it('純雜訊句清成空字串（上游會整句移除）', () => {
    expect(cleanAsrText('>> [music]')).toBe('');
    expect(cleanAsrText('[cheering] [applause]')).toBe('');
  });
});

describe('chunkSentences', () => {
  it('40 句一塊、前後 overlap 2', () => {
    const ss = Array.from({ length: 85 }, (_, i) => sent(i));
    const chunks = chunkSentences(ss);
    expect(chunks.length).toBe(3);
    expect(chunks[0].before.length).toBe(0);
    expect(chunks[0].target.map((s) => s.id)).toEqual([...Array(40).keys()]);
    expect(chunks[1].before.map((s) => s.id)).toEqual([38, 39]);
    expect(chunks[1].after.map((s) => s.id)).toEqual([80, 81]);
    expect(chunks[2].target.length).toBe(5);
    expect(chunks[2].after.length).toBe(0);
  });
});

describe('sanityCheckItem（fail-fast，不用 LLM 自我審查）', () => {
  const en = 'the models are really great and can figure out steps';
  it('簡體字直接打回', () => {
    expect(sanityCheckItem(en, '这些模型真的很棒')).toContain('簡體');
    expect(sanityCheckItem(en, '模型可以在护栏内运作')).toContain('簡體');
  });
  it('沒翻（原文照抄 / 無中文）打回', () => {
    expect(sanityCheckItem(en, en)).toBeTruthy();
    expect(sanityCheckItem(en, 'some english output only')).toBeTruthy();
  });
  it('正常繁體譯文通過；短句保留英文（OK、專有名詞）不誤殺', () => {
    expect(sanityCheckItem(en, '這些模型真的很強，能自己想出步驟。')).toBeNull();
    expect(sanityCheckItem('OK.', 'OK。')).toBeNull();
    expect(sanityCheckItem('Katelyn?', 'Katelyn？')).toBeNull();
  });
  it('譯文長度爆走打回', () => {
    expect(sanityCheckItem('Hi there friends.', '哈'.repeat(200))).toContain('長度');
  });
});

describe('translateChunk', () => {
  const chunk = { before: [], target: [sent(0), sent(1)], after: [] };

  it('一次成功', async () => {
    const llm = async () => '[{"id":0,"zh":"零"},{"id":1,"zh":"一","note":"備註"}]';
    const r = await translateChunk(llm, meta, [], chunk);
    expect(r.retries).toBe(0);
    expect(r.byId.get(0)).toEqual({ zh: '零', note: undefined });
    expect(r.byId.get(1)).toEqual({ zh: '一', note: '備註' });
  });

  it('第一次壞 JSON → 重試一次成功', async () => {
    let n = 0;
    const llm = async () => (n++ === 0 ? '不是 JSON' : '[{"id":0,"zh":"零"},{"id":1,"zh":"一"}]');
    const r = await translateChunk(llm, meta, [], chunk);
    expect(r.retries).toBe(1);
    expect(r.byId.size).toBe(2);
  });

  it('缺句 → 重試；兩次都缺 → 回傳部分結果不丟錯', async () => {
    const llm = async () => '[{"id":0,"zh":"零"}]';
    const r = await translateChunk(llm, meta, [], chunk);
    expect(r.retries).toBe(1);
    expect(r.byId.size).toBe(1);
  });

  it('禁用詞命中 → 帶提示重打並採用乾淨版本', async () => {
    let n = 0;
    const llm = async (prompt: string) => {
      if (n++ === 0) return '[{"id":0,"zh":"這個視頻很棒"},{"id":1,"zh":"一"}]';
      expect(prompt).toContain('視頻');
      return '[{"id":0,"zh":"這支影片很棒"},{"id":1,"zh":"一"}]';
    };
    const r = await translateChunk(llm, meta, [], chunk);
    expect(r.retries).toBe(1);
    expect(r.byId.get(0)?.zh).toBe('這支影片很棒');
  });

  it('fail-fast：簡體輸出視同缺句 → 帶提示重試後過關', async () => {
    let n = 0;
    const llm = async (prompt: string) => {
      if (n++ === 0) return '[{"id":0,"zh":"这是简体输出"},{"id":1,"zh":"一"}]';
      expect(prompt).toContain('品質檢查');
      return '[{"id":0,"zh":"這是繁體輸出"},{"id":1,"zh":"一"}]';
    };
    const r = await translateChunk(llm, meta, [], chunk);
    expect(r.retries).toBe(1);
    expect(r.byId.get(0)?.zh).toBe('這是繁體輸出');
    expect(r.problems).toEqual([]);
  });

  it('崩塌偵測：同句譯文重複 3 次只留第一句，其餘視同缺句', async () => {
    const big = { before: [], target: [sent(0), sent(1), sent(2)], after: [] };
    const llm = async () => '[{"id":0,"zh":"重複的譯文內容"},{"id":1,"zh":"重複的譯文內容"},{"id":2,"zh":"重複的譯文內容"}]';
    const r = await translateChunk(llm, meta, [], big);
    expect(r.byId.size).toBe(1);
    expect(r.problems.join(' ')).toContain('重複');
  });

  it('整包兩次失敗 → 切半分治救回（>10 句才切）', async () => {
    const big = { before: [], target: Array.from({ length: 12 }, (_, i) => sent(i)), after: [] };
    const llm = async (prompt: string) => {
      const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
      if (ids.length > 6) return '整包壞掉不是 JSON'; // 大包一律失敗
      return JSON.stringify(ids.map((id) => ({ id, zh: `中${id}` })));
    };
    const r = await translateChunk(llm, meta, [], big);
    expect(r.byId.size).toBe(12); // 兩半各自成功
    expect(r.problems).toEqual([]);
    expect(r.retries).toBeGreaterThan(0);
  });

  it('分治後仍缺 → problems 記載原因', async () => {
    const big = { before: [], target: Array.from({ length: 12 }, (_, i) => sent(i)), after: [] };
    const llm = async () => '永遠壞掉';
    const r = await translateChunk(llm, meta, [], big);
    expect(r.byId.size).toBe(0);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.problems.join(' ')).toContain('缺');
  });

  it('多餘的 id 與空 zh 被丟棄', async () => {
    const llm = async () => '[{"id":0,"zh":"零"},{"id":1,"zh":"一"},{"id":99,"zh":"多的"},{"id":1,"zh":""}]';
    const r = await translateChunk(llm, meta, [], chunk);
    expect([...r.byId.keys()].sort()).toEqual([0, 1]);
  });
});

describe('repairChunk', () => {
  const chunk = { before: [], target: [sent(0, 'when your dealing [music] with rockets'), sent(1, 'ok.')], after: [] };

  it('修稿成功：取代原文', async () => {
    const llm = async () => '[{"id":0,"en":"When you\'re dealing with rockets."},{"id":1,"en":"OK."}]';
    const r = await repairChunk(llm, meta, chunk);
    expect(r.byId.get(0)).toBe("When you're dealing with rockets.");
    expect(r.retries).toBe(0);
  });

  it('缺句重試一次；仍缺回傳部分結果', async () => {
    const llm = async () => '[{"id":0,"en":"fixed."}]';
    const r = await repairChunk(llm, meta, chunk);
    expect(r.retries).toBe(1);
    expect(r.byId.size).toBe(1);
  });
});

describe('attachGlossaryNotes', () => {
  const mkCues = (): BilingualCue[] => [
    { start: 0, end: 2, en: 'Intro sentence.', zh: '開場。' },
    { start: 2, end: 4, en: 'We added guardrails here.', zh: '我們加了護欄機制（Guardrails）。' },
    { start: 4, end: 6, en: 'More guardrails talk.', zh: '更多 Guardrails 的討論。' },
  ];

  it('術語第一次出現的句子拿到「呈現形式：解釋」格式的註（只一次）', () => {
    const cues = mkCues();
    const added = attachGlossaryNotes(cues, [
      { term: 'guardrails', zh: '護欄機制（Guardrails）', note: '限制 AI 行為範圍的安全機制' },
    ]);
    expect(added).toBe(1);
    expect(cues[1].note).toBe('護欄機制（Guardrails）：限制 AI 行為範圍的安全機制');
    expect(cues[2].note).toBeUndefined();
  });

  it('純中文呈現的術語不需要註；同句可疊多條（既有譯註保留在最上面）', () => {
    const cues = mkCues();
    cues[1].note = '既有譯註';
    const added = attachGlossaryNotes(cues, [
      { term: 'guardrails', zh: '護欄機制（Guardrails）', note: '解釋' },
      { term: 'intro', zh: '開場', note: '不該出現' },
    ]);
    expect(added).toBe(1);
    expect(cues[1].note).toBe('既有譯註\n護欄機制（Guardrails）：解釋');
    expect(cues[0].note).toBeUndefined();
  });

  it('一句最多 3 條註，滿了才退到下一句含該術語處', () => {
    const cues: BilingualCue[] = [
      { start: 0, end: 2, en: 'alpha beta gamma delta here.', zh: '第一句。' },
      { start: 2, end: 4, en: 'delta appears again.', zh: '第二句。' },
    ];
    const added = attachGlossaryNotes(cues, [
      { term: 'alpha', zh: 'Alpha', note: '解釋A' },
      { term: 'beta', zh: 'Beta', note: '解釋B' },
      { term: 'gamma', zh: 'Gamma', note: '解釋C' },
      { term: 'delta', zh: 'Delta', note: '解釋D' }, // 首句已滿 3 條 → 退到第二句
    ]);
    expect(added).toBe(4);
    expect(cues[0].note).toBe('Alpha：解釋A\nBeta：解釋B\nGamma：解釋C');
    expect(cues[1].note).toBe('Delta：解釋D');
  });

  it('term 含多形式（a / b）逐一嘗試', () => {
    const cues = mkCues();
    const added = attachGlossaryNotes(cues, [
      { term: 'harness / guardrails', zh: 'Harness', note: '外部控制框架' },
    ]);
    expect(added).toBe(1);
    expect(cues[1].note).toBe('Harness：外部控制框架');
  });
});

describe('assembleBilingual + toSrt', () => {
  const cues: Cue[] = [
    { start: 1, dur: 2, text: 'hello' },
    { start: 3, dur: 2, text: 'world.' },
    { start: 6, dur: 1.5, text: 'bye.' },
  ];
  const sentences: Sentence[] = [
    { id: 0, text: 'hello world.', cueIds: [0, 1] },
    { id: 1, text: 'bye.', cueIds: [2] },
  ];

  it('句子映回 cue 時間範圍；缺譯 fallback 英文並標記', () => {
    const byId = new Map([[0, { zh: '哈囉世界。', note: undefined }]]);
    const { cues: out, untranslated, bannedHits } = assembleBilingual(sentences, cues, byId);
    expect(out[0]).toMatchObject({ start: 1, end: 5, en: 'hello world.', zh: '哈囉世界。' });
    expect(out[1]).toMatchObject({ start: 6, end: 7.5, zh: 'bye.', untranslated: true });
    expect(untranslated).toBe(1);
    expect(bannedHits).toEqual([]);
  });

  it('組裝階段仍掃描禁用詞（重試後殘留要進 warnings）', () => {
    const byId = new Map([
      [0, { zh: '這視頻不錯' }],
      [1, { zh: '掰' }],
    ]);
    expect(assembleBilingual(sentences, cues, byId).bannedHits).toEqual(['視頻']);
  });

  it('SRT：中上英下、時間格式正確', () => {
    const srt = toSrt([{ start: 1, end: 5, en: 'hello world.', zh: '哈囉世界。' }]);
    expect(srt).toBe('1\n00:00:01,000 --> 00:00:05,000\n哈囉世界。\nhello world.\n');
  });
});
