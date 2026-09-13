# Token discovery implementation notes

## Evidence and boundaries

Prepared for v0.53.25. The feature workstream performed no live extension reload, provider API request or trade. Signed-in Chrome was inspected read-only over CDP; fixture screenshots are not live-account validation. Release packaging and publication are separate from live installation.

The loaded official FOMO bundle `https://fomo.family/assets/token-v2-d2DTmrP3.js` maps `trending` to `/proxy/trendingTokens`. Its native `La` reader performs a POST and returns `responseObject`; the native query is keyed by the FOMO user. The same bundle's `Qt` formatter multiplies `change24` by 100. The implementation preserves that ratio-to-percentage conversion explicitly as `change24Percent`.

GMGN's loaded native Trending source (`Main`, `index.tsx`, chunk 94232) has a header plus a single flex body and derives `filter-tag-trending` from the native filter-tag component. The new tab only accepts this structure; it does not guess an arbitrary ancestor from row height. Trending was not open in the inspected live tab, so its final signed-in rendered mount remains a parent integration-review item.

Read-only tracker inspection confirmed native `TrackerListItem` links, 64.5px slots, and the existing bridge's chain/address/symbol/timestamp stamps. The code rejects a stale symbol stamp when its identity no longer agrees with the recycled link. Existing card/table and financial-control tests remain authoritative for those separate adapters.

## Deliberate differences from the borrowed reference

- No always-visible similarity floating card, per-token market lookup, token blocking, unrelated providers or retired watches. Markers stay inside the left gutter without altering names, row height, financial actions or recycler transforms. Compare is created only on a user click and removed on dismiss/route/account/visibility changes or snapshot expiry.
- Exact identity is chain plus address. Solana preserves case. Similarity never claims identity, fraud or safety; short/generic tickers are excluded. A conservative normalized-name match or one edit in a long name is enough only for a *similar-name* indicator. Unknown metadata does not manufacture matches.
- Comparison uses bounded local native/passive/token-panel observations. It does not infer an open token's name from an unbound or stale page title. Consequently an exact indicator can work before name matching is available. The snapshot labels ages at opening and expires with its oldest retained observation.
- No anonymous global Trending cache. The worker requires the existing FOMO session, coalesces requests, and invalidates on both mirrored-session and earlier native account/logout signals. Pending body reads are invalidated/aborted; a newly observed account must agree with the credential identity or an authenticated `/v2/users/current` response before a ranking read. Privy and FOMO IDs are different namespaces; the account lookup is coalesced inside the user-triggered load, never polled.
- No Trending timer or new connection. User open/Refresh gestures are the only load path; Refresh respects the 60-second cache. The existing authenticated helper now shares four active slots, a 32-entry admission queue and paced starts, in addition to its Retry-After/error cooldowns and body deadline.
- Provider order and original rank positions survive deduplication; the code does not sort by market cap or invent contiguous ranks after rejecting unsupported rows. Chain-safe links retain the row's own network. Missing/negative/malformed metrics stay unknown; no remote logo requests are added.
- Native body nodes and handlers are preserved, hidden only while FOMO is active, and restored on native selection/close, document hide or host remount. Native selected-tab tone is suppressed only while FOMO is active. Unknown mounts leave native UI alone.

## Bounds and limitations

- Observation memory: 500 unique identities, 30-minute activity-age retention, stale after five minutes; Compare shows the current token and at most 50 similar identities. It is not an exhaustive token search, and conservative matching deliberately has false negatives.
- Trending reads examine at most 200 returned records and preserve the provider's order. Successful cache lifetime is 60 seconds; stale rows expire after five minutes. Worker/page restarts clear these memory-only caches. An already dispatched read may finish after the panel closes but cannot reopen it.
- Price/MC are FOMO snapshots, not live quotes. Unknown native markup is unsupported until reviewed. Fixture coverage cannot guarantee future third-party DOM or API compatibility.
- Existing full usernames, two-line exceptional-name clamp/tooltips, Thesis body/label without the redundant badge, Buy/More grouping and native QuickBuy guards are unchanged. No financial gesture is exercised against the live profile.

## Verification entry points

- `npm run test:discovery`: full production worker VM and full production content/CSS in isolated Chromium, with synthetic responses and native mounts.
- `npm run verify`: the new tests plus the existing worker, typography, panel, native QuickBuy, merged-scroll, passive-source, MV3 lifecycle and packaging/reference gates.
- `test-results/token-discovery-full-verify-final.log` and `test-results/token-discovery-verify-status.json`: full-gate output, exit status and before/after source hashes (local artifacts).
- `test-results/token-discovery-{trending,compare}-{320,390,570,1280}.png`: responsive fixture screenshots. Browser assertions check exact viewport, overflow, controls, native row heights, retained native nodes/actions, and inactive-request counts.

New runtime files are not required; the existing canonical build allowlist remains sufficient.
