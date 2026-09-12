# Release documentation

For every release, update **both** `CHANGELOG.md` and `release-notes/vX.Y.Z.md` before tagging. A GitHub release body does not replace the repository changelog. Keep historical entries intact and describe retired features in the past tense.

Use `# GMGN FOMO Helper vX.Y.Z` for new release-note titles, followed by Highlights, Installation, Usage, Updating, and Security and privacy sections. Builders also accept the historical `# better gmgn vX.Y.Z` title so old notes remain valid.

Keep the manifest version, README version/build example, package identity, popup feature-guide anchor, current documentation and download links consistent. Run `npm run verify` and the portable builder before tagging. The documentation checker requires a current-version changelog entry.

Tag pushes run verification before publishing the runtime ZIP and SHA-256 checksum. For a documentation-only correction after publication, push a normal commit without moving the published tag or silently replacing release assets.
