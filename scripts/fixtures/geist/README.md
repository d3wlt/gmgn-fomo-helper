# Offline host-typography regression font

Geist-Variable.ttf is from the `geist@1.7.2` npm package, `dist/fonts/geist-sans/Geist-Variable.ttf`; its SIL Open Font License is alongside it in LICENSE.txt.

The inspected GMGN host inherits `Geist, sans-serif, "Microsoft YaHei"`, 13px/600 for FOMO names and `font-feature-settings: "tnum"`. This pinned upstream font exercises that family offline; it is not a claim of byte identity with GMGN's `/static/font/Geist/variable.ttf` asset. It is test-only and must not enter the extension package.
