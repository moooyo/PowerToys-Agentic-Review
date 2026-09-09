CREATE UNIQUE INDEX ux_work_items_review_run_repository ON work_items (id, repository_id);
CREATE UNIQUE INDEX ux_request_epochs_review_run_item ON request_epochs (id, work_item_id);

CREATE TABLE review_runs (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  repository_id TEXT NOT NULL REFERENCES managed_repositories(id) ON DELETE RESTRICT,
  work_item_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision_key TEXT NOT NULL,
  request_epoch_id TEXT NOT NULL,
  activation_id TEXT NOT NULL CHECK (length(activation_id) BETWEEN 1 AND 128),
  creation_intent_digest TEXT CHECK (creation_intent_digest IS NULL OR (
    length(creation_intent_digest) = 64 AND creation_intent_digest NOT GLOB '*[^0-9a-f]*'
  )),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'),
  plan_json TEXT NOT NULL CHECK (
    length(CAST(plan_json AS BLOB)) BETWEEN 1 AND 16777216
    AND json_valid(plan_json) AND json_type(plan_json) = 'object'
    AND json_extract(plan_json, '$.schemaVersion') IS 'ReviewRunExecutionPlanV1'
    AND json_extract(plan_json, '$.repository.id') IS repository_id
    AND json_extract(plan_json, '$.workItemId') IS work_item_id
    AND json_extract(plan_json, '$.revision.revisionKey') IS revision_key
    AND json_extract(plan_json, '$.authorization.requestEpochId') IS request_epoch_id
    AND json_extract(plan_json, '$.activationId') IS activation_id
    AND json_type(plan_json, '$.jobs') IS 'array'
    AND json_array_length(plan_json, '$.jobs') BETWEEN 1 AND 32
  ),
  readiness_json TEXT NOT NULL CHECK (
    length(CAST(readiness_json AS BLOB)) BETWEEN 1 AND 1048576
    AND json_valid(readiness_json) AND json_type(readiness_json) = 'array'
    AND json_array_length(readiness_json) = json_array_length(plan_json, '$.jobs')
  ),
  required_request_blockers_json TEXT NOT NULL CHECK (
    length(CAST(required_request_blockers_json AS BLOB)) BETWEEN 2 AND 1048576
    AND json_valid(required_request_blockers_json) AND json_type(required_request_blockers_json) = 'array'
    AND json_array_length(required_request_blockers_json) <= 4480
  ),
  request_count INTEGER NOT NULL CHECK (request_count = json_array_length(plan_json, '$.jobs')),
  blocked_request_count INTEGER NOT NULL CHECK (blocked_request_count BETWEEN 0 AND request_count),
  required_blocker_count INTEGER NOT NULL CHECK (required_blocker_count = json_array_length(required_request_blockers_json)),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  created_at TEXT NOT NULL,
  UNIQUE (work_item_id, activation_id),
  FOREIGN KEY (work_item_id, repository_id) REFERENCES work_items(id, repository_id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, work_item_id, revision_key) REFERENCES work_item_revisions(id, work_item_id, revision_key) ON DELETE RESTRICT,
  FOREIGN KEY (request_epoch_id, work_item_id) REFERENCES request_epochs(id, work_item_id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX ix_review_runs_repository_history ON review_runs (repository_id, created_at DESC, id DESC);
CREATE INDEX ix_review_runs_work_item_history ON review_runs (repository_id, work_item_id, created_at DESC, id DESC);

CREATE TABLE review_run_requests (
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  workflow_kind TEXT NOT NULL CHECK (workflow_kind IN ('pr_static_build', 'pr_ui', 'issue_triage', 'issue_validation')),
  target TEXT NOT NULL CHECK (target IN ('headless', 'windows_desktop', 'web')),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  profile_version_id TEXT REFERENCES validation_profile_versions(id) ON DELETE RESTRICT,
  prompt_version_id TEXT REFERENCES prompt_versions(id) ON DELETE RESTRICT,
  prompt_envelope_json TEXT CHECK (
    prompt_envelope_json IS NULL OR (
      length(CAST(prompt_envelope_json AS BLOB)) BETWEEN 1 AND 8388608
      AND json_valid(prompt_envelope_json) AND json_type(prompt_envelope_json) = 'object'
    )
  ),
  request_json TEXT NOT NULL CHECK (
    length(CAST(request_json AS BLOB)) BETWEEN 1 AND 16777216
    AND json_valid(request_json) AND json_type(request_json) = 'object'
  ),
  PRIMARY KEY (review_run_id, request_id),
  UNIQUE (review_run_id, profile_version_id),
  CHECK ((prompt_version_id IS NULL) = (prompt_envelope_json IS NULL)),
  CHECK (workflow_kind = 'issue_validation'
    OR (workflow_kind = 'pr_ui' AND target IN ('windows_desktop', 'web'))
    OR (workflow_kind IN ('pr_static_build', 'issue_triage') AND target = 'headless'))
) STRICT;

-- A request can have explicit operator reruns. Infrastructure retries remain run_attempts.
CREATE TABLE review_run_job_links (
  review_run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  activation_number INTEGER NOT NULL CHECK (activation_number BETWEEN 1 AND 9007199254740991),
  job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (review_run_id, request_id, activation_number),
  FOREIGN KEY (review_run_id, request_id) REFERENCES review_run_requests(review_run_id, request_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE review_run_audit (
  id TEXT PRIMARY KEY,
  review_run_id TEXT NOT NULL REFERENCES review_runs(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('planned', 'job_associated')),
  actor_issuer TEXT NOT NULL CHECK (length(actor_issuer) BETWEEN 1 AND 2048 AND instr(actor_issuer, char(0)) = 0),
  actor_subject TEXT NOT NULL CHECK (length(actor_subject) BETWEEN 1 AND 512 AND instr(actor_subject, char(0)) = 0),
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json) AND json_type(detail_json) = 'object' AND length(CAST(detail_json AS BLOB)) <= 16384),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX ix_review_run_audit_history ON review_run_audit (review_run_id, created_at DESC, id DESC);

CREATE TRIGGER tr_review_run_request_consistency BEFORE INSERT ON review_run_requests
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM review_runs AS run, json_each(run.plan_json, '$.jobs') AS planned
    WHERE run.id = NEW.review_run_id
      AND json_extract(planned.value, '$.requestId') IS NEW.request_id
      AND json_extract(planned.value, '$.workflowKind') IS NEW.workflow_kind
      AND json_extract(planned.value, '$.target') IS NEW.target
      AND json_extract(planned.value, '$.required') IS NEW.required
      AND json_extract(planned.value, '$.profileVersion.id') IS NEW.profile_version_id
      AND json_extract(planned.value, '$.prompt.version.id') IS NEW.prompt_version_id
      AND (NEW.prompt_envelope_json IS NULL OR (
        json_extract(NEW.prompt_envelope_json, '$.name') IS json_extract(planned.value, '$.prompt.version.templateId')
        AND json_extract(NEW.prompt_envelope_json, '$.version') IS CAST(json_extract(planned.value, '$.prompt.version.version') AS TEXT)
      ))
      AND json(planned.value) = json(NEW.request_json)
  ) THEN RAISE(ABORT, 'review run request does not match its frozen plan') END;
END;

CREATE TRIGGER tr_review_run_job_links_consistency BEFORE INSERT ON review_run_job_links
BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM review_run_job_links WHERE review_run_id = NEW.review_run_id) >= 4096
    THEN RAISE(ABORT, 'review run job association limit reached') END;
  SELECT CASE WHEN NEW.activation_number != COALESCE((
    SELECT MAX(activation_number) FROM review_run_job_links
    WHERE review_run_id = NEW.review_run_id AND request_id = NEW.request_id
  ), 0) + 1 THEN RAISE(ABORT, 'review run job activations must be consecutive') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM review_runs AS run
    JOIN review_run_requests AS request ON request.review_run_id = run.id
    JOIN jobs AS job ON job.id = NEW.job_id
    JOIN managed_repositories AS repository ON repository.id = run.repository_id
    JOIN work_items AS item ON item.id = run.work_item_id
    JOIN request_epochs AS epoch ON epoch.id = run.request_epoch_id
    JOIN work_item_revisions AS revision ON revision.id = epoch.current_revision_id
    WHERE run.id = NEW.review_run_id AND request.request_id = NEW.request_id
      AND repository.enabled = 1 AND item.state = 'open' AND epoch.status = 'active'
      AND repository.reviewer_github_user_id = json_extract(run.plan_json, '$.authorization.targetGithubUserId')
      AND repository.authorization_policy_json IS NOT NULL
      AND NOT EXISTS (
        SELECT key, value, type FROM json_each(repository.authorization_policy_json)
        EXCEPT SELECT key, value, type FROM json_each(run.plan_json, '$.authorization.policy')
      )
      AND NOT EXISTS (
        SELECT key, value, type FROM json_each(run.plan_json, '$.authorization.policy')
        EXCEPT SELECT key, value, type FROM json_each(repository.authorization_policy_json)
      )
      AND item.current_revision_key = run.revision_key AND revision.revision_key = run.revision_key
      AND job.work_item_id = run.work_item_id AND job.resource_revision = run.revision_key
      AND job.request_epoch_id = run.request_epoch_id
      AND job.status = 'queued' AND job.attempt_count = 0
      AND NOT EXISTS (SELECT 1 FROM run_attempts WHERE job_id = job.id)
      AND epoch.target_github_user_id = json_extract(run.plan_json, '$.authorization.targetGithubUserId')
      AND epoch.ordinal = json_extract(run.plan_json, '$.authorization.sequence')
      AND job.job_kind = CASE WHEN request.workflow_kind IN ('pr_static_build', 'pr_ui') THEN 'pull_request_review' ELSE 'issue_triage' END
      AND json_extract(job.execution_json, '$.repository.githubRepositoryId') IS json_extract(run.plan_json, '$.repository.githubRepositoryId')
      AND json_extract(job.execution_json, '$.repository.fullName') IS json_extract(run.plan_json, '$.repository.fullName')
      AND json_extract(job.execution_json, '$.resource.kind') IS json_extract(run.plan_json, '$.workItem.kind')
      AND json_extract(job.execution_json, '$.resource.githubNodeId') IS json_extract(run.plan_json, '$.workItem.githubNodeId')
      AND json_extract(job.execution_json, '$.resource.number') IS json_extract(run.plan_json, '$.workItem.number')
      AND json_extract(job.execution_json, '$.resource.title') IS json_extract(run.plan_json, '$.workItem.title')
      AND json_extract(job.execution_json, '$.resource.author') IS json_extract(run.plan_json, '$.workItem.author')
      AND json_extract(job.execution_json, '$.resource.canonicalSnapshot') IS json_extract(run.plan_json, '$.workItem')
      AND CASE WHEN json_extract(run.plan_json, '$.workItem.kind') = 'pull_request' THEN (
        json_extract(job.execution_json, '$.resource.baseSha') IS json_extract(run.plan_json, '$.revision.baseSha')
        AND json_extract(job.execution_json, '$.resource.headSha') IS json_extract(run.plan_json, '$.revision.headSha')
        AND json_extract(job.execution_json, '$.resource.isDraft') IS json_extract(run.plan_json, '$.workItem.isDraft')
      ) ELSE json_extract(job.execution_json, '$.resource.revisionDigest') IS run.revision_key END
      AND json_extract(job.execution_json, '$.validation.schemaVersion') IS 'ValidationJobContextV1'
      AND json_extract(job.execution_json, '$.validation.runId') IS run.id
      AND json_extract(job.execution_json, '$.validation.planDigest') IS run.plan_digest
      AND json_extract(job.execution_json, '$.validation.activationId') IS run.activation_id
      AND json_extract(job.execution_json, '$.validation.requestId') IS request.request_id
      AND json_extract(job.execution_json, '$.validation.jobActivation') IS NEW.activation_number
      AND json_extract(job.execution_json, '$.validation.repositoryId') IS run.repository_id
      AND json_extract(job.execution_json, '$.validation.workItemId') IS run.work_item_id
      AND json_extract(job.execution_json, '$.validation.revisionKey') IS run.revision_key
      AND json_extract(job.execution_json, '$.validation.requestEpochId') IS run.request_epoch_id
      AND json_extract(job.execution_json, '$.validation.workflowKind') IS request.workflow_kind
      AND json_extract(job.execution_json, '$.validation.target') IS request.target
      AND json_extract(job.execution_json, '$.validation.required') IS request.required
      AND request.profile_version_id IS NOT NULL AND request.prompt_version_id IS NOT NULL
      AND json_extract(job.execution_json, '$.prompt') IS request.prompt_envelope_json
      AND json_extract(job.execution_json, '$.executionPolicy.hardTimeoutMs') IS json_extract(request.request_json, '$.profileVersion.config.hardTimeoutMs')
      AND json_extract(job.execution_json, '$.executionPolicy.noProgressTimeoutMs') IS json_extract(request.request_json, '$.profileVersion.config.noProgressTimeoutMs')
      AND json_extract(job.execution_json, '$.executionPolicy.allowedRecipeIds') IS '[]'
      AND json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.executionEnvelope') IS '2'
      AND json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.' || CASE request.target
        WHEN 'headless' THEN 'validationHeadless' WHEN 'web' THEN 'validationWeb' ELSE 'validationWindowsDesktop' END) IS '1'
      AND (SELECT COUNT(*) FROM json_each(job.execution_json, '$.executionPolicy.requiredCapabilityLabels')) = 2
      AND json_extract(job.execution_json, '$.validation.profileVersion') IS json_extract(request.request_json, '$.profileVersion')
      AND json_extract(job.execution_json, '$.validation.promptVersion.id') IS request.prompt_version_id
      AND json_extract(job.execution_json, '$.validation.promptVersion.templateId') IS json_extract(request.request_json, '$.prompt.version.templateId')
      AND json_extract(job.execution_json, '$.validation.promptVersion.version') IS json_extract(request.request_json, '$.prompt.version.version')
      AND json_extract(job.execution_json, '$.validation.promptVersion.contentSha256') IS json_extract(request.request_json, '$.prompt.version.contentSha256')
      AND json_extract(job.execution_json, '$.validation.requiredCheckIds') IS json_extract(request.request_json, '$.requiredCheckIds')
      AND json_extract(job.execution_json, '$.validation.testedSourceRevision') IS json_extract(run.plan_json, '$.testedSourceRevision')
      AND json_extract(job.execution_json, '$.validation.testedSourceAuthorization') IS json_extract(run.plan_json, '$.testedSourceAuthorization')
      AND (request.workflow_kind != 'issue_validation' OR (
        json_type(run.plan_json, '$.testedSourceRevision') IS 'object'
        AND json_type(run.plan_json, '$.testedSourceAuthorization') IS 'object'
      ))
      AND NOT EXISTS (
        SELECT 1 FROM json_each(run.readiness_json) AS readiness,
          json_each(readiness.value, '$.reasons') AS reason
        WHERE json_extract(readiness.value, '$.requestId') = request.request_id
          AND json_extract(reason.value, '$.code') NOT IN (
            'unsupported_target', 'missing_capability', 'evidence_delivery_unavailable'
          )
      )
  ) THEN RAISE(ABORT, 'review run job does not match its frozen validation identity') END;
END;

CREATE TRIGGER tr_review_run_linked_job_identity BEFORE UPDATE OF work_item_id, request_epoch_id,
  job_kind, resource_revision, execution_json, execution_digest ON jobs
WHEN EXISTS (SELECT 1 FROM review_run_job_links WHERE job_id = OLD.id)
  AND (NEW.work_item_id IS NOT OLD.work_item_id OR NEW.request_epoch_id IS NOT OLD.request_epoch_id
    OR NEW.job_kind IS NOT OLD.job_kind OR NEW.resource_revision IS NOT OLD.resource_revision
    OR NEW.execution_json IS NOT OLD.execution_json OR NEW.execution_digest IS NOT OLD.execution_digest)
BEGIN
  SELECT RAISE(ABORT, 'associated review run job identity is immutable');
END;

CREATE TRIGGER tr_review_runs_immutable_update BEFORE UPDATE ON review_runs BEGIN SELECT RAISE(ABORT, 'review runs are immutable'); END;
CREATE TRIGGER tr_review_runs_immutable_delete BEFORE DELETE ON review_runs BEGIN SELECT RAISE(ABORT, 'review runs are immutable'); END;
CREATE TRIGGER tr_review_run_requests_immutable_update BEFORE UPDATE ON review_run_requests BEGIN SELECT RAISE(ABORT, 'review run requests are immutable'); END;
CREATE TRIGGER tr_review_run_requests_immutable_delete BEFORE DELETE ON review_run_requests BEGIN SELECT RAISE(ABORT, 'review run requests are immutable'); END;
CREATE TRIGGER tr_review_run_job_links_immutable_update BEFORE UPDATE ON review_run_job_links BEGIN SELECT RAISE(ABORT, 'review run job links are immutable'); END;
CREATE TRIGGER tr_review_run_job_links_immutable_delete BEFORE DELETE ON review_run_job_links BEGIN SELECT RAISE(ABORT, 'review run job links are immutable'); END;
CREATE TRIGGER tr_review_run_audit_immutable_update BEFORE UPDATE ON review_run_audit BEGIN SELECT RAISE(ABORT, 'review run audit is immutable'); END;
CREATE TRIGGER tr_review_run_audit_immutable_delete BEFORE DELETE ON review_run_audit BEGIN SELECT RAISE(ABORT, 'review run audit is immutable'); END;
