# ADR 0028: Simple Windows Worker Package and Clean Installer

## Status

Accepted on 2026-09-04.

## Context

No Worker package or installer has been published. The Windows machine and local administrators are
trusted, while package authenticity must still be established before installation. The earlier
release-profile, node-specific package, receipt, retained-evidence, and transaction designs exceed
the selected threat model.

## Decision

1. The only package manifest is canonical JSON with `releaseId`, `architecture`, and a list of
   `relativePath`, `size`, and `sha256` file records.
2. One raw Ed25519 signature covers the exact manifest bytes. The installer public key is compiled
   into the release build; the private key remains external.
3. Package verification, architecture selection, required-file checks, and every file size/hash
   check complete before the first installation write.
4. Local install input contains only `serverOrigin`, `workerNodeId`, and the Worker Token. It is not
   part of the package.
5. Schema 4 is modified in place. Control stores only its role, Worker node ID, and Server origin;
   Executor stores only its role and Worker node ID. All paths, identities, environment values, and
   limits are fixed code-derived values.
6. HTTPS uses the Windows system trust store. No Worker client certificate or custom runtime CA
   bundle is required.
7. The installer accepts only a clean host, creates fixed roots and ACLs, writes the two role configs
   and Control-only Token file, creates two disabled restricted virtual-account services, changes
   them to manual start, starts Executor then Control, and finally selects automatic start.
8. On a post-mutation failure, the installer attempts to stop and disable created services. It does
   not delete files or services automatically and does not authorize a normal rerun over residue.

## Removed designs

The following unpublished mechanisms are deleted rather than migrated:

- compiled release profiles and release receipts;
- node-specific outer packages and trust envelopes;
- staged/destination evidence and retained filesystem handles;
- per-file runtime Authenticode admission;
- installer transactions, journals, rollback generations, repair, resume, and fallback parsing; and
- separate Token provisioning helpers.

## Consequences

- The release pipeline is `workerpackage -> workerinstaller`.
- A real release still needs an external Ed25519 private key and a corresponding public key compiled
  into the installer.
- Installation residue requires explicit administrator cleanup.
- No Linux Worker or test environment is required; Worker verification targets Windows only.
