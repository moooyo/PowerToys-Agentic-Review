# Minimal Worker Package

`workerpackage` is a minimal Windows Worker package validator with three responsibilities:

1. Parse and emit strict canonical manifest JSON.
2. Verify detached Ed25519 signatures over canonical manifest bytes.
3. Verify listed files under a root path by regular-file type, exact size, and SHA-256.

The manifest schema is fixed to:

```json
{
  "releaseId": "...",
  "architecture": "amd64|arm64",
  "files": [
    {
      "relativePath": "bin/worker.exe",
      "size": 123,
      "sha256": "64-lowercase-hex"
    }
  ]
}
```

## Security and format constraints

- Canonical JSON only: strict fields, UTF-8, no BOM, no unknown keys, no trailing JSON values.
- `architecture` is restricted to `amd64` or `arm64`.
- `relativePath` uses forward slashes and must be relative.
- `relativePath` cannot contain `.` or `..` segments, backslashes, ADS/drive colons, invalid
  Windows characters, reserved Windows device names, or segments ending with dot/space.
- `files[].relativePath` values are case-insensitively unique.
- `sha256` must be exactly 64 lowercase hexadecimal characters.
- File count and manifest byte size are bounded by constants in `types.go`.

`VerifyFiles` checks only files listed in the manifest. Extra files at the source root are ignored.
