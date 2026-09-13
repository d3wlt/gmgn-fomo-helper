# Product overview

GMGN FOMO Helper is an independent Chrome MV3 interface extension for GMGN.ai. This private copy preserves the upstream trading-view enhancements while making the maintained source and user interface English-only.

## Core behavior

- Highlights watched developers. Special-wallet watch/stars, colors and pinned activity have been retired.
- Adds developer history, token-page followed-holder counts, passive native FOMO Following, token FOMO panels, and notification views.
- Reads existing page and same-site API data without signing or submitting transactions.
- Uses browser-local language detection and translation to add English translations below non-English FOMO narratives. English is fixed regardless of legacy preferences; no EN toggle. Local pack/API availability still determines whether a translation can be produced.
- Keeps original narratives visible. Token-panel status and rows share one scrolling region, with full wrapping holder names above reflowing badges. Tracker names wrap within the existing fixed slots; exceptionally long names use CSS two-line clamping and a full-name hover/keyboard-focus tooltip, bounded to the viewport without changing native recycler geometry. Full source text is never replaced with a shortened JavaScript prefix.
- Stores preferences and limited caches in browser-local extension storage.

## On-demand discovery

- Token-row indicators distinguish exact chain/address identity from conservative name similarity. Short/generic tickers and unknown metadata do not produce guessed matches; name similarity is neither identity nor a safety judgment. The optional Compare view uses at most 500 local observed identities retained for 30 minutes, labels five-minute-old observations stale, and adds no market requests or blocking. Native row heights, names and actions are preserved.
- FOMO Trending is a tab in GMGN's existing native Trending panel, not a second permanent overlay. It makes an authenticated read through the existing FOMO session machinery only when the user opens the tab or selects Refresh. It uses a 60-second account-bound memory cache, request coalescing, bounded shared pacing and Retry-After cooldowns. If the mirrored JWT uses a Privy identity, this same on-demand load verifies the application account through authenticated `GET /v2/users/current` before reading rankings. It adds no Following polling or socket.
- Rankings preserve provider order/provenance and exact chain navigation. Loading, empty, error and stale states are explicit; stale rows have a five-minute maximum lifetime. Native content is restored on switching, closing, hiding or remounting, and account/logout races cannot paint old results. Unknown native structures fail closed. A dispatched read can finish after the UI closes, without reopening it.

## Distribution

Distribution is ZIP-only through this repository's GitHub Releases page. Users verify the supplied SHA-256 checksum, extract the archive, and load it as an unpacked extension. Updates are manual and require no companion application.

## Boundaries

This project has no analytics, remote executable code or its own wallet-signing/trading API. Explicitly activating QuickBuy can execute a real trade through GMGN's native controls; the helper does not submit trades automatically. It is not affiliated with the supported websites or the original upstream author.

Repository: <https://github.com/d3wlt/gmgn-fomo-helper>
