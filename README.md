# Hosted LayerZero Scan compatibility collector

**Closed compatibility test (4 November 2026).** [The hosted run](https://github.com/aaronamaral/zrostats-data/actions/runs/41842771015) ended with a browser challenge. This repository is not a production data feed and has no scheduled workflow. ZroStats uses a separate Vercel job and hosted JSON reader instead.

This repository tests whether a fresh, ordinary Chromium session on a GitHub-hosted Ubuntu runner can read LayerZero Scan's public dashboard JSON. It does not require a running local computer, Codex session, Scan account, or secret. A successful hosted run must be observed before describing this as an operational feed.

The initial workflow is **manual only** (`workflow_dispatch`). It has `contents: read`, a five-minute job timeout, and uploads a validated `data/latest.json` artifact on success. It does not commit data, publish a feed, deploy an app, or create a schedule. Run **Check hosted Scan collection** from the repository's Actions page to perform the cloud compatibility test.

## Browser behavior

The collector pins Playwright to `1.64.1` and uses `chromium.launch({ channel: 'chromium', headless: true })` with a fresh context. It navigates to the homepage, then the fixed three-procedure JSON URL. It waits at most 45 seconds for that browser flow, allows the page's normal JavaScript to execute, and performs no manual retry. Visible interactive verification stops the run. A persistent automatic checkpoint ends with a sanitized challenge result. The workflow additionally terminates the process after 55 seconds, with a five-second kill grace period, to bound a hung browser shutdown.

There are no user-agent overrides, initialization scripts, imported cookies, persistent browser profiles, stealth packages, proxies, CAPTCHA solvers, or challenge-token export. Error output contains only a status: `interactive-challenge`, `challenge`, `timeout`, or `unavailable`. Response bodies, browser state, and raw errors are not uploaded or logged.

Vercel documents that browser challenge sessions are browser-bound and that automated tools cannot establish them. Hosted Chromium support does not guarantee that Scan accepts a hosted browser. This is a compatibility test, not an attempt to alter that policy. See [Vercel's challenge documentation](https://vercel.com/docs/vercel-firewall/firewall-concepts#challenge-limitations) and [Playwright's CI guide](https://playwright.dev/docs/ci).

## Data contract

The source is fixed:

```text
https://layerzeroscan.com/api/trpc/messages.statsOverview,ofts.statsOverview,chains.top?batch=1&input=%7B%222%22%3A%7B%22filters%22%3A%7B%22stage%22%3A%22mainnet%22%7D%7D%7D
```

The three `result.data` entries must be an overview object, an OFT array, and a mainnet active-chain array. Validation matches the ZroStats batch/capture contract: exact overview keys, nonnegative safe integers, `24h <= 30d <= lifetime`, positive bounded lifetime/row counts, nonempty OFT names, and unique chain keys. The response is limited to 1 MiB and the compact capture to 4 KiB.

The capture contains `version: 1`, `capturedAt`, `sourceUrl`, `overview`, `oftCount`, and `activeChainCount`. The overview retains all six raw fields: `totalMessages`, `totalMessages24h`, `totalMessages30d`, `totalValueTransferred`, `totalValueTransferred24h`, and `totalValueTransferred30d`.

Transferred values are **integer US cents**; consumers divide by 100 for USD. OFTs are Scan's returned row count, with no symbol/project deduplication. Chains are **active mainnet chains**, not all supported chains. `capturedAt` is the successful browser read time; the upstream response supplies no observation timestamp. No snapshot values are hardcoded.

The parser can be imported independently of Playwright for offline validation. To run the collector locally for development:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npx playwright install --with-deps chromium
npm run collect
```

The workflow itself runs on GitHub, independently of those local commands. Its first successful artifact can be reviewed before connecting publication or scheduling. Failed runs never write a new capture. The application consuming captures should preserve the existing 12-hour stale and 48-hour expiry policy; reading a saved file must not advance its capture time.
