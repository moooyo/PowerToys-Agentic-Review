@{
    # Required
    WORKER_SERVER_URL = 'https://review.example.com'

    # Optional runtime identity and behavior
    WORKER_DISPLAY_NAME = 'worker-win-01'
    WORKER_VERSION = '0.1.0'
    WORKER_PROTOCOL_VERSION = '1.0'
    WORKER_MAX_SLOTS = 1
    WORKER_LOG_LEVEL = 'info'
    WORKER_LABELS_JSON = '{"site":"cn-sh","tier":"prod"}'
    WORKER_CLAIM_WAIT_SECONDS = 30
    WORKER_REGISTRATION_RETRY_SECONDS = 10
    WORKER_IDLE_DELAY_MILLISECONDS = 1000
    WORKER_HEARTBEAT_SECONDS = 20
    WORKER_HEARTBEAT_SAFETY_MARGIN_SECONDS = 20
    WORKER_SHUTDOWN_GRACE_SECONDS = 90
    WORKER_REQUEST_TIMEOUT_SECONDS = 30

    # HTTP/TLS
    WORKER_ALLOW_INSECURE_HTTP = 'false'
    # Optional: when private PKI is required by WORKER_SERVER_URL.
    # WORKER_TLS_CA_PATH = 'D:\AgenticReview\Certs\review-ca.pem'
    # Optional: override TLS server name for certificate validation.
    # WORKER_TLS_SERVER_NAME = 'review.example.com'

    # Trusted execution mode (must be true in production)
    WORKER_EXECUTION_ENABLED = 'true'
    # Model-free validation can set this to false and omit the CLI settings below.
    WORKER_MODEL_EXECUTION_ENABLED = 'true'

    # Profile validation uses the approved command registry, never PATH lookup.
    # Headless defaults to WORKER_EXECUTION_ENABLED when this setting is omitted.
    WORKER_VALIDATION_HEADLESS_ENABLED = 'true'
    WORKER_VALIDATION_CLEANUP_TIMEOUT_MS = 30000 # Allowed: 1000..300000 milliseconds, including final source observation.
    WORKER_VALIDATION_SUMMARY_ENABLED = 'false' # Optional UI/Issue model advice; runner checks remain authoritative.
    WORKER_VALIDATION_SUMMARY_TIMEOUT_MS = 60000 # Allowed: 10000..300000; the remaining job budget also applies.
    WORKER_VALIDATION_WEB_ENABLED = 'false'
    WORKER_VALIDATION_WINDOWS_ENABLED = 'false'
    # Enable Web only after deploying web-driver.mjs and its packaged playwright-core runtime.
    # Install an explicit browser; the Worker does not download one.
    # WORKER_VALIDATION_WEB_ENABLED = 'true'
    # WORKER_VALIDATION_WEB_BROWSER_EXECUTABLE_PATH = 'C:\Program Files\Browser\browser.exe'
    # Enable Windows UI only with WORKER_MAX_SLOTS=1 and an interactive-session readiness probe.
    # Pre-create one private lock directory shared by every Worker node/server using the same
    # Windows account and desktop session. Do not derive it from a node ID or workspace.
    # WORKER_VALIDATION_WINDOWS_ENABLED = 'true'
    # WORKER_VALIDATION_DESKTOP_LOCK_DIRECTORY = 'C:\ProgramData\AgenticReviewDesktopLocks'
    # git/node/powershell/cmd aliases come from trusted startup paths and cannot be overridden.
    # Additional aliases require installed .exe paths outside mutable execution directories.
    # Optional sha256 pins use 64 lowercase hexadecimal characters from the installed binary.
    # WORKER_VALIDATION_COMMANDS_JSON = '[{"name":"dotnet","path":"C:\\Program Files\\dotnet\\dotnet.exe","sha256":"<64-lowercase-hex>"}]'
    # Values are protected file paths, never secret contents. Files must be private to the Worker
    # identity, non-linked, stable UTF-8 without BOM/NUL, and at most 64 KiB / 32767 characters.
    # WORKER_VALIDATION_SECRET_FILES_JSON = '{"test-access-token":"D:\\AgenticReview\\Secrets\\test-token.txt"}'

    # Data root and execution directories
    WORKER_DATA_DIR = 'D:\AgenticReview\Data'
    WORKER_GIT_SHARED_ROOT_DIRECTORY = 'D:\AgenticReview\Data\Repositories'
    WORKER_WORKSPACE_ROOT_DIRECTORY = 'D:\AgenticReview\Data\Workspaces'
    WORKER_EXECUTION_TEMP_DIRECTORY = 'D:\AgenticReview\Data\Temp'
    # Trusted pinned infrastructure binaries (required when execution is enabled)
    WORKER_TRUSTED_EXECUTABLE_ROOT = 'D:\AgenticReview\Trusted'
    WORKER_PROCESS_HOST_PATH = 'D:\AgenticReview\Trusted\AgenticReview.ProcessHost.exe'
    WORKER_GIT_EXECUTABLE_PATH = 'D:\AgenticReview\Trusted\git.exe'
    WORKER_PROCESS_HOST_SHA256 = '<64-lowercase-hex>'
    WORKER_GIT_SHA256 = '<64-lowercase-hex>'

    # CLI-owned model execution: only engine and executable are required for model-enabled startup.
    # The CLI may be installed outside the trusted infrastructure root. Windows WinGet application
    # links are resolved to the installed target. Startup detects --version within 20 seconds / 64 KiB.
    # Log in with the selected CLI under the Worker account and the same optional CLI home.
    # The Worker never reads or copies CLI authentication/provider files.
    WORKER_CLI_ENGINE = 'codex' # Allowed: codex, copilot.
    WORKER_CLI_EXECUTABLE_PATH = 'C:\Program Files\Codex\codex.exe'
    # Optional persistent CLI home, outside disposable workspaces and temporary roots.
    # WORKER_CLI_HOME = 'D:\AgenticReview\CliHome'
    # Optional model selection handled by the CLI.
    # WORKER_CLI_MODEL = '<model-name>'
    # Optional installed CLI binary pin; the CLI version is always detected, never declared here.
    # WORKER_CLI_SHA256 = '<64-lowercase-hex>'

    # ProcessHost request and lifecycle timeouts
    WORKER_PROCESS_HOST_REQUEST_TIMEOUT_MS = 15000
    WORKER_PROCESS_HOST_START_TIMEOUT_MS = 30000
    WORKER_PROCESS_HOST_SHUTDOWN_TIMEOUT_MS = 15000

    # Model/Git hard-stop controls; the CLI runs repository commands without recipe settings.
    WORKER_MODEL_MAXIMUM_HARD_TIMEOUT_MS = 3600000
    WORKER_GIT_HARD_TIMEOUT_MS = 600000

    # Per-command resource controls
    WORKER_MODEL_MAX_PROCESSES = 32
    WORKER_MODEL_MAX_MEMORY_BYTES = 8589934592
    WORKER_MODEL_MAX_OUTPUT_BYTES = 8388608
    WORKER_GIT_MAX_PROCESSES = 8
    WORKER_GIT_MAX_MEMORY_BYTES = 2147483648
    WORKER_GIT_MAX_OUTPUT_BYTES = 4194304

    # Aggregate resource budgets across all slots
    WORKER_EXECUTION_TOTAL_MAX_PROCESSES = 64
    WORKER_EXECUTION_TOTAL_MAX_MEMORY_BYTES = 17179869184
    WORKER_EXECUTION_TOTAL_MAX_OUTPUT_BYTES = 67108864

    # Workspace disk safety controls
    WORKER_EXECUTION_PER_ATTEMPT_DISK_BYTES = 17179869184
    WORKER_EXECUTION_TOTAL_WORKSPACE_DISK_BYTES = 34359738368
    WORKER_EXECUTION_MINIMUM_FREE_DISK_BYTES = 10737418240
    # Workspace accounting bounds; timeout includes queue waits and all snapshot retries.
    # Allowed ranges: 100..300000 milliseconds and 1..1000000 accounting entries.
    WORKER_EXECUTION_DISK_SCAN_TIMEOUT_MS = 30000
    WORKER_EXECUTION_DISK_SCAN_ENTRY_LIMIT = 100000
    WORKER_EXECUTION_ORPHAN_SCAN_LIMIT = 100

    # Shared Git cache policy and conservative Worker-side GC controls
    WORKER_GIT_SHARED_CACHE_MAX_BYTES = 68719476736
    WORKER_GIT_SHARED_MINIMUM_FREE_DISK_BYTES = 10737418240
    WORKER_GIT_SHARED_SCAN_ENTRY_LIMIT = 250000
    WORKER_GIT_SHARED_SCAN_TIMEOUT_MS = 30000
    WORKER_GIT_SHARED_GC_MINIMUM_INTERVAL_MINUTES = 60
    WORKER_GIT_SHARED_GC_PRUNE_AGE_HOURS = 168
}
