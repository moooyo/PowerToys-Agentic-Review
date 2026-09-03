# ADR 0026: Unreleased Clean-Install-Only Windows Worker

## Status

Accepted on 2026-09-04.

This decision replaces the unpublished installer lifecycle in ADRs 0013, 0015, 0016, 0020, and
0021. ADRs 0015, 0020, and 0021 are withdrawn before publication. ADRs 0013 and 0016 are historical
input only; this decision does not permanently select their WinSW, node-specific package,
destination-evidence, or SCM-policy mechanisms.

## Context

The product has not shipped a Worker installer or an installed-format compatibility promise. The
only supported Worker and installer platform is Windows. The Server runs on Linux and authenticates
each Worker with the per-Worker Bearer Token selected by ADR 0025.

The earlier installer designs modeled split-to-split upgrades, legacy migration, durable rollback,
cross-version journals, and crash recovery before any production installer existed. Those models
added implementation and operational cost without protecting a published installation base. They
are not prerequisites for the first supported installation path.

## Decision

### One current installation format

The first production installer will support only a clean installation of the current split Worker
format. It will not:

- read or interpret a legacy installer record, transaction head, journal, or package profile;
- migrate the legacy single-service Worker;
- upgrade or repair an existing split installation;
- resume a previous installation run;
- roll back to a previous package generation; or
- expose a compatibility or fallback parser.

Existing schema and profile numbers may remain stable identifiers in source, but production code
must accept only the current Bearer Token package and bootstrap profile. Retaining a number does not
retain support for an older format.

### Clean-host admission

An ordinary install starts only when the two fixed split services and every fixed Worker runtime,
trusted-configuration, role-data, wrapper-log, and package destination owned by the installer are
absent. Any existing or partial object makes ordinary installation fail closed before mutation.

The installer does not infer ownership from a familiar path, service display name, file content, or
package identifier. It does not adopt, repair, overwrite, or remove unexplained residue.

### No rollback journal

The clean installer has no transaction journal, action ordinal, active head, predecessor record,
upgrade state, rollback generation, or cross-version store. Services are created only after package
roots and local configuration have been placed and verified, so an incomplete filesystem phase
cannot start Worker code.

The future implementation may create one narrow run marker before its first mutation. The marker:

- identifies only the current installer invocation and the exact fixed objects that invocation
  created;
- grants no authority to resume, upgrade, commit, activate, or adopt an installation;
- is not a per-effect journal and records no old generation;
- is removed after successful installation; and
- may be consumed only by best-effort cleanup for that same failed run.

Ordinary installation never consumes the marker. A later cleanup command may remove only objects
proven to belong to the marked failed run. Residue without a valid marker remains an operator-visible
hard failure and requires explicit manual remediation.

### Required product boundaries

The future clean installer must preserve these product-level properties:

- distinct Control and Executor Windows service identities and Executor-before-Control start order;
- Control-only access to the Worker Bearer Token and no Server credential in Executor;
- authenticated release content before either service is created or started;
- fixed installer-owned runtime and role-data destinations for the selected implementation;
- the fixed Control-only `worker-auth-v1.json` file and direct Bearer Token registration with the
  Linux Server; and
- the local named-pipe service-identity boundary and the zero-execution runtime posture.

The existing split WinSW inputs, outer-package verifier, retained staging handles, destination
evidence, node-specific package fields, and CNG local-authority path are implementation candidates,
not permanent requirements of this ADR. A later simplification may replace or remove them without
creating an upgrade or compatibility obligation, provided the product-level properties above still
hold.

The first installer does not require Worker mutual TLS, a candidate certificate, a Server binding
receipt, an enrollment receipt, an installer receipt, a rollback receipt, or Linux Worker testing.
The plaintext Worker Token is local configuration and never package content.

### Deferred implementation

This ADR does not itself implement filesystem mutation, ACL creation, Windows service creation, local
configuration generation, service start, or same-run cleanup. Those operations require a new
Windows-only installer command and native verification. They must not import or recreate the
withdrawn transaction and store packages.

## Consequences

- The unpublished transaction and store packages are deleted instead of preserved as dormant
  compatibility code.
- A failed or interrupted install may leave inert residue, but no service is allowed to start from
  it. A normal rerun rejects that residue rather than guessing how to recover it.
- The first installer is substantially smaller: verify selected current release inputs, place
  current roots, write local configuration, create the two services, verify them, and start
  Executor then Control.
- Upgrade, migration, repair, and multi-generation rollback require a future product decision made
  after a real installed format exists.
