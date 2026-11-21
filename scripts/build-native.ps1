$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if ($env:PANE_MSVC_ROOT) {
    $vc = $env:PANE_MSVC_ROOT
} else {
    $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1
    if (!$vs) { throw 'Install Visual Studio Build Tools with Desktop development with C++.' }
    $vc = (Get-ChildItem (Join-Path $vs 'VC\Tools\MSVC') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1).FullName
}
if ($env:PANE_SDK_INCLUDE -and $env:PANE_SDK_LIB) {
    $sdkInclude = $env:PANE_SDK_INCLUDE
    $sdkLib = $env:PANE_SDK_LIB
} else {
    $kitRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
    $version = Get-ChildItem (Join-Path $kitRoot 'Include') -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'cppwinrt\winrt\Windows.Graphics.Capture.h') } |
        Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    if (!$version) { throw 'Install Windows SDK 10.0.26100 or later.' }
    $sdkInclude = $version.FullName
    $sdkLib = Join-Path $kitRoot "Lib\$($version.Name)"
}
$env:INCLUDE = (@((Join-Path $vc 'include')) + @('ucrt','shared','um','winrt','cppwinrt' | ForEach-Object { Join-Path $sdkInclude $_ })) -join ';'
$env:LIB = (@((Join-Path $vc 'lib\x64')) + @('ucrt','um' | ForEach-Object { Join-Path $sdkLib "$_\x64" })) -join ';'
$bin = Join-Path $root 'native\bin'
New-Item -ItemType Directory -Force $bin | Out-Null
& (Join-Path $vc 'bin\Hostx64\x64\cl.exe') /nologo /std:c++20 /EHsc /W4 /O2 /MT /DUNICODE /D_UNICODE /utf-8 "/Fo$bin\\" "/Fe$bin\window-capture.exe" (Join-Path $root 'native\window-capture.cpp') (Join-Path $root 'native\ui-automation.cpp') (Join-Path $root 'native\text-selection.cpp') (Join-Path $root 'native\voice-audio.cpp') /link user32.lib dwmapi.lib d3d11.lib dxgi.lib windowscodecs.lib ole32.lib oleaut32.lib uuid.lib uiautomationcore.lib windowsapp.lib gdi32.lib
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
