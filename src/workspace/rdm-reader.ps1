# Fixed read-only bridge. User input is JSON data, never executable PowerShell.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    $request = $env:CYBERDOG_RDM_REQUEST | ConvertFrom-Json
    if ($request.operation -notin @('list', 'get')) { throw 'Unsupported operation' }
    Import-Module Devolutions.PowerShell -ErrorAction Stop
    $previous = Get-RDMCurrentDataSource
    try {
        Set-RDMCurrentDataSource -ID ([guid]$request.dataSourceId) | Out-Null
        Get-RDMRepository | Out-Null
        Set-RDMCurrentRepository -ID ([guid]$request.vaultId) | Out-Null
        $source = Get-RDMCurrentDataSource
        if ($source.IsOffline) { throw 'Offline workspace is not allowed' }
        Update-RDMEntries | Out-Null
        if ($request.operation -eq 'list') {
            $items = @(Get-RDMEntry | Select-Object @{Name='id';Expression={$_.ID.ToString()}}, @{Name='name';Expression={$_.Name}})
            ConvertTo-Json -InputObject $items -Compress -Depth 4
        } else {
            $entry = Get-RDMEntry -ID ([guid]$request.itemId)
            if ($null -eq $entry) { throw 'Entry unavailable' }
            $username = Get-RDMEntryUsername -InputObject $entry
            $password = Get-RDMEntryPassword -InputObject $entry -AsPlainText
            if ($null -eq $password) { throw 'Credentials unavailable' }
            @{id=$entry.ID.ToString(); host=$entry.Host; user=$username; password=$password} | ConvertTo-Json -Compress -Depth 4
        }
    } finally {
        if ($previous) { Set-RDMCurrentDataSource -ID $previous.ID | Out-Null }
    }
} catch {
    # Vendor exceptions can include secrets. Do not write them to stdout/stderr.
    [Console]::Error.WriteLine('Remote Desktop Manager access failed')
    exit 1
}
