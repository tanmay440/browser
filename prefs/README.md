# Vapor preference bundles

This directory contains declarative preference bundles for Vapor Browser. They
are grouped by the source/component they configure and imported into the Gecko
profile defaults by `npm run ffprefs` during `npm run import`.

- `vapor/`: Round 1 Foundation policy plus the Round 2 Shield defaults. It
  disables telemetry, crash reporting, Mozilla account/Sync UI, Pocket,
  recommendations, sponsored content, and promotional upsells; `shield.yaml`
  adds the user-controlled network blocker switches and disables DNS prefetch.
- `privatefox/` and `fastfox/`: privacy/performance preferences inherited from
  the Vapor base source.
- `zen/`: preferences for the inherited Vapor UI features. The `zen.*` names are
  internal compatibility identifiers and are not browser branding.
