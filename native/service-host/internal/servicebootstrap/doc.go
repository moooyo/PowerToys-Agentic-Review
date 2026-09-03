// Package servicebootstrap prepares the current Windows ServiceHost process for
// the fixed Control or Executor service role.
//
// Prepare performs the read-only Windows identity preflight first. It then
// applies and reads back exact protected DACLs on the current process and its
// primary token. The operation retains no handles and returns no evidence or
// lifecycle session.
package servicebootstrap
