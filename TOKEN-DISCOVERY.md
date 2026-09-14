# Token discovery implementation notes

## Current architecture

The maintained Trending path is an extension-owned authenticated `trending_tokens` subscription, distinct from passive Following. Native source `Gc → In("trending_tokens", ...)` and the `Wp` reducer establish snapshot/delta ordering and supply × price MC; the separate REST ranking endpoint is not a fallback.

- `fomo-trending-session.js`: serializes validated top-level FOMO document observations; verifies the mirrored JWT with `GET https://prod-api.fomo.family/v2/users/current` when necessary; requires an unrestricted account and matches an observed native identity. Native account IDs and JWT subjects are different namespaces. Same-sub expiry ordering cannot choose across accounts.
- `fomo-trending-live.js`: owns `wss://prod-api.fomo.family/ws`, replies to the verified challenge protocol, and subscribes only after acceptance to topic `56,143,4663,8453,1399811149`. Ethereum is not added by guessing its native feature gate. The result provenance is `owned-stream`.
- `fomo-trending-demand.js`: one shared producer for current-document-validated GMGN consumers, with bounded ports and leases. A selected visible panel sends local runtime-port demand; there is no per-tab provider socket.
- `background.js`: imports all three modules, routes private mirror ingestion, binds native account/logout observations and credential rotation, and pushes ranking DTOs through ports. Tokens never appear in the UI DTO or runtime responses.
- `content.js`: preserves source selection through token navigation and compatible remounts, renders batched updates automatically, and releases demand when hidden/closed. Hover, keyboard focus and scrolling hold rows. Auth loss bypasses interaction holds to clear data immediately.

Native document/panel changes are not account changes. Repeated unchanged mirror observations persist sequence ownership without rewriting credentials; same-account credential rotation does not deselect Trending. Following collectors, native trading controls and settings are outside this feature.

## Lifecycle and limits

- Start only with validated visible-panel demand. Stop and clear worker ranking memory when the last consumer leaves. Refresh is an explicit reconnect fallback.
- Require authenticated full snapshots before applying deltas, including after reconnect. Preserve server order; new/update fully replaces a row at the clamped native index, and a valid absent remove is a no-op.
- Exact identity is chain plus contract; Solana case is preserved. Bound retained rows to 1,000 and emitted rows to 100; coalesce at 250 ms. Missing/invalid metrics remain unknown. MC is stream supply × stream price, and 24-hour ratios become percentages.
- Auth/snapshot deadlines, generation checks, finite exponential retries and five-minute retained transport snapshots prevent unbounded or falsely fresh recovery. There is no invented WebSocket heartbeat or ranking REST fallback.
- The broker rejects ambiguous candidates and restricted/mismatched/expired sessions, checks through delayed response-body completion, and persists logout revocation in extension-only session storage. Recovery needs a new validated account observation and fresh mirror epoch/document. `webNavigation` is required for current-document validation, not history collection.
- The ranking path never creates a keeper, activates/reloads FOMO, manually exchanges refresh tokens, or bypasses sign-in/verification gates. It follows legitimate credential rotation already supplied by the native session. Indefinite operation without a native session-renewal owner is not guaranteed.
- Owned rankings do not apply FOMO's local hidden-token filters, frozen native membership or mounted chart-price overrides. The separate receive-only native observer remains for passive data; its v0.53.26 parity evidence is not proof of parity for the independently advancing owned stream.

## Comparison and existing UI

Compare remains opt-in and observation-only: at most 500 identities retained for 30 minutes, stale after five minutes, with up to 50 similar identities displayed. Conservative name similarity is not identity, safety or scam evidence. Unknown metadata never manufactures a match.

Native row geometry, names, Thesis presentation, Buy/More grouping, QuickBuy guards and existing token-panel API features remain unchanged. Trending uses the established inherited font, 40px density, gold MC and signed red/green changes; it does not invent logos, badges, counts or ages.

## Verification and delivery boundary

- `npm run test:owned`: production-source session, transport and demand regressions, including no-op credential mirroring, logout races, account separation, ordering, bounds, expiry, retry deadlines and stop cleanup.
- `npm run test:discovery`: existing passive/committed-view regressions plus full production content/CSS browser checks at 320/390/570/1280 CSS widths.
- `scripts/test-fomo-passive-e2e.mjs`: actual MV3 passive bridge with trusted local TLS frames and genuine visibility transitions; does not prove the owned connection by itself.
- `npm run verify`: whole-project gate. Older v0.53.27 release gates do not cover this implementation.
- Local live diagnostics under `test-results/` distinguish current worker snapshots, rendered panel changes and native subscription state. The attached debugging Chrome has pre-existing focus emulation, so an inactive FOMO tab reporting `visible` is not genuine hidden-document proof. A native Trending unsubscribe with continued owned updates proves independence from that subscription, not page-free indefinite auth renewal.

## Verified release

[v0.53.28](https://github.com/d3wlt/gmgn-fomo-helper/releases/tag/v0.53.28) is published from commit `bce95546e2bc41a16d812d8e75bd8cafa36346c9`. The full local gate passed with unchanged hashes across 112 source files before release metadata preparation; the tagged commit also passed [release CI](https://github.com/d3wlt/gmgn-fomo-helper/actions/runs/34832317295).

The source-stable live run lasted 901.539 seconds and recorded 61 distinct stream and rendered-list samples after native Trending unsubscribed, with no further native Trending data. This proves subscription independence; the shared browser's visibility limitation described above still applies. Separate actual-MV3 fixtures verified genuine hidden-page updates, one shared socket across two visible GMGN windows, last-demand teardown, transport-loss recovery, worker restart and durable logout without manual Refresh or Following subscriptions.

The published ZIP's checksum and all 21 allowlisted files were verified against the committed source, allowing only Windows line-ending normalization. The package includes the three owned runtime modules; tests, screenshots and local diagnostics are not shipped. No trades or settings resets were performed. Unpacked installations do not auto-update from GitHub publication.
