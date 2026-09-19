# E2E evidence publication

E2E reports retain feature and assertion coverage in `result.context.e2e`. Each media
artifact belongs to the report's task, current or explicitly adopted attempt,
subject, pinned HEAD, and feature. Assertion evidence IDs are resolved through
the report's Worker observations; they are not treated as artifact IDs.
The server reads the bytes from its evidence store and verifies metadata, SHA-256,
length, media type, and container signature before uploading them.

Every passed feature requires image or video evidence and an observed assertion.
Missing evidence is visible as blocked evidence publication. This never rewrites
the immutable test outcome or reruns the desktop task.

## Upload and comment stages

The upload transport uses the same upload-only protocol as GitHub CLI's attachment
implementation:

1. Verify the configured publisher user ID and the exact repository's numeric ID
   and write permission.
2. Send the binary content to `https://uploads.github.com/user-attachments/assets`
   with `name`, `content_type`, and `repository_id` query parameters.
3. Persist the successful attachment URL in the SQLite upload receipt.
4. Render only these trusted URLs into the independent E2E comment. Images use
   Markdown image syntax. A video URL occupies its own paragraph so GitHub renders
   an inline player.

The comment publisher updates its stored comment ID and marker. It does not use
`gh pr comment --edit-last`. A successful media upload is reused if the comment
must be retried, or if the server restarts before delivering the comment.

Transport source references:

- [GitHub CLI upload implementation](https://github.com/cli/cli/blob/trunk/internal/attachments/client.go)
- [GitHub CLI image and video rendering](https://github.com/cli/cli/blob/trunk/internal/attachments/userasset.go)

## Configuration and limits

The uploader reuses the protected server-side `INVESTIGATION_GITHUB_TOKEN` and
`INVESTIGATION_GITHUB_USER_ID`. Credentials never enter the model prompt,
workspace, artifact metadata, or public error messages. Uploads remain gated by
`INVESTIGATION_ENABLE_EXTERNAL_WRITES` and the repository's E2E admission policy.

| Variable | Default | Meaning |
| --- | --- | --- |
| `INVESTIGATION_MEDIA_UPLOADS_ENABLED` | `true` | Enable media publication when external writes are enabled. |
| `INVESTIGATION_MEDIA_UPLOAD_TIMEOUT_MS` | `120000` | Combined preflight and upload timeout, at most `600000` milliseconds. |

PNG screenshots and MP4, WebM, and MOV videos are accepted. GitHub's attachment
uploader permits images up to 10 MiB and videos up to 100 MiB, subject to the
account's actual limit. The investigation artifact transport currently has a
lower 32 MiB per-artifact limit, so recordings must fit that limit. The Dashboard
uses authenticated artifact requests and verifies the bytes before creating a
local image or video preview. Playback depends on the browser's codec support;
downloading remains available.

## Recovery semantics

Each upload has a durable request digest and claim. A known rejected request can
be retried only when its receipt identifies it as retryable. An upload with a lost
response, invalid success receipt, server error, or abandoned dispatched claim is
`unknown`. It is not uploaded again automatically: there is no reliable attachment
lookup endpoint that can prove the first request had no effect.

The E2E comment explains pending, blocked, and unknown evidence delivery
independently from the test result. Successfully uploaded assets remain available
even when another asset fails. Local report contents and hashes remain unchanged.

The production server exposes the authenticated, repository-scoped read endpoint
`GET /api/reports/:id/media-publication`. It returns the aggregate publication state
and individual upload receipts without queuing uploads. An explicit Sync of the
E2E comment can retry known retryable media failures while retaining successful
URLs; it never starts another test task.
