# Compiled Outer Package Trust

`outertrust` is the only production source of the public key that authenticates signed outer
Worker package indexes. Local runtime credentials and capability-key material are not package
signing inputs and cannot replace this compiled release trust.

Ordinary builds compile `compiled_unavailable.go`. `Production` returns `ErrUnavailable`, and no
environment variable, command-line option, runtime configuration, package file, or network input
can supply a fallback key.

A controlled verifier build uses `cmd/outertrustgen` with three distinct files:

```text
outertrustgen -spki C:\approved\outer-signer.spki -approved-sha256-file C:\approved\outer-signer.sha256 -output C:\build\signer_release_generated.go
```

The SPKI must be canonical P-256 PKIX DER. The approval file must contain exactly 64 lowercase
SHA-256 hexadecimal bytes with no newline. The generator emits only two string constants under the
`agenticreview_outertrust` build tag; imports, functions, variables, types, init hooks, and extra
constants are rejected by its validator. It never reads or emits a private key.

At runtime `Production` decodes the canonical unpadded base64url SPKI, reparses the canonical DER,
recomputes its digest, and returns opaque evidence. `Evidence.Verify` is a signature check only. It
does not establish package closure, filesystem identity, installation, service control, Claim, or
execution authority.
