-- Extend M14 admission without rewriting immutable plans, results, or previous migration bytes.
-- Every original identity, authorization, readiness, and consecutive-activation guard is retained.
DROP TRIGGER tr_review_run_job_links_consistency;

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
      -- Extensions are derived from the immutable request. No extra or missing labels are allowed.
      AND json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels') IS 'object'
      AND CASE WHEN EXISTS (
        SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
        WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
      ) THEN (
        request.workflow_kind = 'issue_validation'
        AND json_extract(run.plan_json, '$.workItem.kind') IS 'issue'
        AND json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.issueReproduction') IS '1'
        AND json_type(job.execution_json, '$.validation.reproduction') IS 'object'
        AND json_extract(job.execution_json, '$.validation.reproduction') IS json_extract(run.plan_json, '$.reproduction')
        AND NOT EXISTS (
          SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
          WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
            AND (json_extract(reproduction_case.value, '$.profileVersionId') IS NOT request.profile_version_id
              OR json_extract(reproduction_case.value, '$.profileConfigSha256') IS NOT json_extract(request.request_json, '$.profileVersion.configSha256')
              OR json_extract(reproduction_case.value, '$.target') IS NOT request.target)
        )
      ) ELSE (
        json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.issueReproduction') IS NULL
        AND json_type(job.execution_json, '$.validation.reproduction') IS NULL
      ) END
      AND CASE WHEN EXISTS (
        SELECT 1 FROM json_each(request.request_json, '$.profileVersion.config.test') AS test_step
        WHERE json_type(test_step.value, '$.probeOutput') IS 'object'
      ) THEN json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.structuredProbeOutput') IS '1'
      ELSE json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.structuredProbeOutput') IS NULL END
      AND CASE WHEN (
        EXISTS (
          SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
          WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
            AND json_extract(reproduction_case.value, '$.target') != 'headless'
        ) OR (
          json_extract(request.request_json, '$.profileVersion.config.ui.target') IS 'web'
          AND json_extract(request.request_json, '$.profileVersion.config.ui.evidence.trace') IS 'off'
        )
      ) THEN json_extract(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.uiAssertionObservation') IS '1'
      ELSE json_type(job.execution_json, '$.executionPolicy.requiredCapabilityLabels.uiAssertionObservation') IS NULL END
      AND (SELECT COUNT(*) FROM json_each(job.execution_json, '$.executionPolicy.requiredCapabilityLabels')) = 2
        + EXISTS (
          SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
          WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
        )
        + EXISTS (
          SELECT 1 FROM json_each(request.request_json, '$.profileVersion.config.test') AS test_step
          WHERE json_type(test_step.value, '$.probeOutput') IS 'object'
        )
        + (EXISTS (
          SELECT 1 FROM json_each(run.plan_json, '$.reproduction.binding.cases') AS reproduction_case
          WHERE json_extract(reproduction_case.value, '$.requestId') IS request.request_id
            AND json_extract(reproduction_case.value, '$.target') != 'headless'
        ) OR (
          json_extract(request.request_json, '$.profileVersion.config.ui.target') IS 'web'
          AND json_extract(request.request_json, '$.profileVersion.config.ui.evidence.trace') IS 'off'
        ))
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

