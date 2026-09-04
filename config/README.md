# Trusted Configuration

This directory is part of the trusted Agentic Review release. Runtime jobs record content hashes
for the prompt, schema, policy, and recipe versions they use.

Configuration is never loaded from the repository revision being reviewed. Pull request files,
issue content, execution output, and model output cannot add or modify prompts, policies, schemas,
or validation recipes.

The pull request prompt supports repository inspection plus trusted build and test execution inside
the disposable worktree. Named validation recipes remain unused in the MVP; Codex executes relevant
repository-local commands directly under the Worker ProcessHost and Job Object limits.
