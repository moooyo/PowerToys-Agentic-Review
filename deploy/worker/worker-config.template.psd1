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

    # Data root and execution directories
    WORKER_DATA_DIR = 'D:\AgenticReview\Data'
    WORKER_GIT_SHARED_ROOT_DIRECTORY = 'D:\AgenticReview\Data\Repositories'
    WORKER_WORKSPACE_ROOT_DIRECTORY = 'D:\AgenticReview\Data\Workspaces'
    WORKER_EXECUTION_TEMP_DIRECTORY = 'D:\AgenticReview\Data\Temp'
    # Dedicated persistent CODEX_HOME; provision config.toml and supported authentication here.
    # It must be a canonical directory disjoint from workspaces, temp, Git state, and binaries.
    # The Worker loads only allowed model/provider/auth settings and never copies auth into tasks.
    WORKER_EXECUTION_PROFILE_DIRECTORY = 'D:\AgenticReview\Data\Profile'

    # Trusted pinned binaries (all required when execution is enabled)
    WORKER_TRUSTED_EXECUTABLE_ROOT = 'D:\AgenticReview\Trusted'
    WORKER_PROCESS_HOST_PATH = 'D:\AgenticReview\Trusted\AgenticReview.ProcessHost.exe'
    WORKER_CODEX_EXECUTABLE_PATH = 'D:\AgenticReview\Trusted\codex.exe'
    WORKER_GIT_EXECUTABLE_PATH = 'D:\AgenticReview\Trusted\git.exe'
    WORKER_PROCESS_HOST_SHA256 = '<64-lowercase-hex>'
    WORKER_CODEX_SHA256 = '<64-lowercase-hex>'
    WORKER_GIT_SHA256 = '<64-lowercase-hex>'
    # Replace the illustrative version below with the installed pinned CLI version.
    # Current native compatibility checks use codex-cli 0.145.0.
    WORKER_CODEX_VERSION = 'codex-1.2.3'

    # ProcessHost request and lifecycle timeouts
    WORKER_PROCESS_HOST_REQUEST_TIMEOUT_MS = 15000
    WORKER_PROCESS_HOST_START_TIMEOUT_MS = 30000
    WORKER_PROCESS_HOST_SHUTDOWN_TIMEOUT_MS = 15000

    # Codex/Git hard-stop controls; Codex runs repository commands directly, without recipe settings.
    WORKER_CODEX_MAXIMUM_HARD_TIMEOUT_MS = 3600000
    WORKER_GIT_HARD_TIMEOUT_MS = 600000

    # Per-command resource controls
    WORKER_CODEX_MAX_PROCESSES = 32
    WORKER_CODEX_MAX_MEMORY_BYTES = 8589934592
    WORKER_CODEX_MAX_OUTPUT_BYTES = 8388608
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
    WORKER_EXECUTION_ORPHAN_RETENTION_HOURS = 24
    WORKER_EXECUTION_ORPHAN_SCAN_LIMIT = 100

    # Shared Git cache policy and conservative Worker-side GC controls
    WORKER_GIT_SHARED_CACHE_MAX_BYTES = 68719476736
    WORKER_GIT_SHARED_MINIMUM_FREE_DISK_BYTES = 10737418240
    WORKER_GIT_SHARED_SCAN_ENTRY_LIMIT = 250000
    WORKER_GIT_SHARED_SCAN_TIMEOUT_MS = 30000
    WORKER_GIT_SHARED_GC_MINIMUM_INTERVAL_MINUTES = 60
    WORKER_GIT_SHARED_GC_PRUNE_AGE_HOURS = 168
}
