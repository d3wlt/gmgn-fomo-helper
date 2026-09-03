# Changelog

## 0.48.1 - 2026-09-03

- Rejected malformed, `success:false`, and unexpected application-status FOMO responses instead of caching them as successful empty following/feed results.
- Retained the followed-user buy/sell/thesis tracker injection and explicit popup sell labels introduced in 0.48.0.

## 0.48.0 - 2026-09-03

- Kept FOMO sell activity in the popup Trades tab and added explicit Buy/Sell plus First/More/Partial/All position labels.
- Added authenticated polling of FOMO's current following list and recent trading activity, filtering activity to followed user IDs before it reaches the GMGN page.
- Injected followed-user buys, sells, and theses into GMGN's tracker alongside native rows while preserving native-row deduplication and virtual-list positioning.
- Added a subtle followed-user highlight, star marker, event-specific buy/sell/thesis icons, and position-action badges in both compact and table tracker layouts.
- Routed FOMO's `430`/`431` unauthorized responses through the existing token-refresh path instead of treating them as generic HTTP failures.
- Added API-contract, filtering, normalization, sell-rendering, and real-browser visual regression coverage.

## 0.47.3 - 2026-09-03

- Scoped click suppression to the clicked watched card so moving directly to another watched card shows its tooltip normally.
- Kept suppression across same-card DOM replacement while allowing normal re-hover after pointer movement.
- Dismissed active developer tooltips on scroll, window blur, hidden-tab transitions, and active-card removal.
- Added broader regression and real-browser lifecycle coverage for card changes, replacement, scrolling, blur, visibility, and removal.

## 0.47.2 - 2026-09-03

- Fixed the developer-performance hover card remaining attached to the cursor after clicking a watched GMGN token card or chart.
- Dismissed the tooltip before click interactions and suppressed it until the pointer leaves the watched card.
- Added stale-card detection so GMGN DOM replacements cannot strand the tooltip onscreen.

## 0.47.1 - 2026-09-02

- Fixed overlapping wallet-tracker rows after GMGN changed its virtual list to position rows with CSS transforms.
- Preserved GMGN's native row transform and applied extension feed offsets with the independent CSS `translate` property.
- Measured row positions from rendered geometry so both transform-positioned and top-positioned tracker layouts remain supported.

## 0.47.0 - 2026-09-02

Based on better gmgn v0.46.27.

- Converted the extension UI, notifications, comments, documentation, scripts, workflows, and tests to English.
- Changed FOMO and DeBot narrative translation to translate non-English text into English using the browser-local Translation API, retaining the original text.
- Removed desktop installer and companion-update integration, automatic update checks, update alarms, and popup update controls.
- Changed release output to a versioned ZIP plus SHA-256 checksum.
- Replaced upstream deployment and release-note synchronization material with repository-local ZIP release documentation.
- Kept unrelated GMGN, DeBot, FOMO, Pump, 985monitor, alerting, filtering, and display behavior intact.
