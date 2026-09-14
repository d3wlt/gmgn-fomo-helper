# GMGN FOMO Helper

A private Chrome MV3 extension that brings FOMO context into GMGN. Version **0.53.28** continues the private fork of “better gmgn,” originally based on upstream v0.46.27.

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
- Keeps original native GMGN row actions, followed-user highlighting and callout-account blocklists.
- FOMO trader names use the full available handle and wrap within existing card/table slots instead of a 72px ellipsis column. Compact rows allocate more room to names without overlapping amount/market-cap columns. The two-line name budget preserves 45px compact and 64.5px card geometry. Only exceptionally long names are visually clamped by CSS to two lines with an ellipsis and a viewport-bounded full-name hover/keyboard-focus tooltip. The complete source name stays in the DOM; no JavaScript prefix fitting can turn normal names into dots. CSS responds directly to layout and font changes. Normal names remain fully readable. Native GMGN names/actions/row heights are not rewritten.
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

- Tracker thesis events use the **Thesis** label with the actual post text, without a redundant position badge or tokenless THESIS placeholder; real token metadata and actions remain available.
- A FOMO token panel on GMGN shows holders, narratives and trades, with buy/sell and First/More/Partial/All labels, source information, refresh time and coverage warnings.
- On GMGN, **👥N** on the open token page's FOMO button at the end of its information header shows current holders among people you follow on FOMO. Hover shows returned names.
- Holder-count requests cover only the open token and exact chain, with one-minute successful-result caching while visible. No token-list or tracker holder-count scanning. Unavailable data is distinct from confirmed zero.
- Holder-history reconstruction is a limited sample of current holders, not complete token history. Fully exited users can be missing; neither a badge nor a successful response proves there have been no sells.
- The token panel has one vertical scrolling content region for status, filters and all loaded rows; the title and holder summary stay above it. Holder names get a full-width wrapping identity line, with ranking/Following/P&L badges below rather than squeezing the name.
- Panel UI and the local narrative translation target are always English, even with legacy saved translation-off/language preferences; there is no EN toggle. Original narrative text remains visible. Supported browsers add local English translations; selecting the panel can initialize/retry a required local language pack. If the browser does not provide a usable Translation API, original text remains available (no remote translation fallback).

The token panel and holder count may make their own scoped requests using your browser-local FOMO session. The **passive-only** guarantee describes the Following tracker, not every token-panel feature.

### Token comparison and FOMO Trending

- Small gutter indicators on native and FOMO tracked rows show **=** for the exact open token and **≈** for a similar observed name with a different identity. Exact means **chain + contract address**; Solana addresses remain case-sensitive. Conservative name matching excludes short/generic tickers and never labels a token a scam or the same asset.
- **Compare** in the token-information header opens a compact, dismissible comparison. It uses only observed native/passive/token-panel metadata: at most 500 identities retained for 30 minutes, stale after 5 minutes, with up to 50 similar identities shown. No permanent floating card, token blocking or additional market requests. Name matching needs previously observed metadata for the open identity; missing metadata stays unknown. This is not a complete token search.
- Sign in on FOMO once, then select **FOMO** in GMGN's bottom-toolbar **Trending** panel. While that panel is visible and selected, one shared extension-owned `trending_tokens` connection receives automatic updates. You do not need to keep FOMO's Trending view open or click Refresh for each update. Refresh is a reconnect fallback, not routine operation.
- Rankings retain server order and exact chain/address identity. Market cap is stream supply × stream price; 24-hour change converts the ratio to percentage points. Unknown metrics remain unknown. Hover, keyboard focus and active scrolling hold displayed rows; logout/session loss clears them immediately. Token navigation and compatible panel remounts retain the chosen source; hidden/closed panels release live demand.
- **Live**, **Connecting**, **Reconnecting** and session-unavailable states are distinct. Reconnects require a fresh full snapshot; retained transport snapshots expire within five minutes. Authentication uses the existing browser-local session plus a bounded, coalesced FOMO account/restriction check. The owned connection does not open, activate or refresh FOMO tabs, renew credentials itself, or create Following subscriptions. If the native session cannot renew, sign in on FOMO again. Native-page hidden-token filters and chart-price overrides are not applied to the independently advancing stream.

- The compact Trending layout follows GMGN’s native 40px rows and inherited font: gold market cap, muted secondary price and green/red 24-hour change. Unknown values remain neutral. No unsupported OG badges, counts, ages or token logos are fabricated.

### GMGN utilities

- Highlight watched developer wallets, show developer launch performance, save developer wallets and filter blocked callout accounts.
- Monitor your own positions for price surges with fresh ownership confirmation, valid cost/balance checks and native notification-setting handling. Hybrid multichain holdings and Robinhood are supported.
- Position-surge toasts dismiss after five seconds even while hovered, display Cost/5m metrics without a trailing token price, and remain available in notification history. Other reminders keep their existing behavior.
- Notification history opens from the bell at the end of GMGN's main navigation; the FOMO and notification launchers no longer float over page content. Unsupported or hidden native mount points do not get floating fallback buttons.
- Hide the third-party Lightning Trade button.

Open the native GMGN **Holding** panel to initialize the selected wallets. Surge monitoring needs a visible GMGN page and recent captured native request scopes. Expired scopes and ambiguous chain/account data fail closed.

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
python3 scripts/build-release.py --tag v0.53.28
```

On PowerShell:

```powershell
./scripts/build-release.ps1
```

Builders use the canonical runtime-file allowlist and produce `dist/gmgn-fomo-helper-vX.Y.Z.zip` plus its SHA-256 checksum. Tests, screenshots, local diagnostics and dependencies stay outside the package. Release notes must match the manifest version and include the required installation, usage, updating and privacy sections.

The tag-triggered GitHub workflow runs the verification suite before building and publishing release assets. Fixture tests cover production code with synthetic data and isolated Chromium, including account/route races, passive delivery, native-control guards, merged scrolling and MV3 lifecycle. They do not replace a signed-in smoke test when third-party interfaces change.
