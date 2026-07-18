// Popup：顯示 tier 與攔到的字幕軌，選定後 normalize 並送 Worker /ingest。
// 設定（Worker URL / INGEST_KEY）存 chrome.storage.local — key 不進 repo。
import { normalizeJson3 } from './normalize.js';

const DEFAULT_WORKER_URL = 'https://ytplayer.sw-tech.workers.dev';

const app = document.getElementById('app');
const result = document.getElementById('result');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  return { workerUrl: DEFAULT_WORKER_URL, ingestKey: '', ...(config ?? {}) };
}

// 防呆：自動補 https://、去尾端斜線（實測踩過沒加 scheme 的雷）
function normalizeUrl(u) {
  u = (u ?? '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}

function setupSettings(cfg) {
  const url = document.getElementById('cfg-url');
  const key = document.getElementById('cfg-key');
  url.value = cfg.workerUrl;
  key.value = cfg.ingestKey;
  document.getElementById('cfg-save').addEventListener('click', async () => {
    await chrome.storage.local.set({ config: { workerUrl: normalizeUrl(url.value), ingestKey: key.value.trim() } });
    location.reload();
  });
}

// append-01 §B：vssId 前綴 + kind 交叉驗證
const isAsr = (t) => t.kind === 'asr' || (typeof t.vssId === 'string' && t.vssId.startsWith('a.'));
const isZhHant = (t) => /^zh(-Hant|-TW)$/i.test(t.languageCode ?? '');

function computeTier(tracks) {
  if (!tracks.length) return 4;
  const manual = tracks.filter((t) => !isAsr(t));
  if (manual.some(isZhHant)) return 1;
  if (manual.length) return 2;
  return 3;
}

const TIER_MSG = {
  1: '創作者已提供繁中字幕，建議直接用 YouTube 原生軌（仍可送出原文軌供比對）',
  2: '有人工原文 CC — POC 主路徑',
  3: '只有自動字幕（ASR）— 先 ingest 標記，翻譯留待 Phase 2.5',
  4: '沒有任何 caption track，無法處理',
};

// 「Failed to fetch」沒有狀態碼可看，分層診斷：網路層 → 是不是本專案 Worker → CORS
async function diagnoseWorker(workerUrl) {
  try {
    await fetch(`${workerUrl}/`, { mode: 'no-cors' });
  } catch {
    return '診斷：Worker URL 連不上（網路/DNS 層失敗）— 檢查設定裡的網址，或是否被其他擴充功能擋掉';
  }
  try {
    const r = await fetch(`${workerUrl}/`);
    const j = await r.json();
    if (j?.service === 'ytplayer') return '診斷：Worker 本身正常，但 /ingest 失敗 — 請把這個結果回報';
    return `診斷：網址可連，但那裡不是 ytplayer Worker（回應：${JSON.stringify(j).slice(0, 80)}）`;
  } catch {
    return '診斷：網址有回應但沒有 CORS 標頭 → Worker 大概還沒部署成功。' +
      '請直接開 Worker URL 看是不是 Cloudflare 錯誤頁；' +
      '最常見原因：Workers Builds 的 production branch 設成 main，但程式碼還在開發分支';
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function renderError(msg) {
  app.innerHTML = `<div class="err">${esc(msg)}</div>`;
}

async function main() {
  const cfg = await getConfig();
  setupSettings(cfg);
  if (!cfg.workerUrl) {
    renderError('請先在下方「設定」填 Worker URL');
    return;
  }
  const tab = await activeTab();
  let state;
  try {
    state = await chrome.tabs.sendMessage(tab.id, { type: 'getState' });
  } catch {
    renderError('這個分頁不是 YouTube 影片頁（或請重新整理頁面讓 content script 載入）');
    return;
  }
  if (!state?.urlVideoId) return renderError('網址列沒有 videoId — 請開一支 /watch 影片');
  if (!state.page) return renderError(`頁面資料抓取失敗：${state.pageError ?? '未知'}`);
  if (state.page.videoId !== state.urlVideoId) {
    return renderError(`頁面資料 videoId (${state.page.videoId}) 與網址列 (${state.urlVideoId}) 不一致，請重新整理`);
  }

  const { page } = state;
  const tier = computeTier(page.tracks);
  const usable = state.captures.filter((c) => !c.tlang && c.fmt === 'json3');
  const translated = state.captures.filter((c) => c.tlang);

  let html = `
    <div><b>${esc(page.meta.title)}</b></div>
    <div class="muted">${esc(page.meta.channel)} · ${esc(state.urlVideoId)} · tracks: ${page.tracks.length}</div>
    <div class="tier tier-${tier}">Tier ${tier}</div>
    <div class="hint">${esc(TIER_MSG[tier])}</div>`;

  if (tier !== 4) {
    if (usable.length === 0) {
      html += `<div class="hint warn">還沒攔到原文字幕 — 請在播放器開啟 CC 並選<b>原文</b>軌（不要「自動翻譯」），再重新打開本視窗</div>`;
    }
    for (const c of translated) {
      html += `<label class="cap disabled">⚠ ${esc(c.lang)} → ${esc(c.tlang)}（自動翻譯軌，不可作為輸入 — 請切回原文軌）</label>`;
    }
    usable.forEach((c, i) => {
      html += `<label class="cap"><input type="radio" name="cap" value="${esc(c.key)}" ${i === 0 ? 'checked' : ''}>
        ${esc(c.lang)}${c.kind === 'asr' ? '（ASR）' : '（人工）'} · ${Math.round(c.bytes / 1024)} KB</label>`;
    });
    html += `<button id="send" ${usable.length === 0 ? 'disabled' : ''}>送出到 Worker</button>`;
  }
  app.innerHTML = html;

  document.getElementById('send')?.addEventListener('click', async () => {
    const btn = document.getElementById('send');
    btn.disabled = true;
    result.textContent = '處理中…';
    try {
      const key = document.querySelector('input[name="cap"]:checked')?.value;
      const cap = usable.find((c) => c.key === key);
      if (!cap) throw new Error('沒有選擇字幕軌');
      const { body, error } = await chrome.tabs.sendMessage(tab.id, { type: 'getCaptureBody', key });
      if (error) throw new Error(error);
      const cues = normalizeJson3(body);
      if (cues.length === 0) throw new Error('normalize 後沒有任何 cue');
      const matched = page.tracks.find((t) => t.languageCode === cap.lang && (t.kind ?? null) === (cap.kind ?? null));
      const payload = {
        videoId: state.urlVideoId,
        tier,
        sourceLang: cap.lang,
        availableTracks: page.tracks,
        meta: page.meta,
        track: {
          languageCode: cap.lang,
          kind: cap.kind ?? null,
          name: matched?.name ?? null,
          vssId: matched?.vssId ?? null,
          capturedFmt: cap.fmt,
        },
        cues,
      };
      const res = await fetch(`${cfg.workerUrl}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ingest-key': cfg.ingestKey },
        body: JSON.stringify(payload),
      });
      const out = await res.json();
      if (!res.ok || !out.ok) throw new Error(out.error ?? (out.errors ?? []).join('; ') ?? `HTTP ${res.status}`);
      const srtUrl = `${cfg.workerUrl}/subs/${state.urlVideoId}/bilingual.srt`;
      result.innerHTML = `<span class="ok">✅ 已存入 ${esc(out.key)}（${out.cueCount} cues）</span>` +
        (out.warning ? `<div class="warn">⚠ ${esc(out.warning)}</div>` : '') +
        (tier === 2
          ? `<div class="hint">已排入翻譯佇列（cron 每 5 分鐘自動跑，單支約 1–2 分鐘）。完成後見：<br>
             <a href="${esc(srtUrl)}" target="_blank" style="color:#59f">${esc(srtUrl)}</a></div>`
          : `<div class="hint">Tier ${tier} 只 ingest 不翻譯（等 Phase 2.5）</div>`);
    } catch (e) {
      let msg = String(e.message ?? e);
      if (/failed to fetch/i.test(msg)) {
        msg += `\n${await diagnoseWorker(cfg.workerUrl)}`;
      }
      result.innerHTML = `<span class="err">❌ ${esc(msg)}</span>`;
    } finally {
      btn.disabled = false;
    }
  });
}

main().catch((e) => renderError(String(e)));
