import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_URL = 'https://layerzeroscan.com/api/trpc/messages.statsOverview,ofts.statsOverview,chains.top?batch=1&input=%7B%222%22%3A%7B%22filters%22%3A%7B%22stage%22%3A%22mainnet%22%7D%7D%7D';
const HOME_URL = 'https://layerzeroscan.com/';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CAPTURE_BYTES = 4096;
const DEADLINE_MS = 45_000;
const overviewKeys = ['totalMessages', 'totalMessages24h', 'totalMessages30d', 'totalValueTransferred', 'totalValueTransferred24h', 'totalValueTransferred30d'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max;
const identifier = (value, max = 256) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

class CollectionError extends Error {
  constructor(status) { super(status); this.status = status; }
}
const unavailable = () => { throw new CollectionError('unavailable'); };

/** Keep this contract aligned with ZroStats parseScanAggregateBatch/parseScanAggregateCapture. */
export function parseBatch(raw, capturedAt, now = Date.now()) {
  if (!Array.isArray(raw) || raw.length !== 3) unavailable();
  const data = raw.map(item => {
    if (!object(item) || 'error' in item || !object(item.result) || !('data' in item.result)) unavailable();
    return item.result.data;
  });
  const [overview, ofts, chains] = data;
  if (!object(overview) || Object.keys(overview).length !== overviewKeys.length
    || !Object.keys(overview).every(key => overviewKeys.includes(key))
    || !overviewKeys.every(key => count(overview[key]))
    || !count(overview.totalMessages, 1_000_000_000_000) || overview.totalMessages === 0
    || overview.totalMessages24h > overview.totalMessages30d || overview.totalMessages30d > overview.totalMessages
    || overview.totalValueTransferred24h > overview.totalValueTransferred30d
    || overview.totalValueTransferred30d > overview.totalValueTransferred) unavailable();
  // OFT symbols/projects are descriptive, not unique identities. Preserve Scan's row count.
  if (!Array.isArray(ofts) || ofts.length < 1 || ofts.length > 10_000
    || ofts.some(row => !object(row) || !identifier(row.symbol) || !identifier(row.project))) unavailable();
  if (!Array.isArray(chains) || chains.length < 1 || chains.length > 500
    || chains.some(row => !object(row) || !identifier(row.chainKey, 128) || !count(row.count))
    || new Set(chains.map(row => row.chainKey)).size !== chains.length) unavailable();
  if (typeof capturedAt !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(capturedAt)
    || !Number.isFinite(Date.parse(capturedAt)) || !Number.isFinite(now) || Date.parse(capturedAt) > now
    || new Date(capturedAt).toISOString().slice(0, 19) !== capturedAt.slice(0, 19)) unavailable();
  const capture = {
    version: 1,
    capturedAt: new Date(capturedAt).toISOString(),
    sourceUrl: SOURCE_URL,
    overview: Object.fromEntries(overviewKeys.map(key => [key, overview[key]])),
    oftCount: ofts.length,
    activeChainCount: chains.length,
  };
  if (Buffer.byteLength(JSON.stringify(capture)) > MAX_CAPTURE_BYTES) unavailable();
  return capture;
}

async function interactiveVerification(page) {
  // Observe only. Never click, fill, solve, or export verification state.
  const controls = page.locator('iframe[title*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], input[type="checkbox"]');
  for (let index = 0; index < await controls.count(); index++) {
    if (await controls.nth(index).isVisible()) {
      const text = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '');
      if (/captcha|verify.{0,40}human|not a robot|security check/i.test(text) || await controls.nth(index).evaluate(element => element.tagName === 'IFRAME')) return true;
    }
  }
  const button = page.getByRole('button', { name: /verify.{0,30}human|i am human|i'm human|not a robot|press and hold|solve.{0,20}(?:captcha|puzzle)/i });
  return await button.first().isVisible().catch(() => false);
}

/** A compatibility check using stock Chromium and the website's normal navigation flow. */
export async function collect() {
  const { chromium } = await import('playwright');
  let browser;
  let challengeSeen = false;
  const deadline = Date.now() + DEADLINE_MS;
  const remaining = () => {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new CollectionError(challengeSeen ? 'challenge' : 'timeout');
    return milliseconds;
  };
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      void browser?.close().catch(() => {});
      reject(new CollectionError(challengeSeen ? 'challenge' : 'timeout'));
    }, DEADLINE_MS);
  });
  try {
    return await Promise.race([(async () => {
      browser = await chromium.launch({ channel: 'chromium', headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();
      let documentResponse = null;
      page.on('response', response => {
        if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) {
          documentResponse = response;
          if (response.headers()['x-vercel-mitigated'] === 'challenge') challengeSeen = true;
        }
      });

      async function navigate(url, requireJson) {
        documentResponse = null;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining() });
        while (true) {
          remaining();
          if (await interactiveVerification(page)) throw new CollectionError('interactive-challenge');
          if (new URL(page.url()).origin !== new URL(HOME_URL).origin) unavailable();
          const response = documentResponse;
          if (response && response.url() === url) {
            const headers = response.headers();
            const type = headers['content-type']?.split(';')[0]?.trim().toLowerCase();
            if (response.status() === 200 && requireJson && type === 'application/json') {
              if (Number(headers['content-length']) > MAX_RESPONSE_BYTES) unavailable();
              const body = await response.body();
              if (body.byteLength > MAX_RESPONSE_BYTES) unavailable();
              const now = Date.now();
              return parseBatch(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)), new Date(now).toISOString(), now);
            }
            const title = await page.title();
            const isCheckpoint = /vercel security checkpoint|checking your browser|security verification|verify you are human/i.test(title);
            if (isCheckpoint) challengeSeen = true;
            if (!requireJson && response.status() === 200 && !isCheckpoint && headers['x-vercel-mitigated'] !== 'challenge') return null;
            if (response.status() >= 400 && headers['x-vercel-mitigated'] !== 'challenge' && !isCheckpoint) unavailable();
            if (requireJson && response.status() === 200 && !isCheckpoint && type !== 'application/json') unavailable();
          }
          // Only the site's own automatic JavaScript runs while waiting. No refresh/retry.
          await page.waitForTimeout(Math.min(250, remaining()));
        }
      }

      await navigate(HOME_URL, false);
      return await navigate(SOURCE_URL, true);
    })(), expired]);
  } catch (error) {
    if (error instanceof CollectionError) throw error;
    throw new CollectionError(challengeSeen ? 'challenge' : 'unavailable');
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
  }
}

async function main() {
  try {
    const capture = await collect();
    const outputDirectory = join(dirname(fileURLToPath(import.meta.url)), 'data');
    await mkdir(outputDirectory, { recursive: true });
    const temporary = join(outputDirectory, 'latest.json.tmp');
    await writeFile(temporary, JSON.stringify(capture, null, 2) + '\n', { mode: 0o644 });
    await rename(temporary, join(outputDirectory, 'latest.json'));
    console.log(JSON.stringify({ status: 'success', capturedAt: capture.capturedAt, oftCount: capture.oftCount, activeChainCount: capture.activeChainCount }));
  } catch (error) {
    const status = error instanceof CollectionError ? error.status : 'unavailable';
    console.error(JSON.stringify({ status }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
