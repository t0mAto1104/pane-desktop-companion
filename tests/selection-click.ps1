param([long]$Handle, [int]$X, [int]$Y)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SelectionFixtureClick {
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x; public int y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point position);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
}
'@
[SelectionFixtureClick]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$point=[SelectionFixtureClick+Point]@{x=$X; y=$Y}
$owner=[IntPtr]::new($Handle)
if ([SelectionFixtureClick]::GetForegroundWindow() -ne $owner -or
    [SelectionFixtureClick]::GetAncestor([SelectionFixtureClick]::WindowFromPoint($point), 2) -ne $owner) {
    throw 'Refusing to click outside the dedicated selection fixture window.'
}
$previous=[SelectionFixtureClick+Point]::new()
[SelectionFixtureClick]::GetCursorPos([ref]$previous) | Out-Null
try {
    [SelectionFixtureClick]::SetCursorPos($X,$Y) | Out-Null
    [SelectionFixtureClick]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
    [SelectionFixtureClick]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
} finally {
    [SelectionFixtureClick]::SetCursorPos($previous.x,$previous.y) | Out-Null
}
