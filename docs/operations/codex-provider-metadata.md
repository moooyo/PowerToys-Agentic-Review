# Explicit Codex provider metadata classification

The Worker protects every configured provider HTTP header value by default, including short
strings and numeric values. It does not infer whether a value is a credential from length or
entropy. Provider headers remain available only in the native Codex process environment; they
are excluded from model shell commands and CLI argument values.

A trusted operator may place the optional `provider-metadata-policy.json` beside the persistent
Codex profile's `config.toml`. This file authorizes narrowly scoped public metadata exceptions.
It must not come from a repository checkout, a validation profile, a Job payload, or model output.
The Worker never creates or changes this policy automatically.

```json
{
  "schemaVersion": "CodexProviderMetadataPolicyV1",
  "publicHeaders": [
    {
      "providerId": "example-provider",
      "endpoint": "https://inference.example.invalid/v1",
      "header": "X-Request-Source",
      "value": "worker"
    }
  ]
}
```

Every exception requires the selected provider ID, explicitly configured `base_url`, header name,
and approved literal to match. Provider IDs, endpoint strings, and values match exactly; no URL
normalization, prefix matching, wildcard, or default endpoint is inferred. Header names use HTTP
case-insensitive matching. Duplicate rules for the same provider, endpoint, and header are rejected,
including case variants and rules that name different literals. Duplicate JSON properties are
also rejected. Unknown or unmatched headers remain protected.

Authentication headers, including Authorization, Proxy-Authorization, Cookie, Set-Cookie,
authentication challenges, and API/token/secret headers cannot be declared public. Generic
credential forms such as Bearer text or token assignments remain protected even when an exact
literal is listed. Another protected credential with the same text takes precedence over any
public declaration. Lease tokens and other explicitly supplied secrets retain full protection.

Both configuration files must be stable regular files, not symbolic links. The metadata policy
has a 64 KiB UTF-8 file budget and at most 64 rules, with no extra fields. Per-rule limits are
128 characters for provider IDs and header names, 2,048 for endpoints, and 1,024 UTF-16 code units
for values; UTF-8 limits are 512, 128, 8,192, and 4,096 bytes respectively. Strings must be well formed
and exact, without surrounding whitespace, CR, LF, or NUL. Invalid files fail startup with only a
safe file label in the error. Rules and their contents are not exported into CLI arguments, runtime
configuration, diagnostics, or logs; existing header transport remains unchanged.

The loader supplies one protected-value list to the summary, review, and prepared output paths.
Internal callers that omit classification keep the conservative behavior of protecting every
provider environment value. Provider transport and protection are captured together before the
first asynchronous operation, so later changes to caller-owned options do not alter a running
request. The shared prepared runner rejects any successful model result containing a known
protected value with non-retryable `CODEX_RESULT_UNSAFE`, including nested strings, dictionary keys
and JSON primitive representations. It does not rewrite the body and manufacture a new digest.
Optional summary input and output retain their additional protected-text checks.

This classification is not a provider/model identity attestation and does not authorize model
execution. It does not change execution-purpose guards, source verification, sandbox policy,
network isolation, summary opt-in, or any approval requirement for external repository writes.
