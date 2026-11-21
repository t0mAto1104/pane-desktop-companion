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
if ([PaneHotkey]::GetForegroundWindow() -ne $fixture) { throw 'The dedicated fixture did not have foreground focus.' }
try {
    foreach ($key in 17,16,32) { [PaneHotkey]::keybd_event($key, 0, 0, [UIntPtr]::Zero) }
} finally {
    foreach ($key in 32,16,17) { [PaneHotkey]::keybd_event($key, 0, 2, [UIntPtr]::Zero) }
}
