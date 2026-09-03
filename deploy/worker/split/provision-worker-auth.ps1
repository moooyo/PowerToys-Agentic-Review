[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$WorkerNodeId,

    [switch]$ValidateOnly,

    [object]$Token
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$profileId = 'agentic-review-worker-auth-v1'
$profilePath = 'C:\ProgramData\AgenticReview\Control\worker-auth-v1.json'
$controlServiceSid = 'S-1-5-80-2091717111-3815740202-2957909909-902494971-3397275836'
$maximumDocumentBytes = 4096
$utf8NoBom = [System.Text.UTF8Encoding]::new($false, $true)

if (-not ('AgenticReviewWorkerAuthNative' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AgenticReviewWorkerAuthNative
{
    private const uint TokenAdjustPrivileges = 0x20;
    private const uint TokenQuery = 0x8;
    private const uint PrivilegeEnabled = 0x2;
    private const int ErrorNotAllAssigned = 1300;

    [StructLayout(LayoutKind.Sequential)]
    private struct Luid
    {
        public uint LowPart;
        public int HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct TokenPrivileges
    {
        public uint PrivilegeCount;
        public Luid Luid;
        public uint Attributes;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool MoveFileEx(string existingPath, string newPath, uint flags);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LookupPrivilegeValue(string systemName, string name, out Luid luid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AdjustTokenPrivileges(
        IntPtr tokenHandle,
        bool disableAllPrivileges,
        IntPtr newState,
        uint bufferLength,
        IntPtr previousState,
        IntPtr returnLength
    );

    public sealed class PrivilegeScope : IDisposable
    {
        private IntPtr tokenHandle;
        private TokenPrivileges previousState;

        private PrivilegeScope(IntPtr tokenHandle, TokenPrivileges previousState)
        {
            this.tokenHandle = tokenHandle;
            this.previousState = previousState;
        }

        public void Dispose()
        {
            if (tokenHandle == IntPtr.Zero)
            {
                return;
            }
            try
            {
                if (previousState.PrivilegeCount != 0)
                {
                    IntPtr state = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(TokenPrivileges)));
                    try
                    {
                        Marshal.StructureToPtr(previousState, state, false);
                        bool restored = AdjustTokenPrivileges(
                            tokenHandle,
                            false,
                            state,
                            0,
                            IntPtr.Zero,
                            IntPtr.Zero
                        );
                        int restoreError = Marshal.GetLastWin32Error();
                        if (!restored || restoreError == ErrorNotAllAssigned)
                        {
                            throw new InvalidOperationException("Restore the previous process privilege state.");
                        }
                    }
                    finally
                    {
                        Marshal.FreeHGlobal(state);
                    }
                }
            }
            finally
            {
                CloseHandle(tokenHandle);
                tokenHandle = IntPtr.Zero;
            }
        }

        internal static PrivilegeScope Create(string name)
        {
            IntPtr tokenHandle;
            if (!OpenProcessToken(GetCurrentProcess(), TokenAdjustPrivileges | TokenQuery, out tokenHandle))
            {
                return null;
            }

            Luid luid;
            if (!LookupPrivilegeValue(null, name, out luid))
            {
                CloseHandle(tokenHandle);
                return null;
            }
            TokenPrivileges requested = new TokenPrivileges
            {
                PrivilegeCount = 1,
                Luid = luid,
                Attributes = PrivilegeEnabled
            };
            int stateSize = Marshal.SizeOf(typeof(TokenPrivileges));
            IntPtr requestedState = Marshal.AllocHGlobal(stateSize);
            IntPtr previousState = Marshal.AllocHGlobal(stateSize);
            IntPtr returnLength = Marshal.AllocHGlobal(sizeof(uint));
            try
            {
                Marshal.StructureToPtr(requested, requestedState, false);
                Marshal.StructureToPtr(new TokenPrivileges(), previousState, false);
                Marshal.WriteInt32(returnLength, 0);
                bool adjusted = AdjustTokenPrivileges(
                    tokenHandle,
                    false,
                    requestedState,
                    (uint)stateSize,
                    previousState,
                    returnLength
                );
                int adjustError = Marshal.GetLastWin32Error();
                TokenPrivileges prior = (TokenPrivileges)Marshal.PtrToStructure(
                    previousState,
                    typeof(TokenPrivileges)
                );
                if (!adjusted || adjustError == ErrorNotAllAssigned)
                {
                    CloseHandle(tokenHandle);
                    return null;
                }
                return new PrivilegeScope(tokenHandle, prior);
            }
            finally
            {
                Marshal.FreeHGlobal(requestedState);
                Marshal.FreeHGlobal(previousState);
                Marshal.FreeHGlobal(returnLength);
            }
        }
    }

    public static PrivilegeScope EnablePrivilegeScope(string name)
    {
        return PrivilegeScope.Create(name);
    }
}
'@
}

function Read-WorkerToken {
    param([Security.SecureString]$SecureValue)

    if ($null -eq $SecureValue) {
        $SecureValue = Read-Host 'Worker Token' -AsSecureString
    }

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Assert-WorkerIdentity {
    param([string]$Value)

    if ($Value.Length -lt 1 -or $Value.Length -gt 128 -or
        $Value -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:-]*$') {
        throw 'WorkerNodeId is not a canonical Worker entity ID.'
    }
}

function Assert-WorkerToken {
    param([string]$Value)

    if ($Value -cnotmatch '^arw1_[A-Za-z0-9_-]{43}$') {
        throw 'The Worker Token does not match the arw1 profile.'
    }
    $encoded = $Value.Substring(5).Replace('-', '+').Replace('_', '/') + '='
    try {
        $decoded = [Convert]::FromBase64String($encoded)
    }
    catch {
        throw 'The Worker Token contains an invalid base64url value.'
    }
    if ($decoded.Length -ne 32) {
        throw 'The Worker Token does not contain exactly 32 random bytes.'
    }
    $canonical = [Convert]::ToBase64String($decoded).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    if ($Value.Substring(5) -cne $canonical) {
        throw 'The Worker Token is not canonically encoded.'
    }
}

function New-WorkerAuthDocument {
    param(
        [string]$NodeId,
        [string]$Token
    )

    Assert-WorkerIdentity $NodeId
    Assert-WorkerToken $Token
    $document = '{"profileId":"' + $profileId + '","token":"' + $Token + '","workerNodeId":"' + $NodeId + '"}'
    $bytes = $utf8NoBom.GetBytes($document)
    if ($bytes.Length -gt $maximumDocumentBytes) {
        throw 'The Worker authentication document exceeds its fixed byte limit.'
    }
    return $bytes
}

function Assert-ExactWorkerAuthDocument {
    param(
        [byte[]]$Bytes,
        [byte[]]$Expected
    )

    if ($Bytes.Length -ne $Expected.Length) {
        throw 'The persisted Worker authentication document has the wrong length.'
    }
    for ($index = 0; $index -lt $Expected.Length; $index++) {
        if ($Bytes[$index] -ne $Expected[$index]) {
            throw 'The persisted Worker authentication document is not canonical.'
        }
    }
    [void]$utf8NoBom.GetString($Bytes)
}

function Get-WorkerAuthFileSecurity {
    param([IO.FileStream]$Stream)

    if ($null -ne $Stream.PSObject.Methods['GetAccessControl']) {
        return $Stream.GetAccessControl()
    }
    return [IO.FileSystemAclExtensions]::GetAccessControl($Stream)
}

function Set-WorkerAuthFileSecurity {
    param(
        [IO.FileStream]$Stream,
        [Security.AccessControl.FileSecurity]$Security
    )

    if ($null -ne $Stream.PSObject.Methods['SetAccessControl']) {
        $Stream.SetAccessControl($Security)
        return
    }
    [IO.FileSystemAclExtensions]::SetAccessControl($Stream, $Security)
}

function Assert-WorkerAuthFileSecurity {
    param([Security.AccessControl.FileSecurity]$Security)

    $owner = $security.GetOwner([Security.Principal.SecurityIdentifier]).Value
    $descriptorBytes = $security.GetSecurityDescriptorBinaryForm()
    $rawDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new($descriptorBytes, 0)
    $autoInherited = [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInherited
    $dacl = $rawDescriptor.DiscretionaryAcl
    if ($owner -ne $controlServiceSid -or $security.AreAccessRulesProtected -or
        -not $security.AreAccessRulesCanonical -or ($rawDescriptor.ControlFlags -band $autoInherited) -eq 0 -or
        $null -eq $dacl -or $dacl.Revision -ne 2) {
        throw 'The Worker authentication file owner or inheritance state is invalid.'
    }
    $expected = @{
        'S-1-5-18'     = [uint32]0x001f01ff
        'S-1-5-32-544' = [uint32]0x001f01ff
        $controlServiceSid = [uint32]0x0013019f
        'S-1-3-4'      = [uint32]0x00020000
    }
    if ($dacl.Count -ne $expected.Count) {
        throw 'The Worker authentication file DACL has the wrong rule count.'
    }
    foreach ($ace in $dacl) {
        if ($ace -isnot [Security.AccessControl.CommonAce]) {
            throw 'The Worker authentication file DACL contains an unsupported ACE type.'
        }
        $sid = $ace.SecurityIdentifier.Value
        if ($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or
            $ace.IsCallback -or $ace.AceFlags -ne [Security.AccessControl.AceFlags]::Inherited -or
            -not $expected.ContainsKey($sid) -or [uint32]$ace.AccessMask -ne $expected[$sid]) {
            throw 'The Worker authentication file DACL does not match the inherited Control profile.'
        }
        [void]$expected.Remove($sid)
    }
    if ($expected.Count -ne 0) {
        throw 'The Worker authentication file DACL is incomplete.'
    }
}

[byte[]]$documentBytes = $null
$privilegeScope = $null
if ($null -ne $Token -and $Token -isnot [Security.SecureString]) {
    throw 'Token must be supplied as a SecureString.'
}
$tokenText = Read-WorkerToken -SecureValue $Token
try {
    $documentBytes = New-WorkerAuthDocument -NodeId $WorkerNodeId -Token $tokenText
    if ($ValidateOnly) {
        Assert-ExactWorkerAuthDocument -Bytes $documentBytes -Expected $documentBytes
        Write-Output 'Worker authentication input is valid.'
        exit 0
    }

    $directory = [IO.Path]::GetDirectoryName($profilePath)
    if (-not [IO.Directory]::Exists($directory)) {
        throw 'The fixed Control data root must be created by the split installer before credential provisioning.'
    }
    $directoryAttributes = [IO.File]::GetAttributes($directory)
    if (($directoryAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'The fixed Control data root must not be a reparse point.'
    }
    if ([IO.File]::Exists($profilePath)) {
        $targetAttributes = [IO.File]::GetAttributes($profilePath)
        if (($targetAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'The fixed Worker authentication profile must not be a reparse point.'
        }
    }
    $privilegeScope = [AgenticReviewWorkerAuthNative]::EnablePrivilegeScope('SeRestorePrivilege')
    if ($null -eq $privilegeScope) {
        throw 'Credential provisioning requires an installer identity with SeRestorePrivilege.'
    }

    foreach ($stalePath in [IO.Directory]::GetFiles($directory, '.worker-auth-v1.*.tmp', [IO.SearchOption]::TopDirectoryOnly)) {
        $staleAttributes = [IO.File]::GetAttributes($stalePath)
        if (($staleAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'A stale Worker authentication temporary path is a reparse point.'
        }
        [IO.File]::Delete($stalePath)
    }

    $temporaryPath = [IO.Path]::Combine($directory, '.worker-auth-v1.' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $stream = [IO.FileStream]::new(
            $temporaryPath,
            [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write,
            [IO.FileShare]::Read,
            4096,
            [IO.FileOptions]::WriteThrough
        )
        try {
            $temporaryAcl = Get-WorkerAuthFileSecurity -Stream $stream
            $temporaryAcl.SetOwner([Security.Principal.SecurityIdentifier]::new($controlServiceSid))
            Set-WorkerAuthFileSecurity -Stream $stream -Security $temporaryAcl
            Assert-WorkerAuthFileSecurity -Security (Get-WorkerAuthFileSecurity -Stream $stream)
            $stream.Write($documentBytes, 0, $documentBytes.Length)
            $stream.Flush($true)
            Assert-WorkerAuthFileSecurity -Security (Get-WorkerAuthFileSecurity -Stream $stream)
        }
        finally {
            $stream.Dispose()
        }

        $moveFileReplaceExisting = [uint32]0x1
        $moveFileWriteThrough = [uint32]0x8
        if (-not [AgenticReviewWorkerAuthNative]::MoveFileEx(
            $temporaryPath,
            $profilePath,
            $moveFileReplaceExisting -bor $moveFileWriteThrough
        )) {
            $nativeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw [ComponentModel.Win32Exception]::new($nativeError, 'Replace the fixed Worker authentication profile')
        }
        $persisted = [IO.File]::ReadAllBytes($profilePath)
        Assert-ExactWorkerAuthDocument -Bytes $persisted -Expected $documentBytes
        Assert-WorkerAuthFileSecurity -Security (Get-Acl -LiteralPath $profilePath)
    }
    finally {
        if ($null -ne $temporaryPath -and [IO.File]::Exists($temporaryPath)) {
            [IO.File]::Delete($temporaryPath)
        }
    }

    Write-Output "Provisioned the fixed Worker authentication profile at $profilePath."
}
finally {
    try {
        if ($null -ne $privilegeScope) {
            $privilegeScope.Dispose()
        }
    }
    finally {
        $tokenText = $null
        if ($null -ne $documentBytes) {
            [Array]::Clear($documentBytes, 0, $documentBytes.Length)
        }
    }
}
