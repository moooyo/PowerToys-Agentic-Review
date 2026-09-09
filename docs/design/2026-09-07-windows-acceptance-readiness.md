# Windows desktop acceptance readiness

Status: read-only preparation, not an accepted Windows UI execution.

PowerToys Settings is a candidate application. The operator has not yet selected it as the first
Windows desktop baseline. No PowerToys checkout, dependency installation, build, GUI launch,
package registration, account change, registry change, or existing-window attachment was performed
for this preparation. Public source reads and local toolchain inventory are the only execution
evidence recorded here. All external PR and issue writes remain prohibited without the exact
approval described in [AGENTS.md](../../AGENTS.md).

## Current decision

Do not launch PowerToys Settings in the operator's current Windows account for this acceptance.
The upstream Debug build has a standalone UI path, but its settings storage still resolves to the
current Windows user's PowerToys data. Replacing `USERPROFILE`, `TEMP`, and `TMP` in a child process
does not establish isolation of that storage. A dedicated test account in an active, unlocked
interactive session, preferably inside a disposable Windows VM, is the appropriate deployment
boundary. This preparation does not provision that environment.

The ordinary Release executable is also unsuitable as a standalone launch command: its no-argument
path forwards to PowerToys through a deep link and exits. The Debug no-argument path creates its own
Settings window and installs a dummy callback for hotkey-conflict handling. This does not isolate
all IPC: startup still listens for the runner's fixed `Local` Settings termination event. These
paths must not be treated as equivalent acceptance targets. See the pinned
[Settings startup source](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/settings-ui/Settings.UI/SettingsXAML/App.xaml.cs#L274-L316)
and [shared event definition](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/common/interop/shared_constants.h#L16).

## Source baseline and smallest build target

The public source inspected on 2026-09-07 was the official `microsoft/PowerToys` tree at
`47f0e4db5af8c399a1a1456005b2e42e0d04293e`. This is a research snapshot, not authorization to replace
the base/head pair of a future PR validation or the explicitly selected commit of an Issue run.

The Settings project is
`src/settings-ui/Settings.UI/PowerToys.Settings.csproj`. It is an unpackaged `WinExe`, with an output
directory under `<checkout>\x64\Debug\WinUI3Apps`. It imports self-contained .NET configuration and
enables the self-contained Windows App SDK. It also references native projects including
`GPOWrapper`, `PowerToys.Interop`, and `ZoomItSettingsInterop`; building it is not a C#-only exercise.
See the pinned [Settings project](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/settings-ui/Settings.UI/PowerToys.Settings.csproj)
and [self-contained properties](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/Common.SelfContained.props#L4-L14).

After the upstream documented solution restore and developer-environment preparation, the
documented single-project build is:

```powershell
msbuild src\settings-ui\Settings.UI\PowerToys.Settings.csproj -p:Platform=x64 -p:Configuration=Debug -m
```

The command comes from the pinned [VS Code development guide](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/doc/devdocs/development/dev-with-vscode.md#L63-L75).
It has not been executed here. A frozen production profile must resolve the intended
MSBuild executable and developer environment explicitly; it cannot assume an interactive terminal's
`PATH`. The upstream [essentials script](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/tools/build/build-essentials.ps1#L65-L74)
additionally builds the runner. A Settings-only profile must
prove its own restored dependency closure and runnable output before omitting that runner step.
The acceptance executable must be the resulting absolute checkout path, not an installed PowerToys
path, app alias, protocol launch, or executable found on `PATH`.

The inspected source targets `net10.0-windows10.0.26100.0`. Its CI selects SDK `10.0.303`, while the
package properties reference runtime package `10.0.11`. The source tree contains no `global.json`.
The installed SDK difference below is therefore a reproducibility gap, not proof that compilation
must fail. Runtime package properties are not proof that the host must have that exact shared
runtime installed; inspect the actual restored closure and generated runtime configuration after
building. Older developer prose mentioning .NET 8 is insufficient to select the current toolchain.
See the [target framework properties](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/Common.Dotnet.props#L4-L12),
[CI SDK selection](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/.pipelines/v2/templates/job-build-project.yml#L202-L217),
[package properties](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/Directory.Packages.props#L3-L8),
and the complete [pinned source tree](https://api.github.com/repos/microsoft/PowerToys/git/trees/47f0e4db5af8c399a1a1456005b2e42e0d04293e?recursive=1).

## Local inventory

The following was observed with `vswhere`, `dotnet --info`, runtime architecture APIs, and exact
installation-path existence checks. No test suite or build was run by this preparation.

| Item | Observed state | Consequence |
| --- | --- | --- |
| Windows | Kernel `10.0.28000`, OS and process `X64` | An x64 candidate is appropriate; this does not prove an available dedicated UI session. |
| Visual Studio | Community 2026 `18.7.3`, installation `18.7.11925.98` | MSBuild exists at `C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe`. |
| MSVC | `14.51.36231`; x86/x64 tools, native desktop workload, ATL installed | The pinned source selects `v145` under VS 18. |
| Spectre libraries | x64 runtime and ATL Spectre components were not detected; both matching `lib\spectre\x64` and `atlmfc\lib\spectre\x64` directories are absent | A concrete dependency gap for the default native build. The upstream shared properties enable Spectre for both Debug and Release. |
| Windows SDK | Include directory `10.0.26100.0` and the corresponding VS SDK component exist | The target SDK family is present; the directory alone does not prove its servicing level. |
| .NET SDK | `10.0.301` only | Not aligned with the inspected CI's `10.0.303`; compatibility has not been tested. |
| .NET runtimes | .NET, ASP.NET, and Windows Desktop `8.0.28` and `10.0.9` | Not an acceptance result for the self-contained output. |
| Desktop tooling | Managed desktop, .NET Framework 4.8 SDK, and Windows App SDK C# support detected | Windows App SDK C++ support was not detected by its VS component ID. |
| vcpkg | `C:\Program Files\Microsoft Visual Studio\18\Community\VC\vcpkg\vcpkg.exe` exists | Its component-ID query did not match; do not interpret that as a missing executable. Repository integration and restored native dependencies remain unverified. |
| Source checkout | No top-level `D:\Code\PowerToys` directory observed | This preparation did not locate or create a usable exact-source checkout. |

The Spectre requirement is explicit in the pinned
[C++ build properties](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/Cpp.Build.props#L120-L127).
Do not disable it or otherwise change upstream build properties merely to obtain a green test.

## Isolation and current Worker constraints

The upstream setting path is constructed from `Helper.LocalApplicationDataFolder()` and
`Microsoft\PowerToys`. For an ordinary user, the helper uses
`Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)`. Its special override
requires the LocalSystem branch; it is not a documented ordinary-user test-profile argument.
See the pinned [setting path](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/settings-ui/Settings.UI.Library/SettingPath.cs#L31-L61)
and [profile helper](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/settings-ui/Settings.UI.Library/Utilities/Helper.cs#L99-L112).

Startup initializes logging. The logger creates a directory under `Constants.AppDataPath`, and the
native constant uses `SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, NULL)`. This is a concrete
startup write path even before a scenario changes a setting. See the pinned
[startup initialization](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/settings-ui/Settings.UI/SettingsXAML/App.xaml.cs#L84-L103),
[logger](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/common/ManagedCommon/Logger.cs#L50-L88),
and [native app-data path](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/common/interop/Constants.cpp#L14-L23).

The normal Settings repository initialization can also save default configuration when settings are
missing or cannot be loaded. A fresh launch is consequently not a read-only operation on the
current user's PowerToys configuration. See the pinned
[Settings repository initialization](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/settings-ui/Settings.UI.Library/SettingsRepository%601.cs#L112-L120)
and [settings loading fallback](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/settings-ui/Settings.UI.Library/SettingsUtils.cs#L96-L115).

The Windows known-folder API resolves the current user's known folder when no separate user token
is supplied. Environment-variable replacement is therefore insufficient evidence that PowerToys
storage, logs, mutexes, IPC endpoints, or registry state are isolated. See Microsoft's
[known-folder API](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shgetknownfolderpath).

The runner's MSI instance mutex is fixed as `Local\PowerToys_Runner_MSI_InstanceMutex`; it is not
derived from a checkout or validation profile. The runner also reuses its tracked Settings process
through IPC. Do not use a full runner launch or a Release deep link to bypass standalone-readiness
failures. See the pinned [mutex definition](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/common/utils/appMutex.h#L12-L21)
and [Settings process reuse](https://github.com/microsoft/PowerToys/blob/47f0e4db5af8c399a1a1456005b2e42e0d04293e/src/runner/settings_window.cpp#L699-L726).

The project's current Windows UI implementation already requires an owned process tree and rejects
existing single-instance applications outside that tree. Its desktop lock coordinates Workers that
share one account and lock directory; it does not create a different Windows account or redirect
Windows profile state. The native driver requires an active, unlocked `WinSta0\Default` input
desktop. An alternate hidden desktop or a disconnected background session is not a substitute.
See [UI contracts](../../packages/contracts/src/ui-scenarios.ts),
[desktop lease](../../apps/worker/src/ui/desktop-lease.ts), and
[native UI driver](../../apps/worker/src/ui/windows-driver-entry.ps1).

Before using the candidate, supply a dedicated Windows environment whose account contains no
personal PowerToys state or unrelated PowerToys processes. Record how that environment is restored
between attempts. `restart_process` only restarts owned processes; it does not reset files or
registry data. VM restoration or explicitly scoped reset commands must have an independently
verifiable outcome. Failure to stop or restore the environment must retain quarantine.

## Proposed first acceptance and proof

The initial positive scenario should exercise a non-destructive Settings navigation or search
interaction in the isolated account and then assert a specific visible result. Select stable
Automation IDs only after inspecting the actual built application's owned UI Automation tree.
Do not invent selectors from XAML names. The current driver supports Invoke for clicks and writable
Value for fills; the selected controls must expose those patterns. Startup alone is not a UI check.

| Case | Required proof |
| --- | --- |
| Positive interaction | Exact-source build passes, unique owned window becomes ready, an actual interaction changes the observed UI, and required assertions and owned-window screenshots agree. |
| Deliberately incorrect assertion | A separately frozen test profile expects a known-wrong public value; the result must fail and retain its observation and evidence without modifying application source. |
| Existing or redirected instance | The driver rejects a window outside the launch's verified process ancestry instead of attaching to it. |
| Cancel or early exit | The owned process tree terminates, output drains, and later assertions do not become successful checks. |
| Restoration failure | The run reports the lifecycle blocker and the desktop remains quarantined until the environment is explicitly recovered. |

Persist repository/source identity, frozen profile version, build command exits, produced executable
hash, launch process creation identity, scenario observations, screenshot hashes, uploaded evidence
identity, and final source/process/reset state. Verify the same result and artifacts through the
Server and Dashboard. An isolated synthetic PR/Issue record may exercise this flow; no GitHub
comment, review, label, state change, or other live mutation is required.

Outstanding inputs are the selected desktop repository and source revision, the intended
acceptance behavior, a dedicated active Windows session or VM, its restoration boundary, and
completion of that source's build prerequisites. There is currently no passing real PowerToys
Windows UI acceptance result.
