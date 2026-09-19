param(
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [Parameter(Mandatory = $true)][string]$ResultPath
)

# This entry must run as a managed child in the leased, unlocked interactive desktop.
# The trusted tool server supplies process identities and private request/result/artifact paths.
# UI Automation providers can block; ProcessHost owns the hard deadline and process cleanup.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:owners = @{}
$script:request = $null
$script:session = $null
$script:result = $null
$script:ownedDescendants = @()
$script:targetWindow = $null
$script:maximumSearchNodes = 4096

function Throw-DriverFailure([string]$Code, [string]$Message) {
    $failure = New-Object System.InvalidOperationException($Message)
    $failure.Data['E2eCode'] = $Code
    throw $failure
}

function Assert-LocalPath([string]$Path, [string]$Extension) {
    if ($Path.Length -gt 32000 -or $Path -notmatch '^[A-Za-z]:[\\/]' -or $Path.Substring(2) -match '[\x00-\x1f<>:"|?*]') {
        Throw-DriverFailure 'invalid_request' 'A local absolute file path is required.'
    }
    $parts = $Path.Substring(3) -split '[\\/]'
    foreach ($part in $parts) {
        if ([string]::IsNullOrEmpty($part) -or $part -eq '.' -or $part -eq '..' -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9]|LPT[1-9])(?:\.|$)') {
            Throw-DriverFailure 'invalid_request' 'The file path contains an unsupported component.'
        }
    }
    if ($Extension -and [IO.Path]::GetExtension($Path) -ine $Extension) {
        Throw-DriverFailure 'invalid_request' 'The artifact file extension is invalid.'
    }
    $ancestor = $Path
    while (-not [string]::IsNullOrEmpty($ancestor)) {
        if ([IO.File]::Exists($ancestor) -or [IO.Directory]::Exists($ancestor)) {
            if (([IO.File]::GetAttributes($ancestor) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Throw-DriverFailure 'invalid_request' 'Reparse points are not permitted in driver paths.'
            }
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
}

function Assert-ObjectKeys($Object, [string[]]$Required, [string[]]$Optional = @()) {
    if ($null -eq $Object -or $Object -isnot [PSCustomObject]) {
        Throw-DriverFailure 'invalid_request' 'A JSON object is required.'
    }
    $names = @($Object.PSObject.Properties.Name)
    foreach ($name in $Required) {
        if ($names -cnotcontains $name) { Throw-DriverFailure 'invalid_request' 'A required request field is missing.' }
    }
    foreach ($name in $names) {
        if ($Required -cnotcontains $name -and $Optional -cnotcontains $name) {
            Throw-DriverFailure 'invalid_request' 'The request contains an unsupported field.'
        }
    }
}

function Assert-Text($Value, [int]$Minimum, [int]$Maximum) {
    if ($Value -isnot [string] -or $Value.Length -lt $Minimum -or $Value.Length -gt $Maximum -or $Value.Contains([char]0)) {
        Throw-DriverFailure 'invalid_request' 'A text request field is outside its bounds.'
    }
    $null = (New-Object System.Text.UTF8Encoding($false, $true)).GetByteCount($Value)
}

function Assert-Integer($Value, [long]$Minimum, [long]$Maximum) {
    if (($Value -isnot [int] -and $Value -isnot [long]) -or $Value -lt $Minimum -or $Value -gt $Maximum) {
        Throw-DriverFailure 'invalid_request' 'An integer request field is outside its bounds.'
    }
}

function Get-KeyChord([string]$Chord) {
    $parts = $Chord.ToUpperInvariant().Split('+')
    $key = $parts[$parts.Length - 1]
    $modifiers = @()
    if ($parts.Length -gt 1) { $modifiers = @($parts[0..($parts.Length - 2)]) }
    if ($key -notmatch '^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|ENTER|TAB|ESC|ESCAPE|BACKSPACE|DELETE|INSERT|HOME|END|PAGEUP|PAGEDOWN|UP|DOWN|LEFT|RIGHT|SPACE)$') {
        Throw-DriverFailure 'invalid_request' 'The requested key is unsupported.'
    }
    $seen = @{}
    foreach ($modifier in $modifiers) {
        if ($modifier -notin @('CTRL', 'SHIFT', 'ALT') -or $seen.ContainsKey($modifier)) {
            Throw-DriverFailure 'invalid_request' 'The requested key modifier is unsupported.'
        }
        $seen[$modifier] = $true
    }
    if (($modifiers -contains 'ALT' -and $key -in @('TAB', 'ESC', 'ESCAPE')) -or
        ($modifiers -contains 'CTRL' -and $key -in @('ESC', 'ESCAPE')) -or
        ($modifiers -contains 'CTRL' -and $modifiers -contains 'ALT' -and $key -eq 'DELETE')) {
        Throw-DriverFailure 'invalid_request' 'Desktop-switching key chords are unsupported.'
    }
    $codes = @{ ENTER = 13; TAB = 9; ESC = 27; ESCAPE = 27; BACKSPACE = 8; DELETE = 46; INSERT = 45; HOME = 36; END = 35; PAGEUP = 33; PAGEDOWN = 34; UP = 38; DOWN = 40; LEFT = 37; RIGHT = 39; SPACE = 32 }
    if ($codes.ContainsKey($key)) { $keyCode = $codes[$key] }
    elseif ($key -match '^F([0-9]+)$') { $keyCode = 111 + [int]$Matches[1] }
    else { $keyCode = [int][char]$key }
    $modifierCodes = @($modifiers | ForEach-Object { if ($_ -eq 'CTRL') { 17 } elseif ($_ -eq 'SHIFT') { 16 } else { 18 } })
    return @{ key = [uint16]$keyCode; modifiers = [uint16[]]$modifierCodes }
}

function Assert-Request($Value) {
    Assert-ObjectKeys $Value @('schemaVersion', 'requestId', 'action', 'ownedProcesses') @('target', 'maxDepth', 'maxNodes', 'coordinates', 'text', 'keys', 'assertion', 'artifactPath')
    if ($Value.schemaVersion -cne 'E2eDesktopRequestV1' -or $Value.requestId -isnot [string] -or $Value.requestId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$') {
        Throw-DriverFailure 'invalid_request' 'The E2E request envelope is invalid.'
    }
    if ($Value.action -cnotin @('enumerate', 'inspect', 'click', 'type', 'keys', 'assert', 'screenshot', 'desktop-status')) {
        Throw-DriverFailure 'invalid_request' 'The desktop action is unsupported.'
    }
    if ($Value.ownedProcesses -isnot [array] -or $Value.ownedProcesses.Count -gt 128) {
        Throw-DriverFailure 'invalid_request' 'The owned process list is invalid.'
    }
    $identities = @{}
    foreach ($owner in $Value.ownedProcesses) {
        Assert-ObjectKeys $owner @('pid', 'creationTimeFileTime')
        Assert-Integer $owner.pid 1 4294967295
        if ($owner.creationTimeFileTime -isnot [string] -or $owner.creationTimeFileTime -cnotmatch '^[1-9][0-9]{0,19}$' -or $identities.ContainsKey([string]$owner.pid)) {
            Throw-DriverFailure 'invalid_request' 'The owned process identity is invalid.'
        }
        $parsedTime = [uint64]0
        if (-not [uint64]::TryParse($owner.creationTimeFileTime, [ref]$parsedTime)) { Throw-DriverFailure 'invalid_request' 'The process creation time is invalid.' }
        $identities[[string]$owner.pid] = $true
    }
    if ($null -ne $Value.target) {
        Assert-ObjectKeys $Value.target @('pid') @('windowHandle', 'selector')
        Assert-Integer $Value.target.pid 1 4294967295
        if (-not $identities.ContainsKey([string]$Value.target.pid)) { Throw-DriverFailure 'ownership_lost' 'The target process is not owned by this task.' }
        if ($null -ne $Value.target.windowHandle) {
            $parsedHandle = [long]0
            if ($Value.target.windowHandle -isnot [string] -or $Value.target.windowHandle -cnotmatch '^[1-9][0-9]{0,19}$' -or -not [long]::TryParse($Value.target.windowHandle, [ref]$parsedHandle)) {
                Throw-DriverFailure 'invalid_request' 'The target window handle is invalid.'
            }
        }
        if ($null -ne $Value.target.selector) {
            Assert-ObjectKeys $Value.target.selector @() @('automationId', 'name', 'controlType', 'className', 'index')
            $selectorFields = @($Value.target.selector.PSObject.Properties.Name | Where-Object { $_ -ne 'index' })
            if ($selectorFields.Count -eq 0) { Throw-DriverFailure 'invalid_request' 'An element selector needs a property.' }
            foreach ($field in $selectorFields) {
                $limit = 512
                if ($field -eq 'name') { $limit = 1024 }
                if ($field -eq 'controlType') { $limit = 128 }
                Assert-Text $Value.target.selector.$field 1 $limit
            }
            if ($null -ne $Value.target.selector.index) { Assert-Integer $Value.target.selector.index 0 255 }
        }
    }
    elseif ($Value.action -notin @('enumerate', 'desktop-status')) { Throw-DriverFailure 'invalid_request' 'This desktop action requires an owned target.' }
    if ($null -ne $Value.maxDepth) { Assert-Integer $Value.maxDepth 0 12 }
    if ($null -ne $Value.maxNodes) { Assert-Integer $Value.maxNodes 1 256 }
    foreach ($pair in @(@('coordinates', 'click'), @('text', 'type'), @('keys', 'keys'), @('assertion', 'assert'), @('artifactPath', 'screenshot'))) {
        $field = $pair[0]
        if ($null -ne $Value.$field -and $Value.action -cne $pair[1]) { Throw-DriverFailure 'invalid_request' 'This desktop action does not accept the supplied field.' }
        if ($field -ne 'coordinates' -and $Value.action -ceq $pair[1] -and $null -eq $Value.$field) { Throw-DriverFailure 'invalid_request' 'This desktop action is missing a required field.' }
    }
    if ($null -ne $Value.coordinates) {
        Assert-ObjectKeys $Value.coordinates @('x', 'y')
        Assert-Integer $Value.coordinates.x -65536 65536
        Assert-Integer $Value.coordinates.y -65536 65536
        if ($null -ne $Value.target.selector) { Throw-DriverFailure 'invalid_request' 'A click cannot combine coordinates and an element selector.' }
    }
    if ($null -ne $Value.text) { Assert-Text $Value.text 0 8192 }
    if ($null -ne $Value.keys) {
        if ($Value.keys -isnot [array] -or $Value.keys.Count -lt 1 -or $Value.keys.Count -gt 128) { Throw-DriverFailure 'invalid_request' 'The key sequence is invalid.' }
        foreach ($key in $Value.keys) { Assert-Text $key 1 64; $null = Get-KeyChord $key }
    }
    if ($null -ne $Value.assertion) {
        $assertion = $Value.assertion
        Assert-ObjectKeys $assertion @('property', 'expected') @('match')
        if ($assertion.property -cnotin @('exists', 'text', 'value', 'enabled', 'offscreen', 'focused', 'toggleState')) { Throw-DriverFailure 'invalid_request' 'The assertion property is unsupported.' }
        $booleanProperty = $assertion.property -cin @('exists', 'enabled', 'offscreen', 'focused')
        if ($booleanProperty) {
            if ($assertion.expected -isnot [bool]) { Throw-DriverFailure 'invalid_request' 'This assertion requires a boolean expectation.' }
        }
        else { Assert-Text $assertion.expected 0 8192 }
        if ($null -ne $assertion.match -and $assertion.match -cnotin @('equals', 'contains')) { Throw-DriverFailure 'invalid_request' 'The assertion matching mode is unsupported.' }
        if ($assertion.match -ceq 'contains' -and ($booleanProperty -or $assertion.expected -ceq '' -or $assertion.property -ceq 'toggleState')) { Throw-DriverFailure 'invalid_request' 'This assertion cannot use contains matching.' }
        if ($assertion.property -ceq 'toggleState' -and $assertion.expected -cnotin @('on', 'off', 'indeterminate')) { Throw-DriverFailure 'invalid_request' 'The expected toggle state is invalid.' }
    }
    if ($null -ne $Value.artifactPath) { Assert-Text $Value.artifactPath 3 32000; Assert-LocalPath $Value.artifactPath '.png' }
}

function Limit-Text([string]$Text, [int]$Maximum = 1024) {
    if ($null -eq $Text) { return '' }
    if ($Text.Length -le $Maximum) { return $Text }
    $length = $Maximum
    if ([char]::IsHighSurrogate($Text[$length - 1])) { $length-- }
    return $Text.Substring(0, $length)
}

function Assert-Owned([uint32]$ProcessId) {
    $key = [string]$ProcessId
    if (-not $script:owners.ContainsKey($key)) { Throw-DriverFailure 'ownership_lost' 'The target process is not owned.' }
    $owner = $script:owners[$key]
    $owner.Refresh()
    if ($owner.State -cne 'alive' -or $owner.SessionId -ne $script:session.SessionId) {
        Throw-DriverFailure 'ownership_lost' 'The target process identity is no longer alive in this session.'
    }
}

function Test-Owned([uint32]$ProcessId) {
    if (-not $script:owners.ContainsKey([string]$ProcessId)) { return $false }
    $owner = $script:owners[[string]$ProcessId]
    $owner.Refresh()
    return ($owner.State -ceq 'alive' -and $owner.SessionId -eq $script:session.SessionId)
}

function Find-OwnedDescendants {
    $entries = [AgenticReview.E2e.Native]::Processes()
    $descendants = New-Object 'System.Collections.Generic.List[object]'
    $expanded = $true
    while ($expanded) {
        $expanded = $false
        foreach ($entry in $entries) {
            $key = [string]$entry.Id
            $parentKey = [string]$entry.ParentId
            if ($script:owners.ContainsKey($key) -or -not $script:owners.ContainsKey($parentKey)) { continue }
            $parent = $script:owners[$parentKey]
            $parent.Refresh()
            if ($parent.State -cne 'alive' -or $parent.SessionId -ne $script:session.SessionId) { continue }
            $creation = [AgenticReview.E2e.Native]::CurrentCreationTime($entry.Id)
            if ($null -eq $creation) { continue }
            $candidate = New-Object AgenticReview.E2e.OwnedProcess($entry.Id, $creation)
            $parent.Refresh()
            if ($candidate.State -cne 'alive' -or $parent.State -cne 'alive' -or $candidate.SessionId -ne $parent.SessionId -or $candidate.ExpectedCreation -lt $parent.ExpectedCreation) {
                $candidate.Dispose()
                continue
            }
            if ($script:owners.Count -ge 128) {
                $candidate.Dispose()
                Throw-DriverFailure 'ownership_lost' 'The owned process tree exceeded its identity bound.'
            }
            try {
                $imagePath = $candidate.GetImagePath()
                Assert-LocalPath $imagePath '.exe'
            }
            catch {
                $candidate.Dispose()
                Throw-DriverFailure 'ownership_lost' 'The owned descendant executable image could not be identified.'
            }
            $candidate.Refresh()
            if ($candidate.State -cne 'alive') { $candidate.Dispose(); continue }
            $script:owners[$key] = $candidate
            $descendants.Add(@{ pid = $entry.Id; creationTimeFileTime = $creation; parentPid = $entry.ParentId; imagePath = $imagePath })
            $script:ownedDescendants = @($descendants.ToArray())
            $expanded = $true
        }
    }
    return @($descendants.ToArray())
}

function Get-WindowObservation([IntPtr]$Window) {
    $processId = [AgenticReview.E2e.Native]::WindowProcess($Window)
    $bounds = [AgenticReview.E2e.Native]::WindowBounds($Window)
    return @{
        pid = $processId
        windowHandle = $Window.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture)
        title = Limit-Text ([AgenticReview.E2e.Native]::WindowTitle($Window))
        className = Limit-Text ([AgenticReview.E2e.Native]::WindowClass($Window)) 512
        visible = [AgenticReview.E2e.Native]::IsWindowVisible($Window)
        minimized = [AgenticReview.E2e.Native]::IsIconic($Window)
        owned = Test-Owned $processId
        bounds = @{ x = $bounds.Left; y = $bounds.Top; width = $bounds.Right - $bounds.Left; height = $bounds.Bottom - $bounds.Top }
    }
}

function Get-TargetWindowObservation([IntPtr]$Window, [uint32]$ProcessId) {
    Assert-WindowOwner $Window $ProcessId
    $owner = $script:owners[[string]$ProcessId]
    try { $imagePath = $owner.GetImagePath(); Assert-LocalPath $imagePath '.exe' }
    catch { Throw-DriverFailure 'ownership_lost' 'The target executable image could not be identified.' }
    $observation = Get-WindowObservation $Window
    Assert-WindowOwner $Window $ProcessId
    if ($observation.pid -ne $ProcessId -or -not $observation.owned) { Throw-DriverFailure 'ownership_lost' 'The actual target window identity changed.' }
    $observation.imagePath = $imagePath
    $observation.creationTimeFileTime = $owner.ExpectedCreation.ToString([Globalization.CultureInfo]::InvariantCulture)
    $observation.sessionId = $owner.SessionId
    return $observation
}

function Get-TargetWindow($Target) {
    Assert-Owned $Target.pid
    if ($null -ne $Target.windowHandle) {
        $window = [IntPtr]([long]$Target.windowHandle)
        if (-not [AgenticReview.E2e.Native]::IsWindow($window) -or [AgenticReview.E2e.Native]::WindowProcess($window) -ne $Target.pid -or [AgenticReview.E2e.Native]::GetAncestor($window, 2) -ne $window) {
            Throw-DriverFailure 'window_unavailable' 'The requested top-level window is no longer owned by the target process.'
        }
        return $window
    }
    $windows = @([AgenticReview.E2e.Native]::Windows() | Where-Object { [AgenticReview.E2e.Native]::WindowProcess($_) -eq $Target.pid -and [AgenticReview.E2e.Native]::IsWindowVisible($_) })
    if ($windows.Count -eq 0) { Throw-DriverFailure 'window_unavailable' 'The target process has no visible window.' }
    $foreground = [AgenticReview.E2e.Native]::GetForegroundWindow()
    if ($windows -contains $foreground) { return $foreground }
    if ($windows.Count -ne 1) { Throw-DriverFailure 'ambiguous_window' 'Select a windowHandle from enumerate before operating on this process.' }
    return $windows[0]
}

function Assert-WindowOwner([IntPtr]$Window, [uint32]$ProcessId) {
    Assert-Owned $ProcessId
    if (-not [AgenticReview.E2e.Native]::IsWindow($Window) -or [AgenticReview.E2e.Native]::WindowProcess($Window) -ne $ProcessId) { Throw-DriverFailure 'ownership_lost' 'The target window ownership changed.' }
}

function Assert-Foreground([IntPtr]$Window, [uint32]$ProcessId) {
    Assert-WindowOwner $Window $ProcessId
    if (-not [AgenticReview.E2e.Native]::InteractiveDesktop().Interactive) { Throw-DriverFailure 'interactive_session_unavailable' 'The interactive desktop is no longer available.' }
    if ([AgenticReview.E2e.Native]::GetForegroundWindow() -ne $Window) { Throw-DriverFailure 'foreground_unavailable' 'The target window is no longer in the foreground.' }
}

function Set-TargetForeground([IntPtr]$Window, [uint32]$ProcessId) {
    Assert-WindowOwner $Window $ProcessId
    if (-not [AgenticReview.E2e.Native]::IsWindowVisible($Window)) { Throw-DriverFailure 'window_unavailable' 'The target window is not visible.' }
    if ([AgenticReview.E2e.Native]::IsIconic($Window)) { $null = [AgenticReview.E2e.Native]::ShowWindowAsync($Window, 9) }
    $null = [AgenticReview.E2e.Native]::SetForegroundWindow($Window)
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Assert-WindowOwner $Window $ProcessId
        if ([AgenticReview.E2e.Native]::GetForegroundWindow() -eq $Window -and -not [AgenticReview.E2e.Native]::IsIconic($Window)) { break }
        Start-Sleep -Milliseconds 50
    }
    Assert-Foreground $Window $ProcessId
}

function Test-Selector($Element, $Selector) {
    if ($null -eq $Selector) { return $true }
    $current = $Element.Current
    if ($null -ne $Selector.automationId -and $current.AutomationId -cne $Selector.automationId) { return $false }
    if ($null -ne $Selector.name -and $current.Name -cne $Selector.name) { return $false }
    if ($null -ne $Selector.className -and $current.ClassName -cne $Selector.className) { return $false }
    if ($null -ne $Selector.controlType -and $current.ControlType.ProgrammaticName -cne ('ControlType.' + $Selector.controlType)) { return $false }
    return $true
}

function Get-TargetElement([IntPtr]$Window, $Target, [bool]$AllowMissing = $false) {
    Assert-WindowOwner $Window $Target.pid
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($Window)
    if ($null -eq $root -or $root.Current.ProcessId -ne $Target.pid) { Throw-DriverFailure 'element_unavailable' 'The target window has no owned UI Automation root.' }
    if ($null -eq $Target.selector) { return $root }
    $queue = New-Object 'System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]'
    $queue.Enqueue($root)
    $matches = New-Object 'System.Collections.Generic.List[System.Windows.Automation.AutomationElement]'
    $examined = 0
    while ($queue.Count -gt 0) {
        if ($examined -ge $script:maximumSearchNodes) { Throw-DriverFailure 'element_unavailable' 'The element search exceeded its node bound; use a more specific window.' }
        $element = $queue.Dequeue()
        $examined++
        if ($element.Current.ProcessId -ne $Target.pid) { continue }
        if (Test-Selector $element $Target.selector) {
            $matches.Add($element)
            if ($null -ne $Target.selector.index -and $matches.Count -gt $Target.selector.index) { return $matches[$Target.selector.index] }
            if ($null -eq $Target.selector.index -and $matches.Count -gt 1) { Throw-DriverFailure 'ambiguous_element' 'The selector matched multiple controls; choose a specific selector or index.' }
        }
        $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetFirstChild($element)
        while ($null -ne $child) {
            $queue.Enqueue($child)
            if ($queue.Count + $examined -gt $script:maximumSearchNodes) { Throw-DriverFailure 'element_unavailable' 'The element search exceeded its node bound.' }
            $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetNextSibling($child)
        }
    }
    if ($matches.Count -eq 1 -and $null -eq $Target.selector.index) { return $matches[0] }
    if ($AllowMissing) { return $null }
    Throw-DriverFailure 'element_unavailable' 'No control matched the target selector.'
}

function Get-ElementObservation($Element) {
    $current = $Element.Current
    $rectangle = $current.BoundingRectangle
    $bounds = $null
    if (-not $rectangle.IsEmpty -and -not [double]::IsInfinity($rectangle.Width) -and -not [double]::IsInfinity($rectangle.Height)) {
        $bounds = @{ x = $rectangle.X; y = $rectangle.Y; width = $rectangle.Width; height = $rectangle.Height }
    }
    $observation = @{
        pid = $current.ProcessId
        runtimeId = (@($Element.GetRuntimeId()) -join '.')
        name = Limit-Text $current.Name
        automationId = Limit-Text $current.AutomationId 512
        className = Limit-Text $current.ClassName 512
        controlType = $current.ControlType.ProgrammaticName.Replace('ControlType.', '')
        enabled = $current.IsEnabled
        offscreen = $current.IsOffscreen
        focused = $current.HasKeyboardFocus
        password = $current.IsPassword
        bounds = $bounds
        value = $null
        text = Limit-Text $current.Name 2048
        textTruncated = $current.Name.Length -gt 2048
        valueTruncated = $false
        toggleState = $null
    }
    if (-not $current.IsPassword) {
        $pattern = $null
        if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            $value = ([System.Windows.Automation.ValuePattern]$pattern).Current.Value
            $observation.value = Limit-Text $value 2048
            $observation.valueTruncated = $value.Length -gt 2048
        }
        $pattern = $null
        if ($Element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) {
            $text = ([System.Windows.Automation.TextPattern]$pattern).DocumentRange.GetText(2049)
            $observation.text = Limit-Text $text 2048
            $observation.textTruncated = $text.Length -gt 2048
        }
    }
    else { $observation.text = $null; $observation.textTruncated = $false }
    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
        $observation.toggleState = ([System.Windows.Automation.TogglePattern]$pattern).Current.ToggleState.ToString().ToLowerInvariant()
    }
    return $observation
}

function Get-Tree($Root, [uint32]$ProcessId, [int]$MaximumDepth, [int]$MaximumNodes) {
    $queue = New-Object 'System.Collections.Generic.Queue[object]'
    $queue.Enqueue(@{ element = $Root; depth = 0; parentIndex = $null })
    $nodes = New-Object 'System.Collections.Generic.List[object]'
    $truncated = $false
    while ($queue.Count -gt 0) {
        if ($nodes.Count -ge $MaximumNodes) { $truncated = $true; break }
        $item = $queue.Dequeue()
        $element = $item.element
        if ($element.Current.ProcessId -ne $ProcessId) { continue }
        $observation = Get-ElementObservation $element
        $observation.index = $nodes.Count
        $observation.depth = $item.depth
        $observation.parentIndex = $item.parentIndex
        $nodes.Add($observation)
        $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetFirstChild($element)
        if ($item.depth -ge $MaximumDepth) {
            if ($null -ne $child) { $truncated = $true }
            continue
        }
        while ($null -ne $child) {
            if ($nodes.Count + $queue.Count -ge $MaximumNodes) { $truncated = $true; break }
            $queue.Enqueue(@{ element = $child; depth = $item.depth + 1; parentIndex = $observation.index })
            $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetNextSibling($child)
        }
    }
    return @{ nodes = @($nodes.ToArray()); truncated = $truncated }
}

function Assert-ElementOwner($Element, [uint32]$ProcessId) {
    Assert-Owned $ProcessId
    if ($null -eq $Element -or $Element.Current.ProcessId -ne $ProcessId) { Throw-DriverFailure 'ownership_lost' 'The target control ownership changed.' }
}

function Assert-InputFocus([IntPtr]$Window, [uint32]$ProcessId) {
    Assert-Foreground $Window $ProcessId
    $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $focused -or $focused.Current.ProcessId -ne $ProcessId) { Throw-DriverFailure 'foreground_unavailable' 'Keyboard focus is not in the owned target process.' }
}

function Invoke-Click([IntPtr]$Window, $Target, $Coordinates) {
    Set-TargetForeground $Window $Target.pid
    $observation = $null
    if ($null -ne $Coordinates) { $x = $Coordinates.x; $y = $Coordinates.y }
    else {
        $element = Get-TargetElement $Window $Target
        Assert-ElementOwner $element $Target.pid
        $observation = Get-ElementObservation $element
        if (-not $observation.enabled -or $observation.offscreen -or $null -eq $observation.bounds) { Throw-DriverFailure 'unsupported_control' 'The selected control is not enabled and visible.' }
        $point = New-Object System.Windows.Point
        if (-not $element.TryGetClickablePoint([ref]$point)) { Throw-DriverFailure 'unsupported_control' 'The selected control has no clickable screen point.' }
        $x = [int][Math]::Round($point.X)
        $y = [int][Math]::Round($point.Y)
    }
    Assert-Foreground $Window $Target.pid
    $hit = [AgenticReview.E2e.Native]::WindowAt($x, $y)
    if ([AgenticReview.E2e.Native]::WindowProcess($hit) -ne $Target.pid -or [AgenticReview.E2e.Native]::GetAncestor($hit, 2) -ne $Window) { Throw-DriverFailure 'ownership_lost' 'The click point is not in the selected owned window.' }
    [AgenticReview.E2e.Native]::Click($x, $y)
    return @{ x = $x; y = $y; method = 'SendInput'; element = $observation }
}

function Invoke-Assertion([IntPtr]$Window, $Target, $Assertion) {
    $element = Get-TargetElement $Window $Target ($Assertion.property -ceq 'exists')
    $observation = $null
    if ($null -ne $element) { Assert-ElementOwner $element $Target.pid; $observation = Get-ElementObservation $element }
    $actual = $null
    $complete = $true
    if ($Assertion.property -ceq 'exists') { $actual = $null -ne $element }
    elseif ($null -ne $observation) {
        $actual = $observation[$Assertion.property]
        if ($Assertion.property -ceq 'text') { $complete = -not $observation.textTruncated }
        if ($Assertion.property -ceq 'value') { $complete = -not $observation.valueTruncated }
    }
    $match = 'equals'
    if ($null -ne $Assertion.match) { $match = $Assertion.match }
    $passed = $false
    if ($null -ne $actual) {
        if ($match -ceq 'contains' -and $actual -is [string]) { $passed = $actual.Contains($Assertion.expected) }
        elseif ($complete) { $passed = $actual -ceq $Assertion.expected }
    }
    $script:result.data = @{ property = $Assertion.property; expected = $Assertion.expected; actual = $actual; match = $match; passed = $passed; observationComplete = $complete; element = $observation }
    if (-not $passed) { Throw-DriverFailure 'assertion_failed' 'The observed control state did not satisfy the assertion.' }
}

function Save-Screenshot([IntPtr]$Window, $Target, [string]$ArtifactPath) {
    Assert-LocalPath $ArtifactPath '.png'
    Set-TargetForeground $Window $Target.pid
    $windowBounds = [AgenticReview.E2e.Native]::WindowBounds($Window)
    $screen = [AgenticReview.E2e.Native]::ScreenBounds()
    $left = [Math]::Max($windowBounds.Left, $screen.Left)
    $top = [Math]::Max($windowBounds.Top, $screen.Top)
    $right = [Math]::Min($windowBounds.Right, $screen.Right)
    $bottom = [Math]::Min($windowBounds.Bottom, $screen.Bottom)
    $width = $right - $left
    $height = $bottom - $top
    if ($width -le 0 -or $height -le 0 -or [long]$width * [long]$height -gt 33554432) { Throw-DriverFailure 'artifact_failed' 'The visible window screenshot dimensions are invalid.' }
    $stream = $null
    $bitmap = $null
    $graphics = $null
    try {
        $stream = New-Object System.IO.FileStream($ArtifactPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $bitmap = New-Object System.Drawing.Bitmap($width, $height, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $graphics = [Drawing.Graphics]::FromImage($bitmap)
        Assert-Foreground $Window $Target.pid
        $graphics.CopyFromScreen($left, $top, 0, 0, (New-Object Drawing.Size($width, $height)), [Drawing.CopyPixelOperation]::SourceCopy)
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        $stream.Flush($true)
        $size = $stream.Length
    }
    catch {
        if ($_.Exception.Data.Contains('E2eCode')) { throw }
        Throw-DriverFailure 'artifact_failed' 'The screenshot could not be written to a new artifact file.'
    }
    finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }
    return @{ artifactPath = $ArtifactPath; mediaType = 'image/png'; sizeBytes = $size; pid = $Target.pid; windowHandle = $Window.ToInt64().ToString(); scope = 'visible_window'; bounds = @{ x = $left; y = $top; width = $width; height = $height }; foreground = Get-ForegroundObservation }
}

function Get-ForegroundObservation {
    $window = [AgenticReview.E2e.Native]::GetForegroundWindow()
    if ($window -eq [IntPtr]::Zero) { return $null }
    $processId = [AgenticReview.E2e.Native]::WindowProcess($window)
    return @{ pid = $processId; windowHandle = $window.ToInt64().ToString(); title = Limit-Text ([AgenticReview.E2e.Native]::WindowTitle($window)); owned = Test-Owned $processId }
}

function Update-Status {
    $script:session = [AgenticReview.E2e.Native]::InteractiveDesktop()
    $script:result.interactive = $script:session.Interactive
    $script:result.sessionId = $script:session.SessionId
    $script:result.desktopName = $script:session.DesktopName
    $alive = New-Object 'System.Collections.Generic.List[object]'
    $present = New-Object 'System.Collections.Generic.List[uint32]'
    $states = New-Object 'System.Collections.Generic.List[object]'
    foreach ($identity in $script:request.ownedProcesses) {
        $owner = $script:owners[[string]$identity.pid]
        $owner.Refresh()
        $states.Add(@{ pid = $identity.pid; creationTimeFileTime = $identity.creationTimeFileTime; state = $owner.State })
        if ($owner.Present) { $present.Add($identity.pid) }
        if ($owner.State -ceq 'alive') { $alive.Add(@{ pid = $identity.pid; creationTimeFileTime = $identity.creationTimeFileTime }) }
    }
    $script:result.ownedProcessesAlive = @($alive.ToArray())
    $script:result.ownedPidsPresent = @($present.ToArray())
    $script:result.ownedProcessStates = @($states.ToArray())
    $script:result.foreground = Get-ForegroundObservation
    $script:result.observedAt = [DateTime]::UtcNow.ToString('o')
    if ($script:request.action -ceq 'desktop-status') {
        $script:result.data.cleanupConfirmed = $script:result.ownedPidsPresent.Count -eq 0 -and @($script:result.ownedProcessStates | Where-Object { $_.state -ne 'exited' }).Count -eq 0
    }
    if ($script:request.action -cin @('enumerate', 'inspect')) {
        $script:result.data.ownedDescendants = @($script:ownedDescendants)
    }
}

try {
    Assert-LocalPath $RequestPath ''
    Assert-LocalPath $ResultPath ''
    if ([IO.Path]::GetFullPath($RequestPath) -ieq [IO.Path]::GetFullPath($ResultPath)) { Throw-DriverFailure 'invalid_request' 'Request and result paths must be distinct.' }
    $requestInfo = New-Object IO.FileInfo($RequestPath)
    if ($requestInfo.Length -gt 131072) { Throw-DriverFailure 'invalid_request' 'The request exceeds its byte bound.' }
    $raw = [IO.File]::ReadAllText($RequestPath, (New-Object Text.UTF8Encoding($false, $true)))
    $script:request = ConvertFrom-Json -InputObject $raw
    Assert-Request $script:request
    $initialStates = @($script:request.ownedProcesses | ForEach-Object { @{ pid = $_.pid; creationTimeFileTime = $_.creationTimeFileTime; state = 'unavailable' } })
    $initialPids = @($script:request.ownedProcesses | ForEach-Object { $_.pid })
    $script:result = @{ schemaVersion = 'E2eDesktopResultV1'; requestId = $script:request.requestId; action = $script:request.action; success = $false; code = 'driver_failed'; message = 'The desktop driver did not complete.'; observedAt = [DateTime]::UtcNow.ToString('o'); interactive = $false; sessionId = 0; desktopName = $null; foreground = $null; ownedProcessesAlive = @(); ownedPidsPresent = $initialPids; ownedProcessStates = $initialStates; data = @{} }

    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing
    $source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace AgenticReview.E2e {
    public sealed class DesktopState {
        public bool Interactive;
        public uint SessionId;
        public string DesktopName;
    }

    public sealed class OwnedProcess : IDisposable {
        public readonly uint Id;
        public readonly ulong ExpectedCreation;
        public readonly uint SessionId;
        public string State;
        public bool Present;
        private IntPtr handle;
        public OwnedProcess(uint id, string creationTime) {
            Id = id;
            ExpectedCreation = UInt64.Parse(creationTime, System.Globalization.CultureInfo.InvariantCulture);
            handle = Native.OpenProcess(0x00101000, false, id);
            if (handle == IntPtr.Zero) {
                int error = Marshal.GetLastWin32Error();
                State = error == 87 ? "exited" : "unavailable";
                Present = error != 87;
                return;
            }
            ulong created, exited, kernel, user;
            uint session;
            if (!Native.GetProcessTimes(handle, out created, out exited, out kernel, out user) || !Native.ProcessIdToSessionId(id, out session)) {
                State = "unavailable";
                Present = true;
                return;
            }
            SessionId = session;
            State = created == ExpectedCreation ? "alive" : "identity_mismatch";
            Present = true;
            Refresh();
        }
        public void Refresh() {
            if (handle == IntPtr.Zero) return;
            uint state = Native.WaitForSingleObject(handle, 0);
            if (state == 0) { State = "exited"; Present = false; }
            else if (state != 258) { State = "unavailable"; Present = true; }
        }
        public string GetImagePath() {
            Refresh();
            if (State != "alive" || handle == IntPtr.Zero) throw new InvalidOperationException("The owned process is not alive.");
            var imagePath = new StringBuilder(32768);
            uint length = (uint)imagePath.Capacity;
            if (!Native.QueryFullProcessImageName(handle, 0, imagePath, ref length) || length == 0) throw new Win32Exception();
            return imagePath.ToString();
        }
        public void Dispose() { if (handle != IntPtr.Zero) { Native.CloseHandle(handle); handle = IntPtr.Zero; } }
    }

    public static class Native {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct ProcessEntry {
            public uint Size, Usage, Id;
            public UIntPtr Heap;
            public uint Module, Threads, ParentId;
            public int BasePriority;
            public uint Flags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string Executable;
        }
        [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
        [StructLayout(LayoutKind.Sequential)] public struct ObjectFlags { public int Inherit, Reserved; public uint Flags; }
        [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int X, Y; public uint Data, Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Sequential)] public struct KeyboardInput { public ushort Key, Scan; public uint Flags, Time; public UIntPtr Extra; }
        [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MouseInput Mouse; [FieldOffset(0)] public KeyboardInput Keyboard; }
        [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public InputUnion Value; }
        public delegate bool EnumCallback(IntPtr window, IntPtr parameter);

        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
        [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetProcessTimes(IntPtr process, out ulong created, out ulong exited, out ulong kernel, out ulong user);
        [DllImport("kernel32.dll", EntryPoint = "QueryFullProcessImageNameW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)] public static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
        [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll")] public static extern bool ProcessIdToSessionId(uint id, out uint session);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder text, int count);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rectangle);
        [DllImport("user32.dll")] public static extern IntPtr WindowFromPhysicalPoint(Point point);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, Input[] inputs, int size);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
        [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint thread);
        [DllImport("user32.dll")] public static extern IntPtr GetProcessWindowStation();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int needed);
        [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW")] public static extern bool GetUserObjectFlags(IntPtr handle, int index, out ObjectFlags value, int length, out int needed);
        [DllImport("wtsapi32.dll", CharSet = CharSet.Unicode)] public static extern bool WTSQuerySessionInformation(IntPtr server, uint session, int informationClass, out IntPtr buffer, out int size);
        [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr buffer);

        public static uint WindowProcess(IntPtr window) { uint id; GetWindowThreadProcessId(window, out id); return id; }
        public static string WindowTitle(IntPtr window) { var text = new StringBuilder(1025); GetWindowText(window, text, text.Capacity); return text.ToString(); }
        public static string WindowClass(IntPtr window) { var text = new StringBuilder(513); GetClassName(window, text, text.Capacity); return text.ToString(); }
        public static Rect WindowBounds(IntPtr window) { Rect bounds; if (!GetWindowRect(window, out bounds)) throw new Win32Exception(); return bounds; }
        public static Rect ScreenBounds() { int x = GetSystemMetrics(76), y = GetSystemMetrics(77); return new Rect { Left = x, Top = y, Right = x + GetSystemMetrics(78), Bottom = y + GetSystemMetrics(79) }; }
        public static IntPtr WindowAt(int x, int y) { return WindowFromPhysicalPoint(new Point { X = x, Y = y }); }
        public static IntPtr[] Windows() { var windows = new List<IntPtr>(); EnumWindows(delegate(IntPtr window, IntPtr unused) { windows.Add(window); return windows.Count < 4096; }, IntPtr.Zero); return windows.ToArray(); }
        private static string ObjectName(IntPtr handle) { int needed; var name = new StringBuilder(256); return GetUserObjectInformation(handle, 2, name, name.Capacity * 2, out needed) ? name.ToString() : null; }

        public static ProcessEntry[] Processes() {
            IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
            if (snapshot == new IntPtr(-1)) throw new Win32Exception();
            try {
                var entries = new List<ProcessEntry>();
                var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
                if (!Process32FirstW(snapshot, ref entry)) throw new Win32Exception();
                do { entries.Add(entry); } while (Process32NextW(snapshot, ref entry));
                if (Marshal.GetLastWin32Error() != 18) throw new Win32Exception();
                return entries.ToArray();
            }
            finally { CloseHandle(snapshot); }
        }

        public static string CurrentCreationTime(uint id) {
            IntPtr process = OpenProcess(0x1000, false, id);
            if (process == IntPtr.Zero) return null;
            try {
                ulong created, exited, kernel, user;
                return GetProcessTimes(process, out created, out exited, out kernel, out user) ? created.ToString(System.Globalization.CultureInfo.InvariantCulture) : null;
            }
            finally { CloseHandle(process); }
        }

        public static DesktopState InteractiveDesktop() {
            var state = new DesktopState { SessionId = (uint)Process.GetCurrentProcess().SessionId };
            IntPtr input = IntPtr.Zero, buffer = IntPtr.Zero;
            try {
                state.DesktopName = ObjectName(GetThreadDesktop(GetCurrentThreadId()));
                if (!Environment.UserInteractive || state.SessionId == 0 || state.DesktopName != "Default") return state;
                int needed;
                ObjectFlags flags;
                IntPtr station = GetProcessWindowStation();
                if (ObjectName(station) != "WinSta0" || !GetUserObjectFlags(station, 1, out flags, Marshal.SizeOf(typeof(ObjectFlags)), out needed) || (flags.Flags & 1) == 0) return state;
                input = OpenInputDesktop(0, false, 1);
                if (input == IntPtr.Zero || ObjectName(input) != state.DesktopName) return state;
                int bytes;
                if (!WTSQuerySessionInformation(IntPtr.Zero, state.SessionId, 8, out buffer, out bytes) || bytes < 4 || Marshal.ReadInt32(buffer) != 0) return state;
                Rect screen = ScreenBounds();
                state.Interactive = screen.Right > screen.Left && screen.Bottom > screen.Top;
                return state;
            }
            finally { if (buffer != IntPtr.Zero) WTSFreeMemory(buffer); if (input != IntPtr.Zero) CloseDesktop(input); }
        }

        private static Input Key(ushort key, ushort scan, uint flags) { return new Input { Type = 1, Value = new InputUnion { Keyboard = new KeyboardInput { Key = key, Scan = scan, Flags = flags } } }; }
        private static void Send(Input[] input) { if (SendInput((uint)input.Length, input, Marshal.SizeOf(typeof(Input))) != input.Length) throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows did not accept every input event."); }
        public static void Click(int x, int y) {
            if (!SetCursorPos(x, y)) throw new Win32Exception();
            var release = new Input { Type = 0, Value = new InputUnion { Mouse = new MouseInput { Flags = 4 } } };
            try { Send(new Input[] { new Input { Type = 0, Value = new InputUnion { Mouse = new MouseInput { Flags = 2 } } }, release }); }
            catch { SendInput(1, new Input[] { release }, Marshal.SizeOf(typeof(Input))); throw; }
        }
        public static void TypeText(string text) {
            var input = new Input[text.Length * 2];
            for (int i = 0; i < text.Length; i++) { input[i * 2] = Key(0, text[i], 4); input[i * 2 + 1] = Key(0, text[i], 6); }
            if (input.Length > 0) Send(input);
        }
        public static void Chord(ushort key, ushort[] modifiers) {
            var input = new List<Input>();
            foreach (ushort modifier in modifiers) input.Add(Key(modifier, 0, 0));
            uint extended = (key >= 33 && key <= 46) ? 1u : 0u;
            input.Add(Key(key, 0, extended));
            input.Add(Key(key, 0, extended | 2u));
            for (int i = modifiers.Length - 1; i >= 0; i--) input.Add(Key(modifiers[i], 0, 2));
            try { Send(input.ToArray()); }
            catch {
                var release = new List<Input>();
                release.Add(Key(key, 0, extended | 2u));
                for (int i = modifiers.Length - 1; i >= 0; i--) release.Add(Key(modifiers[i], 0, 2));
                SendInput((uint)release.Count, release.ToArray(), Marshal.SizeOf(typeof(Input)));
                throw;
            }
        }
    }
}
'@
    Add-Type -TypeDefinition $source -Language CSharp
    $null = [AgenticReview.E2e.Native]::SetProcessDpiAwarenessContext([IntPtr](-4))
    if ([AgenticReview.E2e.Native]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) { Throw-DriverFailure 'driver_failed' 'Physical desktop coordinates could not be enabled.' }
    foreach ($identity in $script:request.ownedProcesses) {
        $script:owners[[string]$identity.pid] = New-Object AgenticReview.E2e.OwnedProcess([uint32]$identity.pid, $identity.creationTimeFileTime)
    }
    Update-Status
    if ($script:request.action -cne 'desktop-status' -and -not $script:result.interactive) { Throw-DriverFailure 'interactive_session_unavailable' 'An active, unlocked interactive desktop is required.' }
    if ($script:request.action -cin @('enumerate', 'inspect')) { $script:ownedDescendants = @(Find-OwnedDescendants) }

    switch -CaseSensitive ($script:request.action) {
        'desktop-status' {
            $script:result.data = @{ cleanupConfirmed = $script:result.ownedPidsPresent.Count -eq 0 -and @($script:result.ownedProcessStates | Where-Object { $_.state -ne 'exited' }).Count -eq 0 }
        }
        'enumerate' {
            $windows = New-Object 'System.Collections.Generic.List[object]'
            $truncated = $false
            foreach ($window in [AgenticReview.E2e.Native]::Windows()) {
                if (-not [AgenticReview.E2e.Native]::IsWindowVisible($window)) { continue }
                if ($null -ne $script:request.target -and [AgenticReview.E2e.Native]::WindowProcess($window) -ne $script:request.target.pid) { continue }
                if ($windows.Count -ge 256) { $truncated = $true; break }
                $windows.Add((Get-WindowObservation $window))
            }
            $script:result.data = @{ windows = @($windows.ToArray()); truncated = $truncated }
        }
        default {
            $target = $script:request.target
            $window = Get-TargetWindow $target
            $script:targetWindow = Get-TargetWindowObservation $window $target.pid
            switch -CaseSensitive ($script:request.action) {
                'inspect' {
                    $element = Get-TargetElement $window $target
                    $depth = 6
                    $nodes = 128
                    if ($null -ne $script:request.maxDepth) { $depth = $script:request.maxDepth }
                    if ($null -ne $script:request.maxNodes) { $nodes = $script:request.maxNodes }
                    $script:result.data = Get-Tree $element $target.pid $depth $nodes
                    $script:result.data.window = Get-WindowObservation $window
                    Assert-WindowOwner $window $target.pid
                }
                'click' { $script:result.data = Invoke-Click $window $target $script:request.coordinates }
                'type' {
                    Set-TargetForeground $window $target.pid
                    if ($null -ne $target.selector) { $element = Get-TargetElement $window $target; Assert-ElementOwner $element $target.pid; $element.SetFocus() }
                    Assert-InputFocus $window $target.pid
                    [AgenticReview.E2e.Native]::TypeText($script:request.text)
                    $script:result.data = @{ characterCount = $script:request.text.Length; method = 'SendInput'; pid = $target.pid }
                }
                'keys' {
                    Set-TargetForeground $window $target.pid
                    if ($null -ne $target.selector) { $element = Get-TargetElement $window $target; Assert-ElementOwner $element $target.pid; $element.SetFocus() }
                    foreach ($chord in $script:request.keys) {
                        Assert-InputFocus $window $target.pid
                        $parsed = Get-KeyChord $chord
                        [AgenticReview.E2e.Native]::Chord($parsed.key, $parsed.modifiers)
                        Start-Sleep -Milliseconds 20
                    }
                    $script:result.data = @{ keyCount = $script:request.keys.Count; method = 'SendInput'; pid = $target.pid }
                }
                'assert' { Invoke-Assertion $window $target $script:request.assertion }
                'screenshot' { $script:result.data = Save-Screenshot $window $target $script:request.artifactPath }
            }
        }
    }
    $script:result.success = $true
    $script:result.code = 'completed'
    $script:result.message = 'The desktop observation or action completed.'
}
catch {
    if ($null -eq $script:result) {
        [Console]::Error.WriteLine('The desktop driver request or output path is invalid.')
        exit 1
    }
    $errorCode = 'driver_failed'
    $exception = $_.Exception
    while ($null -ne $exception) {
        if ($exception.Data.Contains('E2eCode')) { $errorCode = [string]$exception.Data['E2eCode']; break }
        $exception = $exception.InnerException
    }
    $script:result.success = $false
    $script:result.code = $errorCode
    $script:result.message = if ($errorCode -eq 'driver_failed') { 'A Windows desktop API or UI Automation provider failed.' } else { Limit-Text $_.Exception.Message 2048 }
}
finally {
    if ($null -ne $script:result) {
        if ($script:request.action -cin @('inspect', 'click', 'type', 'keys', 'assert', 'screenshot')) {
            $script:result.data.targetWindow = $script:targetWindow
        }
        try {
            if ($null -ne $script:session) { Update-Status }
            $json = ConvertTo-Json -InputObject $script:result -Depth 20 -Compress
            $bytes = (New-Object Text.UTF8Encoding($false, $true)).GetBytes($json)
            if ($bytes.Length -gt 4194304) { throw 'The result exceeds its byte bound.' }
            Assert-LocalPath $ResultPath ''
            $output = New-Object IO.FileStream($ResultPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $output.Write($bytes, 0, $bytes.Length); $output.Flush($true) }
            finally { $output.Dispose() }
        }
        catch { [Console]::Error.WriteLine('The desktop driver could not finalize its result file.'); $script:result.success = $false }
    }
    foreach ($owner in $script:owners.Values) { $owner.Dispose() }
}
if ($null -eq $script:result -or -not $script:result.success) { exit 1 }
exit 0
