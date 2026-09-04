# Windows Worker Deployment

The Worker runs only on Windows as two native SCM services:

- `AgenticReview.Worker.Executor`
- `AgenticReview.Worker.Control`, which depends on Executor

The clean installer is `native/service-host/cmd/workerinstaller`. It accepts one signed Worker
package plus one local install-input JSON file. No Worker client certificate, CNG key, receipt,
journal, upgrade, migration, fallback, repair, or rollback format exists.

See `split/README.md` for the package and install commands.
