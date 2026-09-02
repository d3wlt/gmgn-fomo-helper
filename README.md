# better gmgn

An independent private copy of the Chrome MV3 extension “better gmgn.” Version 0.47.1 is based on upstream version 0.46.27 and adds trading-oriented interface enhancements to GMGN.ai and DeBot without executing trades.

This repository is not affiliated with GMGN, DeBot, FOMO, Pump, 985monitor, or the original upstream author.

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
- Add a FOMO panel for token holders, narratives, and trades using your browser-local FOMO session.
- Translate non-English FOMO and DeBot narratives into English with the browser's local Translation API while keeping the original text.
- Insert account-filtered FOMO and Pump activity from 985monitor into tracking feeds when that optional integration is connected.
- Alert on held-token price surges after confirming the current balance and GMGN app notification setting.
- Show marked-holder and Flap tax badges.
- Hide the third-party Lightning Trade button.

## Privacy and safety

The extension stores settings, cached display data, and supported-site session mirrors in Chrome local storage. It does not include analytics, remote executable code, wallet signing, or transaction execution. See [PRIVACY.md](PRIVACY.md) for details.

## Build a release

On PowerShell:

```powershell
./scripts/build-release.ps1
```

The script creates only `dist/985gmgn-helper-vX.Y.Z.zip` and its `.sha256` checksum. Release notes are built from the matching current note with `scripts/build-release-notes.ps1`.

Run the repository audit:

```bash
node scripts/verify-audit-fixes.mjs
```

## Repository

Private-copy source and releases: <https://github.com/d3wlt/985gmgn-helper-private>
