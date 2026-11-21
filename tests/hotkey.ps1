$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PaneHotkey {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
'@
$fixture = [IntPtr]::new([Int64]$args[0])
if ([PaneHotkey]::GetForegroundWindow() -ne $fixture) {
    $null = [PaneHotkey]::SetForegroundWindow($fixture)
    Start-Sleep -Milliseconds 150
}
if ([PaneHotkey]::GetForegroundWindow() -ne $fixture) {
    # Windows may prevent a test launched from a background process from activating its own fixture.
    [PaneHotkey]::keybd_event(18, 0, 0, [UIntPtr]::Zero)
    try { $null = [PaneHotkey]::SetForegroundWindow($fixture) }
    finally { [PaneHotkey]::keybd_event(18, 0, 2, [UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 150
}
if ([PaneHotkey]::GetForegroundWindow() -ne $fixture) { throw 'The dedicated fixture did not have foreground focus.' }
if ($args[1] -eq 'focus-only') { return }
$trigger = switch ($args[1]) {
    'selection' { 81 }
    'selection-test' { 122 }
    default { 32 }
}
try {
    foreach ($key in 17,16,$trigger) { [PaneHotkey]::keybd_event($key, 0, 0, [UIntPtr]::Zero) }
} finally {
    foreach ($key in $trigger,16,17) { [PaneHotkey]::keybd_event($key, 0, 2, [UIntPtr]::Zero) }
}
