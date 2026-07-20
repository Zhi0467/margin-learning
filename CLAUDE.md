# CLAUDE.md

Project-specific rules for Margin. See the README for architecture and usage.

## Build and release flow

One codebase, two app flavors, built by `native/build.sh`:

- `npm run build:dev` → `Margin Dev.app`. This is the only bundle kept locally
  for daily use. It loads backend, UI, and skill files live from this checkout
  (the checkout path and Node executable are recorded in its Info.plist at
  build time), so JS changes apply on the next app restart. Rebuild it only
  after changing `native/MarginApp.m`, moving the checkout, or switching Node.
- `npm run package` → `Margin.app` and `dist/Margin-<version>-macos-arm64.zip`.
  These are self-contained release artifacts built solely to smoke-test
  exactly what users download. They are frozen snapshots of the source at
  build time: never launch or distribute an existing `Margin.app` or `dist/`
  zip — run `npm run package` fresh first, and delete both when done.
  `package.sh` prunes older zips from `dist/` so it only ever holds the
  current version's artifacts.

Published releases never come from a local machine. Pushing a `v*` tag
triggers `.github/workflows/release.yml`, which rebuilds the package on a
clean runner, verifies it, and publishes the GitHub release with its
`SHA256SUMS`. Local `dist/` output is pre-flight testing only.

Before tagging a release: the version in `package.json`, `native/Info.plist`,
and the README download filename must agree with the tag; the CHANGELOG must
have a matching dated section (no `Unreleased` heading left behind); and
`npm test` must pass.
