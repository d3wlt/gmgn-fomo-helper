# better gmgn

An independent private copy of the Chrome MV3 extension “better gmgn.” Version 0.53.11 is based on upstream version 0.46.27 and adds trading-oriented interface enhancements to GMGN.ai and DeBot. FOMO Following cards expose GMGN's real native QuickBuy on hover, using its Following wallet/amount settings. Clicking it can execute a trade through GMGN; the helper never submits trades automatically or implements its own trading API. The adapter validates chain/token identity and native context and fails closed if the supported native component contract is unavailable.

This repository is not affiliated with GMGN, DeBot, FOMO, Pump, J7Tracker, or the original upstream author.

## Install manually

1. Download the versioned ZIP from [GitHub Releases](https://github.com/d3wlt/985gmgn-helper-private/releases).
2. Verify its SHA-256 checksum against the accompanying `.sha256` file.
3. Extract the ZIP to a permanent local folder.
4. Open `chrome://extensions` or `edge://extensions`.
5. Enable **Developer mode**.
6. Select **Load unpacked** and choose the extracted folder.

Chrome does not automatically update unpacked extensions. To update, download and verify a newer ZIP, replace the extracted files, then select **Reload** on the extension card. No companion application is required.

## Features

- Highlight watched developer wallets and show developer launch performance.
- Save developer wallets from GMGN details and filter blocked callout accounts.
- Show manifesto notifications and a time-ordered manifesto list.
- Share special-watch wallet colors and pin preferences across GMGN and DeBot.
- Add a FOMO panel for token holders, narratives, and trades using your browser-local FOMO session, with explicit buy/sell and First/More/Partial/All position labels. When FOMO's token feed is empty, the Trades tab reconstructs activity from the visible holders' trade histories.
- Translate non-English FOMO and DeBot narratives into English with the browser's local Translation API while keeping the original text.
- Insert account-filtered J7Tracker activity into GMGN and DeBot tracking: bounded history catch-up and live FOMO buys, sells, and narratives plus Pump.fun callouts and replies. Open `j7tracker.io` once while signed in to connect the same browser profile.
- Interleave FOMO Following and J7/Pump activity chronologically with original native GMGN cards using one mapped scroll surface. No capped split pane. The native virtualizer index and fractional row heights are validated; unsupported layouts preserve native rows without injecting FOMO. Followed-user highlighting, username-first labels, compact badges and native token blocking are preserved.
- Alert on held-token price surges after confirming the current balance and GMGN app notification setting.
- Show 👥N beside tokens held by people you follow on FOMO, highlight those users in the FOMO Holders tab, and link Flap tax badges to the English tax page.
- Hide the third-party Lightning Trade button.
- Show FOMO data source, last successful refresh, partial coverage, and Following-only views on GMGN and DeBot.
- Passively reuse native FOMO Alerts already received by an open signed-in FOMO tab, forwarding observed REST history and live activity into GMGN. The direct Following tracker makes no independent FOMO requests, sockets, subscriptions or reconnects.
- Use names, avatars, tickers and market-cap values already present in native activity. Passive mode does not issue metadata/profile recovery requests; missing fields remain explicit rather than being invented.
- Refresh already-rendered rows when metadata changes, without duplicating trades or replaying entry animation. Unavailable tickers show a shortened token address rather than a blank; unresolved people show a user-ID fallback rather than an invented name.
- Recover from request failures with retry/reconnect guidance and optional allowlisted clipboard diagnostics.

Direct Following is passive-only. Keep one FOMO tab open and signed in, and select Alerts so the native application receives the relevant activity. Refresh FOMO after installing or reloading this extension so document-start observation is active. A visible tracker status distinguishes waiting for a tab/account/following/activity from connected/disconnected states. Closing, navigating away, signing out or suspending the source tab stops live delivery; no hidden keeper tab is opened. Missed activity is recovered only if FOMO itself receives it. The account-isolated feed is bounded to 500 events and the tracker displays the latest 40 eligible rows; this is not complete lifetime history. Grouped multi-user and transfer rows remain unsupported. The passive event cache is memory-only: worker/browser restarts may clear old rows, and only subsequent native observations refill it. Refresh FOMO to reobserve its native history/session if needed.

Holder-history reconstruction is a limited current-holder sample, not a complete token history. Fully exited users may be absent; Following-only filtering applies to the loaded sample. Neither a successful response nor a holder badge proves there have been no sells.

## Debug logging

Open the extension popup → **Diagnostics** → enable **Debug logging**. This toggle saves immediately; no Save settings click is needed. Reproduce the problem, click **Export logs**, and send the JSON with a screenshot and the approximate issue time. Turn logging off afterwards; **Clear logs** removes the saved history.

Logging is off by default and local-only. The export contains extension version, timestamps, categorical FOMO request outcomes/timings, collection/metadata counts, and GMGN direct-Following received/eligible/actually-placed counts. It does not include credentials, cookies, raw URLs/responses, user names/IDs, wallet/token addresses, trade IDs or thesis text. No automatic uploads or download permission are used. Consequently a screenshot is still needed to identify a specific missing event. This is targeted feed diagnostics, not a raw console/network dump or instrumentation of every extension feature.

Pagination records include pages fetched, items received, whether more pages remain, cursor advancement and a categorical stop reason—never cursor values. Successful requests to the same endpoint/status are coalesced into ten-second buckets: `count` is the request count and `durationMs` is the maximum duration in that bucket. Failures remain individual records.

The ring retains at most 500 entries from the previous 24 hours, pruned on use, with batched writes and five-second render sampling. It survives worker/browser restarts. Clear waits for pending writes so old entries cannot return. Exported files are not erased by Clear logs. Storage failures are nonfatal; unsaved trailing entries can be lost if the browser stops before the batch write.

## Privacy and safety

The extension stores settings, cached display data, and supported-site session mirrors in Chrome local storage. It does not include analytics, remote executable code, wallet signing, or transaction execution. See [PRIVACY.md](PRIVACY.md) for details.

## Build a release

On PowerShell:

```powershell
./scripts/build-release.ps1
```

The script creates only `dist/985gmgn-helper-vX.Y.Z.zip` and its `.sha256` checksum. Release notes are built from the matching current note with `scripts/build-release-notes.ps1`.

On macOS or Linux, the portable builder reads the same release-file allowlist and verifies every ZIP entry:

```bash
python3 scripts/build-release.py --tag v0.53.5
```

Run the repository gates (Node.js 22+):

```bash
npm ci
npx playwright install chromium
npm run verify
```

The audit retains historical release notes and derives the current version from the manifest. Data and UI tests execute production functions with controlled fixtures. Browser tests execute the full content scripts and real styles in isolated Chromium pages with synthetic responses: no live accounts or authenticated API access. They exercise filtering, stale data, account/token/tab races, extension-message failures, rate limits, and panel lifecycle. Screenshots and structured results are written under `test-results/` and excluded from the release ZIP.

These fixture gates do not replace a signed-in smoke test against changed third-party APIs. J7Tracker's public Socket.IO path and invalid-session response are checked live without using an account; a signed-in J7Tracker session is still required to validate account-specific history. Unpacked extension reload and GMGN/DeBot page refresh are required after installation.

## Repository

Private-copy source and releases: <https://github.com/d3wlt/985gmgn-helper-private>
