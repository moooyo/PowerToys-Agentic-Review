# Automated testing and repository side effects

- Automated tests must not write to any repository's pull requests or issues without the user's
  explicit approval for the intended targets, operations, content, and execution scope.
- This includes creating or editing PRs/issues, posting comments or reviews, changing labels,
  assignees or review requests, closing/reopening, and merging. It applies to GitHub APIs, `gh`,
  browser automation, scripts, model subprocesses, and integration/acceptance harnesses alike.
- General permission to implement features, execute commands, run local tests, or use `test-env`
  is not permission for external PR/issue writes. Historical runbook approvals and ownership of a
  test repository are not substitutes for explicit approval of the intended live actions.
- Prefer mocked upstream responses, isolated fixture databases, and read-only live verification.
  Do not silently enable outbound writes to make an automated test pass.
- If live write verification is necessary, first prepare a reviewable description of the exact
  repository, PR/issue, payload, and mutations. Request approval before performing those writes.
  An approval applies only to its stated scope. Existing explicit authorization remains valid
  within that scope; new targets, operations, content, or reruns outside it require new approval.

These rules record the user's explicit instruction. They do not prohibit changes to isolated
synthetic test data that do not mutate any repository's actual PRs or issues.
