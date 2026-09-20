# E2E compiler selection and build blockers

An executable pin identifies MSBuild or dotnet, but does not select the MSVC
compiler and standard-library version that a repository will use. Selecting the
latest installed compiler can break a frozen dependency even when its Git commit
and build entry point are correct.

## Deployment-owned compiler selection

Deployments can set the following pair alongside their existing MSBuild executable
pin:

- `INVESTIGATION_WORKER_MSBUILD_VC_TOOLS_VERSION`: the exact installed MSVC version.
- `INVESTIGATION_WORKER_MSBUILD_PLATFORM_TOOLSET`: its supported platform toolset.

The Worker validates the pair and supplies it as explicit MSBuild global
properties, including builds launched through dotnet. Model requests cannot add
arbitrary MSBuild properties or choose a toolchain. Conflicting environment
overrides are rejected. Leaving the pair unset retains the existing selection
behavior.

Install the matching official compiler, libraries, ATL and Spectre components as
required by the target repository. A configured version is not a substitute for
installing or validating that toolchain. Verification must retain the original PR
source and dependency commits; changing the frozen dependency or disabling its
checks does not establish that the original revision passed.

## Retained build evidence

Both successful and failed controlled compiler invocations retain their frontend
identity, executable digest, source/project binding, configuration, platform,
explicit toolchain selection and final argument list. These are not presented as
an observed `cl.exe` version. The agent-facing failure keeps a small preview, while
a separate bounded log artifact retains more captured output. Capture limits and
truncation remain explicit; omitted bytes must not be described as a complete log.

When no verified build exists, failed build receipts with retained log artifacts
produce typed blockers. The blockers contain only controlled failure codes,
bounded compiler diagnostic codes and evidence references. They never copy model
summaries, raw exception text, filesystem paths or compiler transcripts into public
comments. Their references must bind Worker evidence and available log artifacts
from the same task, subject and observation attempt.

The report and public comment explain these blockers before generic missing
coverage. Unexecuted features and assertions remain unexecuted; reporting the
prerequisite failure does not fabricate feature registration or a test pass. A
later verified build removes the unresolved build-blocker projection. Checkpoint
recovery retains the accepted structured observations without rerunning side
effects.

## Media and model identity

An E2E run with no publishable screenshots or videos states that no media upload is
pending. This differs from an upload that is queued, blocked or has an unconfirmed
outcome. Existing publication states and duplicate-upload protection remain intact.

When accepted analysis records exist but contain no model name, the disclosure says
the name was not recorded. Missing or malformed execution history retains the
generic identity disclosure; the application does not invent a provider model.
