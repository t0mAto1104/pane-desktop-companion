$ErrorActionPreference = 'Stop'
$native = Join-Path (Split-Path -Parent $PSScriptRoot) 'native/bin'
$cache = Join-Path $native 'whisper-cache'
$runtime = Join-Path $native 'whisper'
New-Item -ItemType Directory -Force $cache, $runtime | Out-Null

function Get-Sha256($file) {
    $stream = [IO.File]::OpenRead($file)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Get-Asset($file, $url, $sha256) {
    if (!(Test-Path -LiteralPath $file) -or (Get-Sha256 $file) -ne $sha256) {
        & curl.exe --fail --location --silent --show-error --retry 2 --output $file $url
        if ($LASTEXITCODE -ne 0) { throw "Could not download $url" }
    }
    if ((Get-Sha256 $file) -ne $sha256) { throw "SHA-256 mismatch for $file" }
}

$zip = Join-Path $cache 'whisper-b5454-x64.zip'
Get-Asset $zip 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip' '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
    foreach ($entry in $archive.Entries) {
        if ($entry.FullName -notmatch '^Release/(whisper-cli\.exe|whisper\.dll|ggml[a-z0-9-]*\.dll)$') { continue }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $runtime $entry.Name), $true)
    }
} finally { $archive.Dispose() }
Get-Asset (Join-Path $runtime 'silero-v6.2.0.bin') 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin?download=true' '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987'

$licenses = @{
    'whisper.cpp-LICENSE.txt' = 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/b5454/LICENSE'
    'silero-vad-LICENSE.txt' = 'https://raw.githubusercontent.com/snakers4/silero-vad/be95df9152c0d7618fa1edfeb296fc3dae32376f/LICENSE'
}
foreach ($license in $licenses.GetEnumerator()) {
    $file = Join-Path $runtime $license.Key
    if (!(Test-Path -LiteralPath $file)) {
        & curl.exe --fail --location --silent --show-error --output $file $license.Value
        if ($LASTEXITCODE -ne 0) { throw "Could not download $($license.Value)" }
    }
}
Write-Output 'Pinned whisper.cpp and Silero runtime prepared.'
