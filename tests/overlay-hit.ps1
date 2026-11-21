param([int]$X, [int]$Y)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PanePhysicalHit {
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x; public int y; }
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT at);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
}
'@
$null = [PanePhysicalHit]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
$point = New-Object 'PanePhysicalHit+POINT'
$point.x = $X
$point.y = $Y
[PanePhysicalHit]::GetAncestor([PanePhysicalHit]::WindowFromPoint($point), 2).ToInt64()
