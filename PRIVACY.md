# Privacy

better gmgn runs only on the sites declared in `manifest.json`. It injects packaged extension code for interface enhancements, browser-local session mirroring, and optional account-setting synchronization. It does not load remote executable code.

## Data stored locally

The extension may store:

- Feature settings, watched developer wallets, marked people, blocked accounts and tokens, special-watch metadata, and notification history.
- Cached token, holder, performance, FOMO, Pump, and display data.
- A mirror of the FOMO access and refresh session already present in a signed-in FOMO page. These credentials are used only with FOMO's own API.
- A mirror of the J7Tracker session already present in a signed-in `j7tracker.io` page, plus connection state and tracked-account counts. It is used only to read that account's FOMO and Pump social history.
- Diagnostic timestamps and status values needed for session renewal and synchronization.

Chrome local storage remains on the user's browser profile unless Chrome synchronization or browser administration changes that behavior.

## Network access

The extension communicates only with hosts declared in the manifest or a custom HTTPS BSC RPC host that the user explicitly grants:

- `gmgn.ai`: reads page data and same-site API responses needed for interface features.
- `debot.ai`: augments token and tracking interfaces.
- `fomo.family` and `prod-api.fomo.family`: mirrors the signed-in browser session and requests token holders, narratives, trades, and performance data.
- `j7tracker.io`: mirrors the signed-in browser session. `nj.j7tracker.io`: verifies the account's tracked FOMO/Pump lists and receives account-filtered history and live social events over J7Tracker's Socket.IO endpoint.
- Listed public BSC RPC endpoints, or a user-approved custom HTTPS RPC: reads public contract state for Flap tax and supply information.

The browser-local Translation and Language Detection APIs process supported narrative translations on the device. Original text remains visible alongside the English translation.

## What the extension does not do

The extension does not include analytics, advertising, remote executable code, desktop companion software, wallet signing, secret-key collection, or transaction execution. The packaged Socket.IO client is a pinned local MIT-licensed dependency; no script is downloaded at runtime. The extension does not claim affiliation with any supported service.

## Removal

Disable or remove the extension from the browser's extensions page to stop it. Remove the extension to clear its local extension storage according to browser behavior.
