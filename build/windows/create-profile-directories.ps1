# Create Vapor's local-first profile directories for an installed/default profile.
# The browser also creates these directories automatically during first startup.
[CmdletBinding()]
param(
    [string]$ProfileName = "default"
)

$profileRoot = Join-Path $env:APPDATA "Vapor\Profiles"
$profileDir = Join-Path $profileRoot $ProfileName

@(
    $profileRoot,
    $profileDir,
    (Join-Path $profileDir "vapor-blocklists"),
    (Join-Path $profileDir "vapor-templates"),
    (Join-Path $profileDir "vapor-reading-list")
) | ForEach-Object {
    New-Item -ItemType Directory -Path $_ -Force | Out-Null
}

Write-Host "Vapor profile directories created at $profileDir"
