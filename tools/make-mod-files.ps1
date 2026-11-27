# 为每个含 descriptor.mod 的模组文件夹生成根目录下的 .mod 指针文件。
# 用途：换新电脑后，让 CK3 启动器按当前电脑的路径找到本地模组。
# 用法：在仓库根目录执行
#   powershell -ExecutionPolicy Bypass -File tools\make-mod-files.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)
$count = 0

foreach ($d in (Get-ChildItem $root -Directory | Sort-Object Name)) {
    $desc = Join-Path $d.FullName 'descriptor.mod'
    if (-not (Test-Path $desc)) { continue }

    $text = [System.IO.File]::ReadAllText($desc)
    $modPath = $d.FullName.Replace('\', '/')

    if ($text -match '(?m)^path=') {
        $text = [regex]::Replace($text, '(?m)^path=.*$', 'path="' + $modPath + '"')
    } else {
        $text = $text.TrimEnd() + "`npath=`"$modPath`"`n"
    }

    $out = Join-Path $root ($d.Name + '.mod')
    [System.IO.File]::WriteAllText($out, $text, $utf8)
    Write-Output ("generated: {0}.mod" -f $d.Name)
    $count++
}

Write-Output ("done, {0} mod files" -f $count)
