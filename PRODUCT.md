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
- FOMO Trending is a tab in GMGN's existing native Trending panel, not a second permanent overlay. It reads snapshots already observed from the existing FOMO tab's native `trending_tokens` stream. Open FOMO's **Tokens → Trending** view to initialize it. Open/Refresh reads worker memory, not the REST API; no helper socket, subscription, account lookup or polling is added. Returning from another browser tab remembers the FOMO selection without a data request.
- Rankings preserve native provenance and exact chain navigation. Native-view mode observes the committed list after local hidden filtering and hover freezing, plus mounted-row price inputs; unvalidated views fall back explicitly to stream order. Offscreen chart overrides and silent offscreen commits are not guaranteed. Loading/empty/error/stale states are explicit, with a five-minute maximum lifetime. Native nodes are restored on switch/close/hide/remount; account/logout races cannot paint old results. MC uses observed supply × the applicable observed price.

## Distribution

Distribution is ZIP-only through this repository's GitHub Releases page. Users verify the supplied SHA-256 checksum, extract the archive, and load it as an unpacked extension. Updates are manual and require no companion application.

## Boundaries

This project has no analytics, remote executable code or its own wallet-signing/trading API. Explicitly activating QuickBuy can execute a real trade through GMGN's native controls; the helper does not submit trades automatically. It is not affiliated with the supported websites or the original upstream author.

Repository: <https://github.com/d3wlt/gmgn-fomo-helper>
