$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$master = Join-Path $root 'assets/pane-logo.png'
$public = Join-Path $root 'src/renderer/public'

function Get-LogoBounds([Drawing.Bitmap]$image) {
    $left = $image.Width
    $top = $image.Height
    $right = -1
    $bottom = -1
    for ($y = 0; $y -lt $image.Height; $y++) {
        for ($x = 0; $x -lt $image.Width; $x++) {
            if ($image.GetPixel($x, $y).A -lt 224) { continue }
            $left = [Math]::Min($left, $x)
            $top = [Math]::Min($top, $y)
            $right = [Math]::Max($right, $x)
            $bottom = [Math]::Max($bottom, $y)
        }
    }
    if ($right -lt $left) { throw 'The source image needs a visible logo.' }
    $padding = 3
    $left = [Math]::Max(0, $left - $padding)
    $top = [Math]::Max(0, $top - $padding)
    $right = [Math]::Min($image.Width - 1, $right + $padding)
    $bottom = [Math]::Min($image.Height - 1, $bottom + $padding)
    return [Drawing.Rectangle]::new($left, $top, $right - $left + 1, $bottom - $top + 1)
}

function New-IconFrame([Drawing.Bitmap]$source, [Drawing.Rectangle]$bounds, [int]$size, [switch]$tray) {
    $bitmap = [Drawing.Bitmap]::new($size, $size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $stream = [IO.MemoryStream]::new()
    try {
        $graphics.Clear([Drawing.Color]::Transparent)
        $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $inset = 0.07
        if ($tray) {
            # Keep the indigo artwork readable against both Windows tray themes.
            $plate = [Drawing.Drawing2D.GraphicsPath]::new()
            $brush = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(255, 248, 245, 255))
            try {
                $edge = $size * 0.03
                $curve = $size * 0.34
                $far = $size - $edge - $curve
                $plate.AddArc($edge, $edge, $curve, $curve, 180, 90)
                $plate.AddArc($far, $edge, $curve, $curve, 270, 90)
                $plate.AddArc($far, $far, $curve, $curve, 0, 90)
                $plate.AddArc($edge, $far, $curve, $curve, 90, 90)
                $plate.CloseFigure()
                $graphics.FillPath($brush, $plate)
            } finally { $plate.Dispose(); $brush.Dispose() }
            $inset = 0.16
        }
        $scale = $size * (1 - 2 * $inset) / [Math]::Max($bounds.Width, $bounds.Height)
        $w = $bounds.Width * $scale
        $h = $bounds.Height * $scale
        $dest = [Drawing.RectangleF]::new(($size - $w) / 2, ($size - $h) / 2, $w, $h)
        $sourceRect = [Drawing.RectangleF]::new($bounds.X, $bounds.Y, $bounds.Width, $bounds.Height)
        $graphics.DrawImage($source, $dest, $sourceRect, [Drawing.GraphicsUnit]::Pixel)
        $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
        return ,$stream.ToArray()
    } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
}

$source = [Drawing.Bitmap]::new($master)
try {
    $bounds = Get-LogoBounds $source
    $sizes = @(16, 20, 24, 32, 40, 48, 64, 128, 256)
    $frames = @{}
    foreach ($size in $sizes) { $frames[$size] = New-IconFrame $source $bounds $size }
    [IO.File]::WriteAllBytes((Join-Path $public 'pane.png'), $frames[256])
    [IO.File]::WriteAllBytes((Join-Path $public 'pane-tray.png'), (New-IconFrame $source $bounds 64 -tray))

    $stream = [IO.MemoryStream]::new()
    $writer = [IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]$sizes.Count)
        $offset = 6 + 16 * $sizes.Count
        foreach ($size in $sizes) {
            $bytes = $frames[$size]
            $writer.Write([byte]($size % 256))
            $writer.Write([byte]($size % 256))
            $writer.Write([UInt16]0)
            $writer.Write([UInt16]1)
            $writer.Write([UInt16]32)
            $writer.Write([UInt32]$bytes.Length)
            $writer.Write([UInt32]$offset)
            $offset += $bytes.Length
        }
        foreach ($size in $sizes) { $writer.Write([byte[]]$frames[$size]) }
        [IO.File]::WriteAllBytes((Join-Path $root 'assets/pane.ico'), $stream.ToArray())
    } finally { $writer.Dispose(); $stream.Dispose() }
} finally { $source.Dispose() }
