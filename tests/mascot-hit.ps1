param([long]$Handle, [int]$X, [int]$Y)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PaneMascotTest {
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam,
        uint flags, uint milliseconds, out UIntPtr result);
}
'@
$point = [long](($X -band 0xFFFF) -bor (($Y -band 0xFFFF) -shl 16))
$result = [UIntPtr]::Zero
$ok = [PaneMascotTest]::SendMessageTimeout([IntPtr]::new($Handle), 0x84, [UIntPtr]::Zero,
    [IntPtr]::new($point), 2, 1000, [ref]$result)
if ($ok -eq [IntPtr]::Zero) { throw 'The dedicated mascot did not reply to the Win32 hit test.' }
$result.ToUInt64()
