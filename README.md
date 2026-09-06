# better gmgn

An independent private copy of the Chrome MV3 extension “better gmgn.” Version 0.51.0 is based on upstream version 0.46.27 and adds trading-oriented interface enhancements to GMGN.ai and DeBot without executing trades.

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
- Inject recent buys, sells, theses, and position actions from users followed on FOMO directly into the GMGN tracker, with followed-user highlighting, username-first labels, and compact event badges.
- Alert on held-token price surges after confirming the current balance and GMGN app notification setting.
- Show 👥N beside tokens held by people you follow on FOMO, highlight those users in the FOMO Holders tab, and link Flap tax badges to the English tax page.
- Hide the third-party Lightning Trade button.
- Show FOMO data source, last successful refresh, partial coverage, and Following-only views on GMGN and DeBot.
- Catch up the followed-user tracker through bounded pages and show gaps when continuity cannot be established.
- Recover from request failures with retry/reconnect guidance and optional allowlisted clipboard diagnostics.

Holder-history reconstruction is a limited current-holder sample, not a complete token history. Fully exited users may be absent; Following-only filtering applies to the loaded sample. Neither a successful response nor a holder badge proves there have been no sells.

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
python3 scripts/build-release.py --tag v0.51.0
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
