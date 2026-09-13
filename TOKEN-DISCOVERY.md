# Token discovery implementation notes

## Current source and live evidence

The v0.53.26 local fix replaces v0.53.25's incorrect REST-source assumption. Native FOMO Discovery Trending selects `Gc → In("trending_tokens", ...)` in `authenticated-v2-BVad9-j9.js`; its selected branch disables the adjacent REST reader. The stream reducer in `token-v2-d2DTmrP3.js` applies server-index snapshots/deltas. Native rows use total supply × selected price, and `change24` ×100.

The helper now observes that existing native stream through the receive-only MAIN → isolated → worker bridge. No ranking REST request, account lookup, helper socket, subscription or Following polling is created. Opening the helper tab or clicking Refresh reads already-observed worker memory only.

The authorized debugging Chrome was reloaded and read back as v0.53.26, ENABLED, with the matching worker manifest. Its actual GMGN bottom-toolbar Trending mount rendered the new FOMO view. A live comparison verified the first eight exact chain/address identities in the same order as native FOMO, not merely matching symbols. A real active-tab round trip retained FOMO selection and the same displayed snapshot; monitoring observed zero ranking/account requests and zero new worker sockets during that check. The debugging browser continued reporting the inactive page as visible, so this live round trip does not prove the hidden-document branch. Production browser fixtures separately exercise hidden/visible cleanup and immediate restoration without requests.

Live verification placed no trades and did not reset settings. Commit, push and publication follow the separately authorized release workflow. Publishing a release does not update an unpacked extension automatically.

## Deliberate differences from the borrowed reference

- No permanent similarity card, per-token market lookup, token blocking or unrelated providers. Indicators stay in the gutter without changing names, row heights, financial actions or recycler transforms. Compare exists only after a click and closes on dismissal, route/account/visibility changes or expiry.
- Exact identity is chain plus address; Solana case is preserved. Conservative similar-name indicators are not asset identity, fraud or safety claims. Short/generic tickers and unknown metadata do not manufacture matches.
- Comparison uses bounded observations already available from native/passive/token-panel sources. Stale recycler stamps and unbound page titles cannot supply a token name.
- Trending state is separate from Following-roster eligibility and bound to native tab/document/account/epoch/sequence. Gaps, malformed frames, logout/account changes and socket errors invalidate it. The source needs a native snapshot before deltas and after invalid recovery; no REST fallback repairs missing observations.
- Source invalidation clears displayed ranking data while preserving the user's chosen FOMO view. Account invalidation resets comparison and selection too. Late loads cannot reopen a closed view.
- Server order and rank provenance are preserved without MC/percentage/symbol sorting. Links retain each row's own chain. Missing or invalid metrics remain unknown, and no remote logo requests are added.
- Native body nodes and handlers are restored on switch, close, hide or remount. Returning from document hiding or a compatible remount remembers FOMO selection without another read. Explicit close/native-tab selection, disable and account changes clear that choice. Unknown native mounts remain untouched.

## Bounds and limitations

- Comparison observations: 500 identities, 30-minute retention, stale after five minutes; Compare displays the current token and at most 50 similar identities. This is not exhaustive token search.
- Passive ranking reducer: at most 1,000 native rows, first 100 emitted as ordered full snapshots, coalesced at 250 ms. Worker snapshots expire within five minutes and are memory-only. Browser/worker restart can require a fresh native snapshot, such as reopening native Tokens → Trending or refreshing the FOMO page; helper Refresh does not ask the provider for one.
- A bounded committed-view adapter observes the native full list after hidden-token filtering and hover freezing, including removed-token snapshot fallbacks. Only mounted row display prices/chart overrides are copied; overlays are replaced on each capture. Stale/unresolved/conflicting views fall back explicitly to stream mode. Offscreen chart-price parity and immediate detection of silent offscreen commits remain unproven.
- Separate optional token-panel features retain their existing authenticated API reads and shared bounded admission/deadline/cooldown controls. The passive ranking path does not use them.
- Existing full usernames, two-line exceptional-name tooltips, Thesis presentation, Buy/More grouping and native QuickBuy guards are unchanged. Financial controls were not activated on the live profile.

## Verification

- Native-style rendering uses measured GMGN 40px row height, inherited Geist font, gold MC and native red/green change colors. Browser assertions cover 320/390/570/1280 CSS widths. Current full-gate output/hash evidence is generated at `test-results/native-view-full-verify.log` and `test-results/native-view-verify-status.json`; consult that result rather than the older stream-only gate.

- `scripts/test-native-visibility.mjs` passed with genuine native hidden/visible transitions in a disposable actual MV3 browser, no document-property overrides, correct body cleanup/selection restoration and zero extra reads on return. Shared debugging Chrome is affected by the Fomo bot's persistent Playwright focus emulation; that bot was not changed.

- `npm run test:discovery`: production worker, passive MAIN/isolated/worker VM pipeline, and full production content/CSS in isolated Chromium.
- `scripts/test-fomo-passive-e2e.mjs`: actual MV3 worker and trusted browser frames from an isolated local TLS WebSocket fixture; native ordering/deltas, supply-based MC, logout, and zero helper requests/socket sends.
- The committed-view/styling `npm run verify` gate passed with exit 0 and stable hashes across 104 source files. Release preparation changes only documentation and a Linux-only sandbox launch flag for the disposable DNS-blocked test browser; shipping runtime is unchanged. Live evidence in `test-results/live-native-view-parity.json` matched all 72 observed native identities in order during hover and exercised a real chart-price override; no hidden-token settings were changed.
- `test-results/live-trending-verification-v26.json`: sanitized live identity/order, installed-version and tab-selection evidence, with the visibility limitation recorded explicitly.
- `test-results/live-{helper-native-trending,fomo-native-trending,trending-restored}-v26.png`: live captures. `test-results/token-discovery-{trending,compare}-{320,390,570,1280}.png`: synthetic responsive fixtures, not live provider screenshots.

The canonical build allowlist now includes the new `fomo-native-view.js` runtime module. Tests, screenshots and local diagnostics stay outside the extension package. Unrelated untracked `docs/` is not part of this change.
