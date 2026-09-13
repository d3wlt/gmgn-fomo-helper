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
- `fomo.family` and `prod-api.fomo.family`: mirrors the signed-in browser session and requests token holders, narratives, trades, performance data, and on-demand Trending rankings.
- Listed public BSC RPC endpoints: reads public contract state for token supply information.

The browser-local Translation and Language Detection APIs process supported narrative translations on the device. Original text remains visible alongside the English translation.

Native FOMO Following is passive: the helper observes activity in an already open signed-in FOMO tab. It does not create feed sockets, subscriptions, polling requests, or keeper tabs for this feed. Separate token panels and holder/performance lookups use the FOMO API. Retired provider credentials and caches are removed on worker startup.

The FOMO tab in GMGN's native Trending panel sends an authenticated `POST /proxy/trendingTokens` only when opened or manually refreshed. There is no Trending timer or extra socket. The worker's memory-only, account-bound cache lasts 60 seconds; concurrent requests coalesce, shared admission is bounded and paced, and HTTP 429 Retry-After imposes a cooldown. Errors can retain stale rankings for at most five minutes. Account/logout changes invalidate results, including pending body decoding. Closing/hiding a panel suppresses late UI updates; a request already dispatched may finish in the worker. Ranking reads do not submit trades.

When the mirrored session uses a Privy identity rather than the observed FOMO application user ID, the same on-demand Trending load first reads authenticated `GET /v2/users/current` to verify the account mapping. That verification coalesces with the ranking load; it is not Following polling.

Token comparison sends no requests. It retains up to 500 chain/address identities and their observed names/source times in page memory for 30 minutes, labels observations stale after five minutes, and clears on account invalidation or page destruction. The comparison view is created only on demand. Missing metadata is not looked up or invented.

## What the extension does not do

The extension does not include analytics, advertising, remote executable code, desktop companion software, wallet-signing logic or secret-key collection. Optional QuickBuy mounts GMGN's native control and uses its current account, amount and trading flow; the helper does not construct transactions itself. The extension does not claim affiliation with any supported service.

## Removal

Disable or remove the extension from the browser's extensions page to stop it. Remove the extension to clear its local extension storage according to browser behavior.
