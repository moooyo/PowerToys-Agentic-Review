# Built-in account browser QA

Result: PASS on snapshot-002. All execution used remote test-env loopback-only network namespaces and synthetic accounts.

Production: 12/12 real-HTTP browser flows passed using the actual scrypt password store and two independent ephemeral databases.

- Signed-out state, invalid credentials, and normal login.
- Bootstrap administrator account management without repository or business grants.
- Administrator creates an ordinary account; 390px login and create-account form have no horizontal overflow.
- Ordinary account has no Accounts navigation; direct route is blocked; account-list and account-update API requests return 403.
- Own password change returns 204, revokes all sessions, rejects the old password and trimmed password, and accepts the new password verbatim with Unicode and surrounding spaces.
- Logout returns 204 and removes both the server session and protected dashboard subtree.
- A real concurrent update returns 409, preserves unsaved fields, and requires explicit review of the latest account before a successful retry.
- Administrator password reset and account disabling revoke old sessions. A protected 401 removes previously visible account data from the browser.
- Last enabled administrator cannot be disabled or demoted: both return 409 with the last_admin error and review controls.
- No unhandled browser exceptions, unexpected console errors, or external requests. Expected 401/409 resource console messages are preserved in the detailed log.

Development sample: 18/18 checks passed in one SPA document. Public demo fill, login, own-password change, forced sign-out, old-password rejection, new-password login, and logout completed with 0 API requests and 0 browser errors.

Four screenshots were visually inspected. Browsers, production HTTP server, and Vite were closed; dedicated fixture databases were removed. No source files were changed. No GitHub, pull request, issue, Worker, or model operations were performed. Evidence omits raw cookies, tokens, and passwords.

Files: account-browser-summary.json, production-account-results.json, production-account-summary.md, production-run.log, dev-sample/result.json, dev-sample/run.log, and four screenshots.
