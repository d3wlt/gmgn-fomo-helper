# GMGN FOMO Helper

A private Chrome MV3 extension that brings FOMO context into GMGN. Version **0.53.18** continues the private fork of “better gmgn,” originally based on upstream v0.46.27.

**J7Tracker and DeBot integrations have been removed.** No J7Tracker account, tab or companion service is required; the extension no longer integrates with DeBot. The native GMGN tracker and passive FOMO Following feed remain separate from that retired integration.

This project is not affiliated with GMGN, FOMO or the original upstream author.

## Install and update

1. Download the versioned extension ZIP and matching `.sha256` file from [Releases](https://github.com/d3wlt/gmgn-fomo-helper/releases). Repository access is required.
2. Verify the ZIP checksum, then extract it to a permanent folder.
3. Open `chrome://extensions` or `edge://extensions` and enable **Developer mode**.
4. Select **Load unpacked** and choose the extracted folder.
5. Refresh GMGN and your existing signed-in FOMO tab so the page observers initialize.

For an update, replace the files in your existing unpacked extension folder, select **Reload** on its extension card, and refresh the supported pages. Chromium does not automatically update unpacked extensions. Keep the same browser profile; the extension identity is preserved across the repository rename.

## Features

### One GMGN + FOMO tracker

- Interleaves passive FOMO Following activity with original native GMGN cards in one chronological panel and one scrollbar.
- Handles fractional native row heights and asynchronous row recycling without rebuilding the panel during normal scrolling.
- Preserves your reading position when new activity arrives below the top. Unsupported geometry or persistently stale index data fails closed instead of guessing native row positions.
- Keeps original native GMGN row actions, token blocking and followed-user highlighting.
- FOMO cards can expose GMGN's **native QuickBuy** on hover, including Robinhood. It uses GMGN's Following wallet/amount settings and validates the current account, chain and token.

**Clicking native QuickBuy can execute a real trade.** The helper does not submit trades automatically or implement its own trading API. Native controls stay unavailable if their supported context cannot be verified.

### Passive Following feed

Keep a FOMO tab open and signed in so the native application receives activity. Open your FOMO profile if the following roster has not initialized, and select Alerts as needed to receive native activity. The helper observes supported native history responses and live frames; it does **not** independently poll the Following feed, open sockets, subscribe, reconnect or create hidden keeper tabs.

- Tracker status distinguishes waiting for a tab, account, following roster or activity from connection states.
- Closing, signing out, navigating away from or suspending the source tab can stop delivery.
- Missed activity is recovered only when FOMO itself receives it.
- The account-isolated buffer is bounded to 500 events; the tracker renders its eligible retained rows without a separate 40-card cap. This is not complete lifetime history.
- Grouped multi-user and transfer rows are not supported. Worker/browser restarts may clear the passive event cache; subsequent native observations refill it.
- Names, avatars, tickers and market caps come from observed native data. Missing metadata has explicit fallbacks rather than invented values.

### Token context

- A FOMO token panel on GMGN shows holders, narratives and trades, with buy/sell and First/More/Partial/All labels, source information, refresh time and coverage warnings.
- On GMGN, **👥N** on the open token page's FOMO button at the end of its information header shows current holders among people you follow on FOMO. Hover shows returned names.
- Holder-count requests cover only the open token and exact chain, with one-minute successful-result caching while visible. No token-list or tracker holder-count scanning. Unavailable data is distinct from confirmed zero.
- Holder-history reconstruction is a limited sample of current holders, not complete token history. Fully exited users can be missing; neither a badge nor a successful response proves there have been no sells.
- Supported non-English narratives can use the browser's local Translation API while retaining the original text.

The token panel and holder count may make their own scoped requests using your browser-local FOMO session. The **passive-only** guarantee describes the Following tracker, not every token-panel feature.

### GMGN utilities

- Highlight watched developer wallets, show developer launch performance, save developer wallets and filter blocked callout accounts.
- Monitor your own positions for price surges with fresh ownership confirmation, valid cost/balance checks and native notification-setting handling. Hybrid multichain holdings and Robinhood are supported.
- Position-surge toasts dismiss after five seconds even while hovered, display Cost/5m metrics without a trailing token price, and remain available in notification history. Other reminders keep their existing behavior.
- Notification history opens from the bell at the end of GMGN's main navigation; the FOMO and notification launchers no longer float over page content. Unsupported or hidden native mount points do not get floating fallback buttons.
- Hide the third-party Lightning Trade button.

Open the native GMGN **Holding** panel to initialize the selected wallets. Surge monitoring needs a visible GMGN page and recent captured native request scopes. Expired scopes and ambiguous chain/account data fail closed. Manifesto pop-ups/list tabs, Flap tax badges, custom BSC RPC settings, J7Tracker/Pump activity and DeBot support are not included.

## Diagnostics

In the extension popup, open **Diagnostics**, enable **Debug logging**, reproduce the issue, then select **Export logs**. Include a screenshot and approximate time when reporting a problem; turn logging off afterwards. **Clear logs** removes stored history, not files already exported.

Logging is off by default and local-only. It records bounded categorical outcomes, timings and counts—not credentials, cookies, raw responses, user names/IDs, wallet/token addresses, trade IDs or narrative text. There are no automatic uploads. The ring holds at most 500 entries from the previous 24 hours; batched writes can lose trailing unsaved entries if the browser stops.

## Privacy and safety

Settings, supported-site session mirrors and bounded display/diagnostic data are stored in browser extension storage. No browser profiles or credentials are bundled in release ZIPs. The helper has no analytics or remote executable code. Native trading buttons can execute trades through the host site when you explicitly activate them; this is distinct from the helper submitting transactions itself. See [PRIVACY.md](PRIVACY.md).

## Development and releases

Requirements: Node.js 22+, Python 3 for the portable builder, or PowerShell for the Windows builder.

```bash
npm ci
npx playwright install chromium
npm run verify
python3 scripts/build-release.py --tag v0.53.18
```

On PowerShell:

```powershell
./scripts/build-release.ps1
```

Builders use the canonical runtime-file allowlist and produce `dist/gmgn-fomo-helper-vX.Y.Z.zip` plus its SHA-256 checksum. Tests, screenshots, local diagnostics and dependencies stay outside the package. Release notes must match the manifest version and include the required installation, usage, updating and privacy sections.

The tag-triggered GitHub workflow runs the verification suite before building and publishing release assets. Fixture tests cover production code with synthetic data and isolated Chromium, including account/route races, passive delivery, native-control guards, merged scrolling, retirement of removed integrations and MV3 lifecycle. They do not replace a signed-in smoke test when third-party interfaces change.
