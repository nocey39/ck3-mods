param(
    [string] $GameData,
    [string] $UserData = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Paradox Interactive\Crusader Kings III'),
    [string] $ModFolder = (Split-Path -Parent $PSScriptRoot),
    [string] $NodePath,
    [switch] $Launch
)

$ErrorActionPreference = 'Stop'
if (Get-Process -Name ck3 -ErrorAction SilentlyContinue) {
    throw 'Exit CK3 before refreshing the price catalog.'
}
if (-not $GameData) {
    $steam = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Valve\Steam' -Name SteamPath -ErrorAction SilentlyContinue).SteamPath
    if (-not $steam) { $steam = Join-Path ${env:ProgramFiles(x86)} 'Steam' }
    $GameData = Join-Path $steam 'steamapps\common\Crusader Kings III\game'
}
if (-not $NodePath) {
    $NodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
}
if (-not $NodePath) {
    $runtimes = Get-AppxPackage -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like 'OpenAI.CodexPrimaryRuntime*' } |
        Sort-Object Version -Descending
    foreach ($runtime in $runtimes) {
        $bundledNode = Join-Path $runtime.InstallLocation 'dependencies\node\bin\node.exe'
        if (Test-Path -LiteralPath $bundledNode) { $NodePath = $bundledNode; break }
    }
}
if (-not $NodePath) { throw 'Node.js 22.13 or later is required. Pass -NodePath if it is installed outside PATH.' }
& $NodePath (Join-Path $PSScriptRoot 'refresh-florin-quotes.cjs') $GameData $ModFolder $UserData --playset
if ($LASTEXITCODE -ne 0) { throw 'Price refresh failed. The previous price catalog has been preserved.' }
if ($Launch) { Start-Process 'steam://rungameid/1158310' }
