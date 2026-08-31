// Package winidentity verifies the Windows service identities and process token
// used by ServiceHost before any application channel is opened. Version 1
// accepts only two distinct NT SERVICE virtual accounts; alternate service
// logon accounts require a separately reviewed identity contract. The token
// contract rejects high-risk privileges even when disabled and accepts only
// the restricting SID set produced by SERVICE_SID_TYPE_RESTRICTED.
package winidentity
