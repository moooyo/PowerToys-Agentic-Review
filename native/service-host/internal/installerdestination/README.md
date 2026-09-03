# Installer Destination Reverification

`installerdestination.Verify` is the production verify-only composition for the split Worker
installer's post-materialization boundary. Its only authorizing input is a live
`stagedpackage.BearerTokenInstallerV2Package`; it accepts no path, serialized evidence, detached
index, trust key, verifier, or filesystem-policy callback.

The staged gate lends the destination verifier one synchronous, one-shot binding to the exact
admitted package-index, signature-envelope, Control bootstrap, Executor bootstrap, and signer key
identity. The binding becomes invalid when the callback returns. A concurrent staged-evidence
`Close` fails closed while the borrow is active instead of invalidating its retained source
handles. A successful destination verification consumes the gate; the resulting evidence owns
both the source handles and every destination handle until `Close`. If the gate is rejected before
the callback begins, ownership has not transferred and the caller remains responsible for its
`Close`; this prevents a repeated borrow from closing source handles already owned by earlier
destination evidence. After transfer, pre-existing staged-evidence and selection aliases reject
`Close`; only the private lease owned by destination evidence can release the source handles.

The verifier independently reopens the three signed and profile-fixed physical roots:

- `C:\Program Files\AgenticReview\Worker`;
- `C:\ProgramData\AgenticReview\TrustedConfig`; and
- `C:\ProgramData\AgenticReview\Packages\<packageId>`.

Each path is traversed component by component from the drive root. Every component must have exact
case, be reparse-free, remain on supported NTFS storage, and match the identity returned by its
parent enumeration. Product-managed ancestors and descendants use the existing closed `winacl`
profiles. The metadata and trusted-configuration trees are read-only to both service identities;
installation files use the same role-specific read/execute mapping as runtime installation
verification.

All three roots must be exact closed trees. The verifier hashes every payload from a retained
destination handle, compares its size and SHA-256 with the signed index, rereads and byte-compares
the index, signature envelope, and both bootstrap documents, reruns `outeradmission` over those
exact destination bytes with compiled `outertrust`, and rechecks every PE payload with the
bootstrap-pinned Authenticode signer. The metadata envelope must name the same signer and exact
index digest admitted by the staged gate. Root, file, enumeration, stream, case-mode, ACL, and
identity evidence remain live and are rechecked by `Evidence.Validate`.

`Evidence` and the borrowed staged binding refuse JSON serialization. A zero value, expired
binding, repeated gate borrow, use after `Close`, ordinary destination drift, or unresolved native
close fails closed. Destination and staged cleanup-fatal states propagate through verification,
validation, and `Close`.

This package is deliberately read-only. It does not extract an archive, create a directory, write
an ACL or file, materialize a candidate, rename or swap a root, provision the Worker Token or CNG
key, mutate SCM, start a service, perform readiness, commit a transaction, or recover an installer
journal. The privileged installer must perform those operations separately and call this verifier
only after all three final roots have been swapped into place.
