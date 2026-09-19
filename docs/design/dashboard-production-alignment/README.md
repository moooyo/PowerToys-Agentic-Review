# Production Dashboard review

Open the [production capture board](review/index.html) to review the implemented
Dashboard. It contains the final production screenshots, with viewport filters,
search and full-resolution images. These are captures of the working production
bundle and Server using isolated synthetic fixtures.

The [acceptance record](ACCEPTANCE.md) covers all 24 implementation areas, the
verification layers, the 17 corrected findings and the exact evidence limits.

The implementation includes:

- A shared Material workspace for all eleven destinations, with compact navigation,
  contextual filters, responsive layouts and dark appearance.
- Directly visible normalized Codex/Copilot output, reported usage, requested model,
  explicit unrecorded effort, replay, history, search, export and pause/follow.
- Uploaded evidence with verified image/video previews, downloads and clear
  unavailable states, without unuploaded recording placeholders.
- Real source, report, comment, webhook, repository, Worker and account workflows,
  including permissions, conflicts, retained drafts and uncertain-result recovery.

The final production source manifest is
`a9a0dfdc3be9542bdec73e8cfb2dddf75dc2c24f96ccfa94413f736db816b492`,
based on published main `0909d354c0ab813e5e9fe8a0d0e121bca0a3fbb8`.
Implementation is on `codex/dashboard-m3-production`.

The separate accepted local prototype remains in
`docs/design/dashboard-m3-redesign`; its source and historical design captures are
preserved outside the production source submission. The capture board above is
documentation, not an interactive substitute for the production application.
