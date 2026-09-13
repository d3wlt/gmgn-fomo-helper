# Changelog

Entries describe behavior at that version, not current support. Recent published releases are consolidated below; intermediate development notes remain in `release-notes/`.

## 0.53.20 - 2026-09-13

- Fix ordinary FOMO usernames turning into dots under font/zoom geometry differences. Remove destructive JavaScript prefix fitting; preserve source names and use CSS clamping only for exceptional overflow, retaining full-name hover/focus tooltips.
- Add real-font, zoom, delayed font loading and height-recovery browser regressions without changing native row heights.

## 0.53.19 - 2026-09-13

- Give the FOMO token panel one scrolling content region, remove horizontal holder overflow through reflow, and put full holder names above wrapping badges. Keep tabs, filters, diagnostics, fold/close and all loaded rows reachable.
- Remove EN control; keep UI and local translation target English regardless of legacy saved preferences. Browser-local translations still depend on API/language-pack availability and retain original text.
- Allocate compact FOMO tracker space to full available handles, with two-line wrapping in unchanged 45px table/64.5px card slots. Preserve native GMGN recycler rows/actions; exceptionally long names use two-line truncation and a full-name hover/keyboard tooltip.
- Add isolated production-source Chromium layout/locale/action regressions at narrow and normal widths, with screenshots. No live accounts or trading actions are used.


- Remove special-wallet watch entirely: stars across tracking/wallet/address views, colored highlights, management UI, add-wallet watch preferences and pinned activity. Legacy saved settings are inert; watched developers, callout blocklists, holder rankings and native cross-chain wallet following remain.
- Keep notification history anchored beside its bell and clear history without a confirmation dialog.
- Remove tracker token blocking: red icon, management list, and saved-token filtering. Callout account blocking is unchanged.

- Simplify healthy status to FOMO connected; retain partial-coverage detail on hover and diagnostics. Show red recovery guidance for disconnected/setup states.
- Position the status badge above the native bottom toolbar and update placement on resize.

## 0.53.18 - 2026-09-12

- Remove the redundant followed star from compact FOMO rows to reclaim name space. Format large FOMO values with B/T suffixes, including rounding-boundary promotion.

- Fix fractional CSS translation readback: use the browser-serialized applied shift rather than comparing rounded CSSOM values against unrounded input. This prevents false native slot-index mismatches caused by the extension's own translation.
- Add a failure-before/pass-after actual Chromium precision regression; retain geometry validation, removed-transform detection and diagnostic logging. User-side blinking confirmation remains pending.

## 0.53.17 - 2026-09-12

- Diagnostic build: add opt-in tracker lifecycle, validation-reason, visible-card and outer/native scroll measurements. Lifecycle transitions bypass the five-second render sampler; scroll samples are limited to four per second.
- Preserve privacy allowlists, 500-entry/24-hour retention and existing tracker behaviour. This build diagnoses blinking; it does not claim to fix it.

## 0.53.16 - 2026-09-12

- Removed the separate 40-card FOMO render cap, retaining the passive source's bounded history; made native dedup independent of recycled visible rows.
- Added identity-based same-second scroll anchors, logical scroll bounds after tail eviction, and fractional-height/late-thesis layout handling. Tracker metadata now uses committed React ancestry, including native liquidity-add/remove rows rather than borrowing a neighbouring trade. Verified locally and in both live layouts.
- Restore native recycler parentage before card/list layout switches, preventing React `removeChild` crashes during native unmounts.
- Position-surge toasts now dismiss after five seconds even while hovered and omit the trailing token price. Cost/5m metrics, token action and notification history remain.
- Moved the FOMO/holder-count launcher to the end of the token-information header and notification history to the end of GMGN's main navigation; removed floating launchers.
- Added browser coverage for bursts, idle scrolling, source eviction, dedup, toast lifetime, launcher placement, header remounts and narrow viewports.

## 0.53.15 - 2026-09-12

- Renamed the private repository and extension branding to GMGN FOMO Helper; updated package names, documentation and links while preserving the extension key and identity.
- Completely removed J7Tracker authentication/session bridges, collectors, sockets, polling/alarm paths, controls, permissions and J7-provided FOMO/Pump activity.
- Completely removed DeBot scripts, styles, injection, permissions and runtime integration. Removed the integration-only Socket.IO dependency and vendor assets.
- Preserved native GMGN tracking, passive FOMO Following, the single merged scrollbar, token panels, holder counts, native QuickBuy and hybrid holdings alerts.
- Prevented stale metadata on off-screen native overscan rows from disabling the merged tracker while retaining validation of visible rows and full index geometry.
- Added retirement tests proving that old saved credentials, settings and caches cannot restore the removed integrations, including cleanup failures and MV3 restarts.
- Verified the full local suite, GitHub release workflow, live GMGN/FOMO smoke tests and continuous down/up scrolling. Published a 17-runtime-file ZIP with SHA-256 checksum.

## 0.53.14 - 2026-09-12

- Added GMGN hybrid multichain holdings capture and fresh ownership confirmation, including Robinhood alerts with native setting and selected-wallet boundaries preserved.
- Restored native Robinhood QuickBuy on large Fusion pages without weakening account/token guards.
- Moved followed-holder counts from list/tracker cards to the open token page's FOMO button, with exact-chain requests, one-minute success caching and distinct zero/unavailable states.
- Fixed the current FOMO `responseObject.tokens` response parsing.
- Removed manifesto pop-ups/list tab, Flap tax badges and custom BSC RPC controls and permissions.
- Preserved merged tracker rows and reading position through asynchronous virtual-row recycling and new arrivals.
- Corrected a browser fixture teardown race caught by CI. Development versions 0.53.12 and 0.53.13 were not published as GitHub releases; their changes shipped here.

## 0.53.11 - 2026-09-09

Consolidates development changes since published 0.53.1:

- Added off-by-default, local-only diagnostic logging, export and clear controls with bounded retention and strict privacy allowlists.
- Switched direct FOMO Following to passive observation of an existing signed-in native FOMO tab, removing independent feed polling, sockets, keeper tabs and credential restoration.
- Introduced one chronological GMGN/FOMO scroll surface with complete native timestamp-index validation and fractional-row support.
- Added native GMGN QuickBuy on FOMO cards with explicit token/chain identity and stale-context safeguards.
- Added terminal extension-invalidation handling for holder lookups and chain-specific developer performance support for BSC, Robinhood and Solana.
- Fixed native row sizing with recycled Flap markers; made the then-supported Flap helper explicitly opt-in and off by default. Flap was subsequently removed in 0.53.14.

## 0.53.1 - 2026-09-07

- Added bounded token/profile recovery to the then-active direct Following collector, including owner-checked seller trade details.
- Refreshed retained cards when metadata changed without duplicating trades or replaying entry animations.
- Preserved known metadata through sparse updates and showed explicit identity fallbacks rather than invented names/tickers.

## 0.53.0 - 2026-09-07

- Added source-specific direct FOMO Following swaps and social theses with bounded recovery and account-isolated state.
- Kept swap, comment, provider-event, position and transaction identities separate so multiple fills and theses survived deduplication.
- Decoupled recent activity rendering from the heavy scanner and historical continuity gaps, with explicit incomplete-coverage warnings.
- This release used bounded polling; passive native-tab observation replaced it in the changes consolidated into 0.53.11.

## 0.52.0 - 2026-09-07

- Rendered normalized J7 FOMO/Pump pushes independently of the heavy scanner and merged same-session arrivals into history.
- Added bounded account-isolated session-cache recovery, adaptive disconnected recovery and a supported authenticated socket-history keepalive.
- Added local numeric latency diagnostics and required Chrome 116 or newer. J7Tracker was subsequently removed in 0.53.15.

## 0.51.0 - 2026-09-06

- Replaced the optional 985monitor feed connector with J7Tracker account filtering.
- Added a browser-local J7Tracker session bridge, verified tracked-account state, bounded Socket.IO social-history catch-up, and account-isolated live FOMO/Pump events.
- Injected J7Tracker FOMO buys, sells, and narratives plus Pump.fun callouts and replies into GMGN and DeBot tracking feeds.
- Added explicit J7 source labels, callout/reply presentation, session-expiry guidance, controlled data-contract tests, and real MV3 session-bridge coverage.
- Removed 985monitor host access and the old remote marked-holdings dependency; legacy marked-wallet lookups continue through GMGN's signed-in same-site API.

## 0.50.1 - 2026-09-06

- Fixed FOMO-injected GMGN wallet-tracker timestamps so table rows advance every second and continue through minute, hour, and day labels instead of freezing at their initial age.
- Added a real-browser regression covering the live timestamp update.
- Made the portable release builder enforce the same release-note sections as GitHub Actions.

## 0.50.0 - 2026-09-05

- Added explicit FOMO source, freshness, partial coverage, and unknown-following status.
- Carried fallback completeness through both cache layers.
- Added bounded followed-feed catch-up with stable event deduplication and coverage-gap reporting.
- Added Following-only Holders/Trades views, recoverable errors, and allowlisted diagnostics on GMGN and DeBot.
- Added browser fixture regressions, behavioral data tests, a portable ZIP builder, and version-derived release validation.

## 0.49.0 - 2026-09-03

- Restricted the watched-developer tooltip to the compact `M` / `L` / rate / `ATH` badge instead of the entire GMGN card.
- Replaced the token holder-count badge on supported chains with the number of FOMO users you follow who currently hold that token.
- Highlighted followed users in the FOMO Holders tab and displayed their `userHandle` without `@` instead of their display nickname.
- Added a per-token trade-history fallback so the FOMO Trades tab can reconstruct buys and sells from top-holder trade details when `/feed/token` returns no activity.
- Changed Flap tax links from Chinese to explicit English.
- Verified the reported Robinhood token against live FOMO data: its top-holder trade histories contained both buys and sells even though its token feed was empty.
- Prevented slow FOMO responses from repainting a different account, token, or tab, and invalidated account-bound caches without disrupting same-account token refreshes.
- Coalesced concurrent trade-detail fallbacks, backed off followed-holder retries, and avoided caching transiently empty/partial trade histories as complete results.

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
