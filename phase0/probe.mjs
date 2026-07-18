// Phase 0 probe: extract caption tracks from YouTube watch pages, sample
// timedtext responses, and test CORS from a non-youtube origin.
//
// Usage: node probe.mjs <videoId> [videoId...]
// Writes results to ./out/<videoId>.json

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

const videoIds = process.argv.slice(2);
if (videoIds.length === 0) {
  console.error('usage: node probe.mjs <videoId>...');
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--no-sandbox'],
  // this environment routes outbound HTTPS through a local agent proxy
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
});

for (const videoId of videoIds) {
  const result = { videoId, probedAt: new Date().toISOString() };
  const ctx = await browser.newContext({
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();
  try {
    console.log(`\n=== ${videoId} ===`);
    await page.goto(`https://www.youtube.com/watch?v=${videoId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });

    // Give the page a moment; ytInitialPlayerResponse is inlined in HTML so it
    // should exist immediately, but consent walls etc. may interfere.
    await page.waitForTimeout(3000);

    // --- 1. read ytInitialPlayerResponse global ---
    const fromGlobal = await page.evaluate(() => {
      const pr = window.ytInitialPlayerResponse;
      if (!pr) return null;
      return {
        title: pr.videoDetails?.title,
        channel: pr.videoDetails?.author,
        lengthSeconds: pr.videoDetails?.lengthSeconds,
        captionTracks:
          pr.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? null,
        translationLanguagesCount:
          pr.captions?.playerCaptionsTracklistRenderer?.translationLanguages
            ?.length ?? 0,
      };
    });
    result.globalVarPresent = !!fromGlobal;
    result.meta = fromGlobal
      ? {
          title: fromGlobal.title,
          channel: fromGlobal.channel,
          lengthSeconds: fromGlobal.lengthSeconds,
        }
      : null;
    result.captionTracks = fromGlobal?.captionTracks ?? null;
    result.translationLanguagesCount = fromGlobal?.translationLanguagesCount;

    // --- 2. fallback: parse from HTML (verify the regex path also works) ---
    const html = await page.content();
    const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var\s|<\/script>)/s);
    result.htmlParseWorks = false;
    if (m) {
      try {
        const parsed = JSON.parse(m[1]);
        result.htmlParseWorks = !!parsed.videoDetails;
        if (!result.captionTracks) {
          result.captionTracks =
            parsed.captions?.playerCaptionsTracklistRenderer?.captionTracks ??
            null;
        }
      } catch (e) {
        result.htmlParseError = String(e).slice(0, 200);
      }
    }

    const tracks = result.captionTracks ?? [];
    console.log(
      `tracks: ${tracks.length}`,
      tracks.map((t) => `${t.languageCode}${t.kind ? ':' + t.kind : ''}`).join(', ')
    );

    // --- 3. fetch json3 for each track FROM WITHIN the youtube.com page ---
    result.trackSamples = [];
    for (const t of tracks) {
      const sample = await page.evaluate(async (baseUrl) => {
        const url = baseUrl + '&fmt=json3';
        try {
          const res = await fetch(url, { credentials: 'include' });
          const text = await res.text();
          return { status: res.status, length: text.length, body: text.slice(0, 100000) };
        } catch (e) {
          return { error: String(e) };
        }
      }, t.baseUrl);
      const entry = {
        languageCode: t.languageCode,
        kind: t.kind ?? null,
        name: t.name?.simpleText ?? t.name?.runs?.map((r) => r.text).join('') ?? null,
        vssId: t.vssId,
        isTranslatable: t.isTranslatable,
        baseUrlSample: t.baseUrl.slice(0, 300),
        fetchStatus: sample.status ?? null,
        fetchLength: sample.length ?? null,
        fetchError: sample.error ?? null,
      };
      if (sample.body) {
        try {
          const j = JSON.parse(sample.body);
          entry.eventCount = j.events?.length;
          entry.firstEvents = j.events?.slice(0, 8);
        } catch {
          entry.bodyPrefix = sample.body.slice(0, 500);
        }
      }
      result.trackSamples.push(entry);
      console.log(
        `  ${entry.languageCode}${entry.kind ? ':' + entry.kind : ''} -> status=${entry.fetchStatus} len=${entry.fetchLength} events=${entry.eventCount ?? '?'}`
      );
    }

    // --- 4. CORS test: fetch the first track's baseUrl from a non-youtube origin ---
    if (tracks[0]) {
      const corsPage = await ctx.newPage();
      await corsPage.goto('about:blank');
      result.corsTest = await corsPage.evaluate(async (baseUrl) => {
        const url = baseUrl + '&fmt=json3';
        const out = {};
        try {
          const res = await fetch(url);
          const text = await res.text();
          out.aboutBlank = { ok: true, status: res.status, length: text.length };
        } catch (e) {
          out.aboutBlank = { ok: false, error: String(e) };
        }
        return out;
      }, tracks[0].baseUrl);
      await corsPage.close();

      // also from a real http origin (data: and about:blank can behave differently)
      const httpPage = await ctx.newPage();
      await httpPage.goto('https://example.com');
      result.corsTest.exampleCom = await httpPage.evaluate(async (baseUrl) => {
        try {
          const res = await fetch(baseUrl + '&fmt=json3');
          const text = await res.text();
          return { ok: true, status: res.status, length: text.length };
        } catch (e) {
          return { ok: false, error: String(e) };
        }
      }, tracks[0].baseUrl);
      await httpPage.close();
      console.log('  CORS:', JSON.stringify(result.corsTest));

      // --- 5. server-side fetch (Node, datacenter IP, no cookies) ---
      try {
        const res = await fetch(tracks[0].baseUrl + '&fmt=json3');
        const text = await res.text();
        result.serverFetch = { status: res.status, length: text.length };
      } catch (e) {
        result.serverFetch = { error: String(e).slice(0, 300) };
      }
      console.log('  serverFetch:', JSON.stringify(result.serverFetch));
    }
  } catch (e) {
    result.error = String(e).slice(0, 500);
    console.error('  ERROR:', result.error);
  } finally {
    fs.writeFileSync(
      path.join(OUT, `${videoId}.json`),
      JSON.stringify(result, null, 2)
    );
    await ctx.close();
  }
}

await browser.close();
console.log('\ndone; results in phase0/out/');
