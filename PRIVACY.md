# Privacy

GMGN FOMO Helper runs only on the sites declared in `manifest.json`. It injects packaged extension code for interface enhancements, browser-local session mirroring, and optional account-setting synchronization. It does not load remote executable code.

## Data stored locally

The extension may store:

- Feature settings, watched developer wallets, marked people, blocked accounts and tokens, special-watch metadata, and notification history.
- Cached token, holder, performance, FOMO, and display data.
- A mirror of the FOMO access and refresh session already present in a signed-in FOMO page. These credentials are used only with FOMO's own API.
- Diagnostic timestamps and status values needed for session renewal and synchronization.

The extension uses browser-local and session storage, not Chrome's sync storage. Browser/profile backups or administration may copy that data outside the extension's control.

## Network access

The extension communicates only with hosts declared in the manifest:

- `gmgn.ai`: reads page data and same-site API responses needed for interface features.
- `fomo.family` and `prod-api.fomo.family`: mirrors the signed-in browser session and requests token holders, narratives, trades, and performance data.
- Listed public BSC RPC endpoints: reads public contract state for token supply information.

The browser-local Translation and Language Detection APIs process supported narrative translations on the device. Original text remains visible alongside the English translation.

Native FOMO Following is passive: the helper observes activity in an already open signed-in FOMO tab. It does not create feed sockets, subscriptions, polling requests, or keeper tabs for this feed. Separate token panels and holder/performance lookups use the FOMO API. Retired provider credentials and caches are removed on worker startup.

## What the extension does not do

The extension does not include analytics, advertising, remote executable code, desktop companion software, wallet-signing logic or secret-key collection. Optional QuickBuy mounts GMGN's native control and uses its current account, amount and trading flow; the helper does not construct transactions itself. The extension does not claim affiliation with any supported service.

## Removal

Disable or remove the extension from the browser's extensions page to stop it. Remove the extension to clear its local extension storage according to browser behavior.
