CREATE INDEX ix_jobs_dashboard_created
  ON jobs (created_at DESC, id);

CREATE INDEX ix_jobs_dashboard_status_created
  ON jobs (status, created_at DESC, id);

CREATE INDEX ix_jobs_dashboard_phase_created
  ON jobs (current_step, created_at DESC, id);

DROP INDEX ix_jobs_work_item_created;
CREATE INDEX ix_jobs_work_item_created
  ON jobs (work_item_id, created_at DESC, id DESC);

CREATE INDEX ix_jobs_work_item_reviewed
  ON jobs (work_item_id, completed_at DESC, id DESC)
  WHERE status = 'succeeded';

CREATE INDEX ix_work_items_dashboard_updated
  ON work_items (updated_at DESC, id);

DROP INDEX ix_github_events_work_item_occurred;
CREATE INDEX ix_github_events_work_item_occurred
  ON github_events (work_item_id, occurred_at DESC, created_at DESC, id DESC);

DROP INDEX ix_authorization_decisions_work_item_evaluated;
CREATE INDEX ix_authorization_decisions_work_item_evaluated
  ON authorization_decisions (work_item_id, evaluated_at DESC, created_at DESC, id DESC);

CREATE INDEX ix_request_epochs_active_latest
  ON request_epochs (work_item_id, ordinal DESC, id DESC)
  WHERE status = 'active';
