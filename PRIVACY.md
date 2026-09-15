# Privacy

GMGN FOMO Helper runs only on the sites declared in `manifest.json`. It injects packaged extension code for interface enhancements, browser-local session mirroring, and optional account-setting synchronization. It does not load remote executable code.

## Data stored locally

The extension may store:

- Feature settings, watched developer wallets, marked people, blocked callout accounts, and notification history. Retired token-block and special-watch settings may remain in older local storage but are no longer used.
- Cached token, holder, performance, FOMO, and display data.
- The selected Trending source for up to 128 browser tabs, in extension-only session storage. It survives page reloads and worker restarts, not browser restarts. Tab closure, explicit native selection/close, feature disable and account invalidation remove the choice. This preference contains no rankings, account identifiers, URLs or credentials and does not create live demand.
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

FOMO Trending uses one shared authenticated WebSocket to `wss://prod-api.fomo.family/ws`, subscribing only to `trending_tokens` while a selected, visible GMGN panel has validated demand. It receives server snapshots/deltas automatically. Hidden/closed panels release demand; the last consumer stops the socket and clears ranking memory. Refresh requests a reconnect. There is no REST ranking fallback and no extra Following subscription or polling.

The worker verifies the existing mirrored access token with a bounded, coalesced `GET /v2/users/current` when needed, requiring an unrestricted account and matching an observed native account when available. Tokens are never returned to GMGN or panel messages. The content mirror sends serialized authenticated-session observations to the worker; `webNavigation` validates the actual current top-level document, not an arbitrary page-supplied account claim. It is used for document checks, not browsing-history collection. Session-only owner/sequence/revocation metadata prevents pending work and worker restart from reviving a logged-out session; credentials remain in extension-local storage for compatibility with existing features. Repeated unchanged credential observations do not rewrite credentials.

This ranking path does not create keeper tabs, activate/reload FOMO, execute refresh-token exchanges, or bypass sign-in, restrictions or verification gates. It needs a valid native session; indefinite operation without a native session-renewal owner is not guaranteed. Transport retries are bounded and fail closed on authentication loss. Reconnecting snapshots are memory-only and expire within five minutes. Native-page hidden filters and mounted chart-price overrides are not applied to owned-stream rankings. The separate receive-only native bridge remains available for existing passive observations; it creates no feed requests.

Token comparison sends no requests. It retains up to 500 chain/address identities and their observed names/source times in page memory for 30 minutes, labels observations stale after five minutes, and clears on account invalidation or page destruction. The comparison view is created only on demand. Missing metadata is not looked up or invented.

## What the extension does not do

The extension does not include analytics, advertising, remote executable code, desktop companion software, wallet-signing logic or secret-key collection. Optional QuickBuy mounts GMGN's native control and uses its current account, amount and trading flow; the helper does not construct transactions itself. The extension does not claim affiliation with any supported service.

## Removal

Disable or remove the extension from the browser's extensions page to stop it. Remove the extension to clear its local extension storage according to browser behavior.
