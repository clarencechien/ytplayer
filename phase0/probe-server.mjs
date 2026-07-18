// Phase 0 probe (server-side variant): fetch YouTube watch page HTML,
// parse ytInitialPlayerResponse, list caption tracks, sample timedtext
// responses, and inspect CORS headers.
//
// Run with: NODE_USE_ENV_PROXY=1 node probe-server.mjs <videoId>...
// Writes results to ./out/<videoId>.json

import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function extractPlayerResponse(html) {
  // ytInitialPlayerResponse = {...}; appears inside a <script> tag.
  const marker = 'ytInitialPlayerResponse = ';
  const i = html.indexOf(marker);
  if (i < 0) return null;
  const start = i + marker.length;
  // Balanced-brace scan (string-aware) — regex is too fragile for 1MB of JSON.
  let depth = 0,
    inStr = false,
    esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, j + 1));
    }
  }
  return null;
}

for (const videoId of process.argv.slice(2)) {
  const result = { videoId, method: 'server-side fetch', probedAt: new Date().toISOString() };
  console.log(`\n=== ${videoId} ===`);
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' },
    });
    result.watchPageStatus = res.status;
    const html = await res.text();
    result.watchPageBytes = html.length;
    const pr = extractPlayerResponse(html);
    if (!pr) {
      result.error = 'ytInitialPlayerResponse not found in HTML';
      console.log('  ' + result.error);
      continue;
    }
    result.playabilityStatus = pr.playabilityStatus?.status;
    result.meta = {
      title: pr.videoDetails?.title,
      channel: pr.videoDetails?.author,
      lengthSeconds: pr.videoDetails?.lengthSeconds,
      descriptionPrefix: pr.videoDetails?.shortDescription?.slice(0, 120),
    };
    const rend = pr.captions?.playerCaptionsTracklistRenderer;
    const tracks = rend?.captionTracks ?? [];
    result.translationLanguagesCount = rend?.translationLanguages?.length ?? 0;
    console.log(
      `  ${result.meta.title} | playability=${result.playabilityStatus} | tracks=${tracks.length} [${tracks
        .map((t) => `${t.languageCode}${t.kind ? ':' + t.kind : ''}`)
        .join(', ')}] translationLangs=${result.translationLanguagesCount}`
    );

    result.trackSamples = [];
    for (const t of tracks) {
      const entry = {
        languageCode: t.languageCode,
        kind: t.kind ?? null,
        name: t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join('') ?? null,
        vssId: t.vssId,
        isTranslatable: t.isTranslatable,
        baseUrlParams: Object.fromEntries(
          [...new URL(t.baseUrl).searchParams.entries()].map(([k, v]) => [
            k,
            v.length > 60 ? v.slice(0, 60) + `…(${v.length} chars)` : v,
          ])
        ),
      };
      try {
        const tRes = await fetch(t.baseUrl + '&fmt=json3', {
          headers: { 'user-agent': UA, origin: 'https://www.youtube.com', referer: 'https://www.youtube.com/' },
        });
        const body = await tRes.text();
        entry.timedtext = {
          status: tRes.status,
          bytes: body.length,
          contentType: tRes.headers.get('content-type'),
          accessControlAllowOrigin: tRes.headers.get('access-control-allow-origin'),
          accessControlAllowCredentials: tRes.headers.get('access-control-allow-credentials'),
        };
        if (body.length > 0) {
          try {
            const j = JSON.parse(body);
            entry.timedtext.eventCount = j.events?.length;
            entry.timedtext.firstEvents = j.events?.slice(0, 6);
          } catch {
            entry.timedtext.bodyPrefix = body.slice(0, 300);
          }
        }
      } catch (e) {
        entry.timedtextError = String(e).slice(0, 200);
      }
      result.trackSamples.push(entry);
      const tt = entry.timedtext ?? {};
      console.log(
        `    ${entry.languageCode}${entry.kind ? ':' + entry.kind : ''} "${entry.name}" -> status=${tt.status} bytes=${tt.bytes} events=${tt.eventCount ?? '-'} ACAO=${tt.accessControlAllowOrigin}`
      );
    }
  } catch (e) {
    result.error = String(e).slice(0, 500);
    console.error('  ERROR:', result.error);
  } finally {
    fs.writeFileSync(path.join(OUT, `${videoId}.json`), JSON.stringify(result, null, 2));
  }
}
console.log('\ndone');
