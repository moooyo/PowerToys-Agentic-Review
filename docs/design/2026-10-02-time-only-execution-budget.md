# Native task execution policy, 2026-10-02

The user replaced token and analysis-round limits with one hard execution
allowance of two hours. This policy supersedes item 8 of the
[Review Console capability decisions](2026-10-01-review-console-capability-gaps.md).

## Execution and recovery

The fixed allowance is 7,200,000 milliseconds of cumulative active execution.
Worker preparation counts. Queued and paused time do not count. Every round,
model invocation, and resumed attempt consumes the same remaining allowance.
Reaching the deadline cancels active work and prevents additional model work.
Existing bounded cleanup may finish afterward without renewing execution time;
unconfirmed cleanup retains ownership until confirmation.

New budgets contain the fixed duration and report capacity. Explicit create or
resume requests cannot increase the duration beyond two hours. Smaller requested
durations normalize to the same fixed policy. Deprecated deployment variables
for token, round, and task-duration caps no longer alter execution.

Resuming preserves recorded consumption. Exhausted tasks cannot resume execution
by increasing a budget or creating another attempt. A completed saved report can
still use eligible delivery-only recovery without another Worker or model run.

## Accounting and resource safeguards

Token and analysis-round counters remain available for observation but do not
stop execution. Model usage gaps and compaction retain partial or unknown
accounting. Known totals accumulate without presenting missing usage as complete
zero usage. A valid result can continue without a complete token count; malformed
results, mismatched receipts, and execution or lease failures remain errors.

Report capacity defaults to 64 MiB and can increase independently. Process
memory, process count, output size, and operation timeouts remain resource and
protocol safeguards. Report bytes equal to capacity are allowed; an excess
requires a capacity increase. These safeguards do not reintroduce token or
round quotas.

## Historical compatibility

Old Task and sealed report budgets remain readable with their original shape
and digests. Their token and round values no longer cap active execution. The
effective deadline is two hours even if an old task stored a shorter or longer
duration. Explicit budget revisions normalize to the new shape. Historical
completed reports retain compatibility with their saved duration allowance;
new reports are checked against the fixed two-hour policy.

## Verification

All verification ran on the designated Windows Worker. Shared packages, Server,
Worker, and Dashboard builds and type checks passed, including the final
Dashboard recovery change. Biome passed for all 56 changed TypeScript files.

| Scope | Distinct test files | Passed tests |
| --- | ---: | ---: |
| Contracts | 2 | 118 |
| Domain | 3 | 111 |
| Server | 8 | 303 |
| Worker | 16 | 956 |
| Dashboard | 9 | 150 |
| Total | 38 | 1,638 |

Assertions cover execution beyond historical token and round caps, the two-hour
deadline, preparation time, cumulative recovery, unknown usage, compaction,
receipt completion, preserved historical reports, and delivery-only recovery.
Unchanged report capacity omits a budget revision when resuming, preserving a
legacy completed checkpoint's saved allowance. Imported-task fixtures include
the initialized native Prompt catalog in their exact rollback baseline.

Tests used isolated stores, mocked model transports, and controlled clocks.
Source hashes matched the verified checkout. Failed fixture attempts are retained
separately and are not added to the distinct test totals. No local verification,
paid model execution, actual PR or Issue writes, or production deployment was
performed for this change.
