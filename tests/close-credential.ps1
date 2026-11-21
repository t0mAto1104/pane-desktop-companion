$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PaneCredentialTest {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string name);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
$owner = [IntPtr]::new([Int64]$args[0])
for ($i = 0; $i -lt 80; $i++) {
    $dialog = [PaneCredentialTest]::FindWindow('#32770', $args[1])
    if ($dialog -ne [IntPtr]::Zero -and [PaneCredentialTest]::GetWindow($dialog, 4) -eq $owner) {
        if (![PaneCredentialTest]::PostMessage($dialog, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
            throw 'Could not dismiss the dedicated Windows credential prompt.'
        }
        exit 0
    }
    Start-Sleep -Milliseconds 100
}
throw 'The dedicated Windows credential prompt was not found.'
