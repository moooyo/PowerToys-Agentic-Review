# Pinned Git submodule source preparation

Source-reading investigations and E2E preparation can materialize submodules from
the commits recorded in the parent Git tree. A gitlink is not treated as a missing
regular file, and an unchanged submodule no longer blocks preparation of the whole
repository.

## Acquisition and identity

The Worker reads `.gitmodules` from the exact parent commit using Git's config
parser with includes disabled. It accepts canonical public HTTPS GitHub repository
URLs only. Relative URLs, other protocols or hosts, credentials, query strings,
fragments, unsafe Windows paths, ambiguous declarations and missing pins are
rejected. Optional update, branch and similar settings are not executed.

Each child repository gets its own managed, detached checkout at its recorded
commit. Nested dependencies use the same rules. Acquisition never runs `git
submodule update` or inherits user credentials, hooks or ambient Git configuration.
Dependencies use shallow exact-commit fetches. The default limits are 32 submodules,
four nesting levels and the existing aggregate source-tree entry limit; existing
process and task deadlines still apply. An ancestry cycle is rejected.

The source binding records each mounted path, repository, commit and parent commit.
Child Git control files and tracked source are checked independently. A parent
repository's submodule-ignore setting cannot hide a changed child. Blob reads and
dependency searches use the owning repository's pinned commit, with paths mapped
back into the combined checkout.

## Coverage and mutation boundaries

PR changes to a gitlink retain the parent diff and explicit `Subproject commit`
base/head content. These are commit pointers, not evidence that all child files
were inspected. A mounted directory can supply its pointer through the source
reader; lexical dependency discovery marks that pointer as an unsupported seed.
Complete child files remain available through their mounted paths.

Reports retain dependency provenance supplied by the trusted workspace, separately
from model output. The Worker checkpoints this immutable metadata before analysis,
so finalizing a completed checkpoint after a restart retains the same source map
without preparing the source again. Public source links resolve the longest owning mount to its
dependency repository and pinned commit. A mount-point pointer has no blob link;
invalid provenance cannot fall back to a fabricated parent-repository link.

Ordinary edits and saved patches cannot change submodule topology or child tracked
source. E2E may create ordinary build outputs; cleanup visits verified child
checkouts deepest-first and the parent last, checking identities before and after
each operation. Source binding checks cover every repository.

## Actionable blocking reasons

Submodule acquisition, unsupported configuration, source limits and binding
mismatches have separate controlled diagnostic codes. Blocked GitHub comments use
fixed explanations from the current task and attempt. Raw exception text, URLs,
paths and values are not published. An unresolved prerequisite still requires an
explicit operator resume; deployment does not authorize a new investigation.
