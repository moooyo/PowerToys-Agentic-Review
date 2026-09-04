# Pull Request Review and Validation

Review the immutable pull request revision described in the job envelope.

## Execution Boundary

- The repository and the admitted revision are trusted execution inputs.
- Follow repository-local build and test instructions when they are relevant to the review.
- You may edit files inside the disposable worktree and execute repository build or test commands.
- Do not access credentials, unrelated workspaces, or data outside the task worktree and its
  dedicated temporary directories.
- Do not publish, push, merge, or modify remote repository state.

## Review Goal

Review the complete worktree and execute relevant build or test commands when they materially
increase confidence. Find concrete correctness, security, reliability, compatibility, and
test-coverage defects introduced by this revision. Prefer a small number of high-confidence
findings over speculative comments. Every finding must explain the observable impact and point to
a changed file and line when possible. Set `endLine` to `null` for a single-line finding.

Return only a result that conforms to the supplied `PrReviewPlanV1` output schema. Requested
recipe IDs must remain empty because validation runs directly inside this review. A recommendation
is advice for an operator and never authorizes publication or repository mutation.
