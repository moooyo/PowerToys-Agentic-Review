# Built-in account verification

Verified source: `snapshot-002`, based on Git commit `21c4a021a2357d96b65ee2f78812a3e865b40626` plus the captured working-tree changes.
Source archive SHA-256: `1ae264268c0f163fc0cad4395f85158514ea7aba86814799ae790841d304fdf6`.
The [full manifest](source-manifest.sha256) records 1237 files; [source metadata](source-snapshot.json) names all 21 new files.

| Package | Passed files | Passed tests | Skipped tests | Failed tests | Duration |
| --- | ---: | ---: | ---: | ---: | ---: |
| contracts | 42 | 1666 | 0 | 0 | 12.65s |
| dashboard | 127 | 3735 | 0 | 0 | 47.07s |
| server | 172 | 6002 | 1 | 0 | 570.65s |

The three affected full suites passed 11403 tests with 1 Windows-only configuration test skipped on Linux and zero failures. The exact root `pnpm typecheck` and `pnpm build` commands passed across the workspace. All package suites ran serially with one Vitest worker and no file parallelism.

Whole-repository Biome: **passed**, including the existing and newly generated JSON evidence. The production bundle contains none of the five checked development password or seed markers. Vite reports an informational chunk-size advisory.

The [browser record](browser/account-browser-summary.json) covers 12 production flows through real HTTP and scrypt, and 18 DEV sample checks. Login, account administration, password change/reset, session revocation, disabled accounts, last-administrator protection, stale-update review, logout, and mobile forms passed. Production negative cases generated 10 expected HTTP console errors; unexpected console errors and unhandled page errors were zero. DEV had zero API requests and zero console or page errors.

All verification ran on `ssh test-env` in loopback-only network namespaces with isolated synthetic databases. Browser, Server, and Vite processes were closed and the synthetic databases removed. No actual GitHub writes, models, native PowerToys scenarios, or local verification were used. The three shared package dist directories were built remotely and copied to the local preview.

Full logs remain at `/var/tmp/powertoys-builtin-account-auth-20260915-0a8470c5ab3842dc8a5407c579e2a1e6/logs/snapshot-002`. Detailed commands, source hashes, package counts, scope limits, and transfer evidence are in [verification.json](verification.json). The eventual release Git tree should be compared with the preserved source inventory before publication.
