# Privacy

GMGN FOMO Helper runs only on the sites declared in `manifest.json`. It injects packaged extension code for interface enhancements, browser-local session mirroring, and optional account-setting synchronization. It does not load remote executable code.

## Data stored locally

The extension may store:

- Feature settings, watched developer wallets, marked people, blocked callout accounts, and notification history. Retired token-block and special-watch settings may remain in older local storage but are no longer used.
- Cached token, holder, performance, FOMO, and display data.
- A mirror of the FOMO access and refresh session already present in a signed-in FOMO page. These credentials are used only with FOMO's own API.
- Diagnostic timestamps and status values needed for session renewal and synchronization.

The extension uses browser-local and session storage, not Chrome's sync storage. Browser/profile backups or administration may copy that data outside the extension's control.

## Network access

The extension communicates only with hosts declared in the manifest:

- `gmgn.ai`: reads page data and same-site API responses needed for interface features.
- `fomo.family` and `prod-api.fomo.family`: mirrors the signed-in browser session and requests token holders, narratives, trades and performance data for those separate features.
- Listed public BSC RPC endpoints: reads public contract state for token supply information.

The browser-local Translation and Language Detection APIs process supported narrative translations on the device. Original text remains visible alongside the English translation.

Native FOMO Following is passive: the helper observes activity in an already open signed-in FOMO tab. It does not create feed sockets, subscriptions, polling requests, or keeper tabs for this feed. Separate token panels and holder/performance lookups use the FOMO API. Retired provider credentials and caches are removed on worker startup.

The FOMO tab in GMGN's native Trending panel reads a bounded snapshot of `trending_tokens` data already received by an existing FOMO tab. Open **FOMO → Tokens → Trending** to let the native application receive its stream. The helper observes native snapshots/deltas without creating sockets, subscriptions, provider requests or polling timers. Opening the helper tab or selecting Refresh reads worker memory only; there is no REST ranking fallback or additional account lookup. Stale data expires within five minutes. Tab/document/account invalidation clears or rejects old snapshots. Returning to GMGN remembers the FOMO selection and restores its displayed snapshot without requesting data. Explicit native-tab selection, closing the panel, disabling the feature or account invalidation clears that selection. No rankings are persisted across worker/browser restart.

When its committed native Trending view can be validated, the helper also copies bounded public token descriptors and mounted-row price inputs from that view. This reflects native filtering/frozen order without reading hidden-token settings, private account context, watchlists or friend-holder maps. Observation is mutation/stream-event driven, not a new polling loop. Unsupported views use an explicitly labelled stream snapshot; offscreen chart-price parity is not guaranteed.

Token comparison sends no requests. It retains up to 500 chain/address identities and their observed names/source times in page memory for 30 minutes, labels observations stale after five minutes, and clears on account invalidation or page destruction. The comparison view is created only on demand. Missing metadata is not looked up or invented.

## What the extension does not do

The extension does not include analytics, advertising, remote executable code, desktop companion software, wallet-signing logic or secret-key collection. Optional QuickBuy mounts GMGN's native control and uses its current account, amount and trading flow; the helper does not construct transactions itself. The extension does not claim affiliation with any supported service.

## Removal

Disable or remove the extension from the browser's extensions page to stop it. Remove the extension to clear its local extension storage according to browser behavior.
