# PR finding location validation

PR finding locations use the immutable head revision named by the task. The Worker verifies
locations before accepting a completed PR model result. This is a model-result business rule;
it does not add an execution-admission protocol, provider registry, or inline GitHub comments.

The comparison is the unique merge base of the frozen base and head commits through the frozen
head commit. Workspace preparation retains the merge-base observation. Multiple merge bases are
reported as unverifiable rather than selecting an arbitrary comparison.

A finding must name an exact, case-sensitive repository-relative path present in that PR diff.
Its head object must be an ordinary UTF-8 text file. The full `line..endLine` range must exist in
that head blob, and it must intersect a new-side text hunk with three lines of surrounding
context. Unchanged context lines are valid anchors; findings are not limited to added lines.
A source location outside all such hunks is not a PR location merely because the file exists.

Renames with text changes use the new path and the old/new blob comparison. A pure rename or
mode-only change has no text hunk. A fully deleted file has no head-side location; a deletion
within a surviving file can still be anchored to surrounding head-side context. Binary files,
symlinks, submodules, empty files, missing paths, and out-of-range lines cannot supply a valid
ordinary head text location. The current finding contract has no old-side coordinate.

Validation reads fixed Git objects, never mutable worktree files or the current `HEAD` ref.
Replacement refs, external diff drivers and text conversion are disabled; pathspecs are literal,
rename detection is bounded, and the text diff uses the Myers algorithm with fixed context.
The existing Git runner retains process-tree supervision, cancellation and capture limits.
One disk monitor covers the complete fixed-object read sequence instead of rescanning per command.
Each response is limited to 1 MiB, aggregate responses to 8 MiB, and the validation operation has
a 30-second cancellation budget. Git warnings, truncated or malformed output, unsupported text
encoding, ambiguous comparisons, and exceeded limits are not partial verification successes.

An invalid location fails the model branch with `FINDING_LOCATION_INVALID`. Missing validation
support or incomplete verification uses `FINDING_LOCATION_UNVERIFIED`. The Worker does not silently
drop offending findings or turn the remaining output into a successful review. Finding-free PR
results and Issue triage do not require a location read. Cancellation and deferred workspace cleanup
retain their existing behavior, and deterministic Profile check results remain separate from a
failed model branch.

This rule establishes a real frozen-source location and its relation to the PR diff. It does not
establish that the model's reported defect is correct; finding adjudication remains a separate
reviewer workflow. Existing source-state observation still records model edits independently.
