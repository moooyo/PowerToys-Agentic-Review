# Trusted Configuration

This directory is part of the trusted Agentic Review release. Runtime jobs record content hashes
for the prompt, schema, policy, and recipe versions they use.

Configuration is never loaded from the repository revision being reviewed. Pull request files,
issue content, job artifacts, and model output cannot add or modify prompts, policies, schemas, or
validation recipes.

The initial prompt set supports static pull request review and issue triage. Dynamic validation
recipes remain disabled until their execution and approval boundaries are implemented.
