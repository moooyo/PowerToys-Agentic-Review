# Retired Windows attempt journal

Retired on 2026-09-10 following the user decision to deploy one long-lived Worker per independent virtual machine, processing successive tasks.

The dormant protected SQLite journal, dedicated owner thread, POSIX file enforcement and inventory/recovery coordinator have been removed. The existing Worker lifecycle already handles task leases, result reporting, process shutdown and deferred workspace cleanup.

The current architecture and retained operational checks are defined in [One Worker per virtual machine](2026-09-10-single-worker-vm.md). VM isolation is a deployment responsibility; no replacement signing or execution-admission framework is required.

Original design and implementation history remain in the M35 frozen source archives and verification artifacts. Their prior tests do not describe the current implementation. The separately implemented Windows UI ownership recovery and desktop lease remain supported.
