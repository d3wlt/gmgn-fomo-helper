# Product overview

GMGN FOMO Helper is an independent Chrome MV3 interface extension for GMGN.ai. This private copy preserves the upstream trading-view enhancements while making the maintained source and user interface English-only.

## Core behavior

- Highlights watched developers. Special-wallet watch/stars, colors and pinned activity have been retired.
- Adds developer history, token-page followed-holder counts, passive native FOMO Following, token FOMO panels, and notification views.
- Reads existing page and same-site API data without signing or submitting transactions.
- Uses browser-local language detection and translation to add English translations below non-English FOMO narratives. English is fixed regardless of legacy preferences; no EN toggle. Local pack/API availability still determines whether a translation can be produced.
- Keeps original narratives visible. Token-panel status and rows share one scrolling region, with full wrapping holder names above reflowing badges. Tracker names wrap within the existing fixed slots; only overflowed names receive a grapheme-safe `...` prefix and full-name hover/keyboard-focus tooltip, bounded to the viewport without changing native recycler geometry.
- Stores preferences and limited caches in browser-local extension storage.

## Distribution

Distribution is ZIP-only through this repository's GitHub Releases page. Users verify the supplied SHA-256 checksum, extract the archive, and load it as an unpacked extension. Updates are manual and require no companion application.

## Boundaries

This project has no analytics, remote executable code or its own wallet-signing/trading API. Explicitly activating QuickBuy can execute a real trade through GMGN's native controls; the helper does not submit trades automatically. It is not affiliated with the supported websites or the original upstream author.

Repository: <https://github.com/d3wlt/gmgn-fomo-helper>
