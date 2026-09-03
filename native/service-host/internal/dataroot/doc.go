// Package dataroot verifies the current split-worker role's data root and
// fixed runtime paths without opening the peer role's data root.
//
// Verification starts at a retained volume-root handle and opens every path
// component relative to its retained parent. Ambient operating-system
// ancestors, the shared product anchor, and role-owned objects use distinct
// closed ACL profiles. DataRoot and Profile have an exact fixed child layout;
// approved runtime-content directories allow arbitrary names but every
// existing descendant is bounded, opened, audited, and retained.
//
// The installer must create the complete fixed layout before either service
// starts. DataRoot and every fixed directory use a protected boundary DACL
// with separate directory and non-executable file inheritance templates.
// Runtime-created descendants must have the own virtual-service SID as owner
// and the exact auto-inherited DACL, including OWNER RIGHTS protection against
// implicit WRITE_DAC. Runtime verification never creates or repairs paths.
// The fixed .gitconfig and schema-v4 Control Worker authentication files follow
// this inherited-file policy. The installer or an authorized local bootstrap
// must create them before verification; runtime verification never creates or
// rewrites either file.
//
// The effective-access argument also depends on installverify proving the
// fixed SERVICE_SID_TYPE_RESTRICTED virtual-account token. SYSTEM and
// Administrators retain recovery access, while the restricted own SID receives
// only the audited mask and the peer SID receives no matching ACE. PATH entries
// are not reopened here: each one must be an exact ancestor directory witnessed
// by opaque installverify evidence, and both canonical configurations are bound
// into the data-root evidence digest.
//
// Successful Evidence is only a pre-launch object. The caller must perform its
// final VerifyUnchanged and Close before starting Node; retaining these handles
// while Node runs would freeze legitimate writes and is unsupported. Each role
// records that the peer live root was not observed; readiness requires a later
// protocol step to bind both role evidence digests and reject cross-role
// identity overlap.
package dataroot
