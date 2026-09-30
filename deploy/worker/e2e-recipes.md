# Bundled PowerToys Run recipes

Native `pr-e2e` tasks discover the recipes applicable to their repository and changed
paths in the ordinary Worker prompt. No external script or historical evidence file
is required. The configured model chooses the scenarios and reviews their results;
the Worker performs the fixed build, UI, assertion, screenshot and cleanup sequence.

Send requests through the current Task's tool transport. `transport.json` contains
the exact endpoint and capability. Keep it private and save the response from a
long-running call before displaying it. Continue waiting on the original shell
session instead of issuing another build. Use the longest wait explicitly supported
by the active shell tool. When `write_stdin` advertises support for a 300000 ms wait,
use its returned `session_id`, `chars: ""` and `yield_time_ms: 300000`; otherwise use
the maximum stated by that tool. Repeated 1-30 second polls unnecessarily replay
the model context. Reuse the completed JSON from the original session. If that output
is missing or incomplete, read the cached response file once after completion;
do not poll its existence or repeatedly reload completed receipts.

## Calculator baseline

```json
{"operation":"run-recipe","recipeId":"powertoys-calculator"}
```

This English-UI baseline builds the real PowerToys Run Launcher and Calculator
plugin, then checks explicit complex-number errors, ordinary explicit arithmetic,
the global arithmetic positive control, and suppression of the global complex error.
It registers all assertions before execution and captures each successful UI state.
The feature paths are the supported changed files actually present in the Task.
Baseline success does not establish coverage of other PR behavior or changed paths.

## PR-specific queries

`powertoys-run-query` shares the same controlled Launcher workflow for `Calculator`
and `UnitConverter`. Provide one to eight scenarios with concrete, source-supported
queries, complete UI feature plans and expectations. The following example shows
the shape; replace the path, query and expected row with the actual pinned PR's
values before execution.

```json
{
  "operation": "run-recipe",
  "recipeId": "powertoys-run-query",
  "plugin": "UnitConverter",
  "scenarios": [{
    "query": "a concrete PR query",
    "feature": {
      "id": "conversion",
      "title": "PR-specific unit conversion",
      "paths": ["an actual changed plugin file"],
      "scenario": "Describe the observable conversion behavior.",
      "userVisible": true,
      "assertions": [{
        "id": "result",
        "kind": "ui",
        "description": "The conversion result matches the expected value.",
        "selector": {"name": "the exact accessible result row"},
        "assertion": {"property": "text", "expected": "the expected value", "match": "contains"}
      }]
    }
  }]
}
```

A scenario's optional `requires` names an earlier feature that must have passed.
Use it to require a positive control before an absence check, and include a query
value assertion to rule out stale input. Selectors and assertions follow the
existing E2E feature contract. All feature paths must belong to actual changed
files of the selected plugin or its tests.

## Results and limits

The outer receipt returns `observed.summary`, `observed.features` and
`observed.cleanupConfirmed`. Each feature has the final `assertionReceiptIds` and
`mediaReceiptIds` for its fresh Worker observations. The `run-recipe` receipt is
never itself an assertion. The normal report projection still verifies the exact
head, build, process, assertion and media bindings and retains uncovered changes.

One recipe shares one controlled solution Rebuild and one owned Launcher session.
An identical request in the same Task reuses the original result; changing its
scenarios after execution starts is rejected. Failures retain their outcomes.
Cancellation uses the existing Task signal and final Worker cleanup. A missing
desktop, incompatible application layout or unavailable build remains blocked.
Recipes capture screenshots; they do not synthesize video or substitute old media.
