# Privacy

better gmgn runs only on the sites declared in `manifest.json`. It injects packaged extension code for interface enhancements, browser-local session mirroring, and optional account-setting synchronization. It does not load remote executable code.

## Data stored locally

The extension may store:

- Feature settings, watched developer wallets, marked people, blocked accounts and tokens, special-watch metadata, and notification history.
- Cached token, holder, performance, FOMO, Pump, and display data.
- A mirror of the FOMO access and refresh session already present in a signed-in FOMO page. These credentials are used only with FOMO's own API.
- A purpose-limited read-only 985monitor session and cached account filters after the user opens 985monitor while signed in.
- Diagnostic timestamps and status values needed for session renewal and synchronization.

Chrome local storage remains on the user's browser profile unless Chrome synchronization or browser administration changes that behavior.

## Network access

The extension communicates only with hosts declared in the manifest or a custom HTTPS BSC RPC host that the user explicitly grants:

- `gmgn.ai`: reads page data and same-site API responses needed for interface features.
- `debot.ai`: augments token and tracking interfaces.
- `fomo.family` and `prod-api.fomo.family`: mirrors the signed-in browser session and requests token holders, narratives, trades, and performance data.
- `985monitor.xyz`: optionally obtains a purpose-limited read-only session and retrieves account-filtered FOMO/Pump configuration and feeds.
- Listed public BSC RPC endpoints, or a user-approved custom HTTPS RPC: reads public contract state for Flap tax and supply information.

The browser-local Translation and Language Detection APIs process supported narrative translations on the device. Original text remains visible alongside the English translation.

## What the extension does not do

The extension does not include analytics, advertising, remote executable code, desktop companion software, wallet signing, secret-key collection, or transaction execution. It does not claim affiliation with any supported service.

## Removal

Disable or remove the extension from the browser's extensions page to stop it. Remove the extension to clear its local extension storage according to browser behavior.
