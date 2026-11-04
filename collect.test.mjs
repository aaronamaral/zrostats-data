import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseBatch, SOURCE_URL } from './collect.mjs';

const ISO = '2026-11-04T06:59:19.502Z';
const NOW = Date.parse(ISO);
function batch() {
  return [
    { result: { data: { totalMessages: 163465060, totalMessages24h: 14147, totalMessages30d: 455907,
      totalValueTransferred: 32090459099950, totalValueTransferred24h: 37014617188, totalValueTransferred30d: 1362577840960 } } },
    { result: { data: [{ symbol: 'OFT', project: 'Project' }, { symbol: 'OFT', project: 'Project' }] } },
    { result: { data: [{ chainKey: 'ethereum', count: 10 }, { chainKey: 'arbitrum', count: 0 }] } },
  ];
}

test('capture keeps source cents, capture time, OFT rows and active chains without changing their meaning', () => {
  const result = parseBatch(batch(), ISO, NOW);
  assert.deepEqual(result, { version: 1, capturedAt: ISO, sourceUrl: SOURCE_URL, overview: batch()[0].result.data, oftCount: 2, activeChainCount: 2 });
  assert.equal(result.overview.totalValueTransferred24h, 37014617188);
  assert.equal('supportedChains' in result, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
});

test('malformed or partial tRPC responses and untrustworthy counters are rejected', () => {
  for (const raw of [null, [], batch().slice(0, 2), [...batch(), {}], [{ error: {} }, ...batch().slice(1)]]) {
    assert.throws(() => parseBatch(raw, ISO, NOW));
  }
  for (const value of ['14147', -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
    const raw = batch(); raw[0].result.data.totalMessages24h = value;
    assert.throws(() => parseBatch(raw, ISO, NOW));
  }
  const raw = batch(); raw[0].result.data.extraField = 1;
  assert.throws(() => parseBatch(raw, ISO, NOW));
});

test('ordered windows, distinct chain keys and real capture dates are required; genuine zeros remain valid', () => {
  for (const key of ['totalMessages24h', 'totalValueTransferred24h']) {
    const raw = batch(); raw[0].result.data[key] = Number.MAX_SAFE_INTEGER;
    assert.throws(() => parseBatch(raw, ISO, NOW));
  }
  const duplicateChains = batch(); duplicateChains[2].result.data[1].chainKey = 'ethereum';
  assert.throws(() => parseBatch(duplicateChains, ISO, NOW));
  const emptyOftName = batch(); emptyOftName[1].result.data[0].symbol = '';
  assert.throws(() => parseBatch(emptyOftName, ISO, NOW));
  for (const date of ['2026-02-30T06:59:19.502Z', new Date(NOW + 1).toISOString(), 'not-a-date']) {
    assert.throws(() => parseBatch(batch(), date, NOW));
  }
  const zero = batch(); zero[0].result.data.totalMessages24h = 0; zero[0].result.data.totalValueTransferred24h = 0;
  assert.equal(parseBatch(zero, ISO, NOW).overview.totalMessages24h, 0);
});
