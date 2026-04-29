$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$iconDir = Join-Path $PSScriptRoot "icons"

function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function Draw-CenteredText($g, [string]$text, [float]$x, [float]$y, [float]$w, [float]$h, $font, $brush) {
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF -ArgumentList $x, $y, $w, $h
  $g.DrawString($text, $font, $brush, $rect, $format)
  $format.Dispose()
}

function Save-HuIcon([int]$size, [string]$outFile, [bool]$disabled) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $g.Clear([System.Drawing.Color]::Transparent)

  if ($disabled) {
    $blue = [System.Drawing.Color]::FromArgb(255, 117, 124, 130)
    $blueDark = [System.Drawing.Color]::FromArgb(255, 80, 86, 92)
    $green = [System.Drawing.Color]::FromArgb(255, 142, 148, 153)
    $greenDark = [System.Drawing.Color]::FromArgb(255, 104, 110, 116)
    $panelFill = [System.Drawing.Color]::FromArgb(255, 245, 246, 247)
  } else {
    $blue = [System.Drawing.Color]::FromArgb(255, 17, 116, 201)
    $blueDark = [System.Drawing.Color]::FromArgb(255, 10, 56, 94)
    $green = [System.Drawing.Color]::FromArgb(255, 66, 180, 82)
    $greenDark = [System.Drawing.Color]::FromArgb(255, 35, 128, 48)
    $panelFill = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)
  }

  $scale = $size / 128.0
  $pad = 10 * $scale

  $panelPath = New-RoundedRectPath ([float]$pad) ([float]$pad) ([float]($size - 2 * $pad)) ([float]($size - 2 * $pad)) ([float](18 * $scale))
  $panelBrush = New-Object System.Drawing.SolidBrush($panelFill)
  $outlinePen = New-Object System.Drawing.Pen($blue, [float](5.5 * $scale))
  $g.FillPath($panelBrush, $panelPath)
  $g.DrawPath($outlinePen, $panelPath)

  $huBrush = New-Object System.Drawing.SolidBrush($blueDark)
  $fontSize = if ($size -le 16) { 7.6 } elseif ($size -le 32) { 15.2 } elseif ($size -le 48) { 22.6 } else { 58 }
  $font = New-Object System.Drawing.Font("Arial", [float]$fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  Draw-CenteredText $g "HU" ([float](7 * $scale)) ([float](24 * $scale)) ([float](80 * $scale)) ([float](58 * $scale)) $font $huBrush

  $badgeBrush = New-Object System.Drawing.SolidBrush($green)
  $badgePen = New-Object System.Drawing.Pen($greenDark, [float](5 * $scale))
  $badgeRect = New-Object System.Drawing.RectangleF -ArgumentList ([float](72 * $scale)), ([float](62 * $scale)), ([float](46 * $scale)), ([float](46 * $scale))
  $g.FillEllipse($badgeBrush, $badgeRect)
  $g.DrawEllipse($badgePen, $badgeRect)

  $checkPen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [float]([Math]::Max(7 * $scale, 1.6)))
  $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  [System.Drawing.PointF[]]$points = @(
    (New-Object System.Drawing.PointF -ArgumentList ([float](83 * $scale)), ([float](84 * $scale))),
    (New-Object System.Drawing.PointF -ArgumentList ([float](94 * $scale)), ([float](95 * $scale))),
    (New-Object System.Drawing.PointF -ArgumentList ([float](110 * $scale)), ([float](73 * $scale)))
  )
  $g.DrawLines($checkPen, $points)

  $counterBrush = New-Object System.Drawing.SolidBrush($blue)
  foreach ($barX in @(31, 44, 57)) {
    $bar = New-RoundedRectPath ([float]($barX * $scale)) ([float](87 * $scale)) ([float]([Math]::Max(4 * $scale, 1))) ([float](24 * $scale)) ([float](2 * $scale))
    $g.FillPath($counterBrush, $bar)
    $bar.Dispose()
  }

  $panelPath.Dispose()
  $panelBrush.Dispose()
  $outlinePen.Dispose()
  $huBrush.Dispose()
  $font.Dispose()
  $badgeBrush.Dispose()
  $badgePen.Dispose()
  $checkPen.Dispose()
  $counterBrush.Dispose()
  $g.Dispose()
  $bmp.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

foreach ($size in @(16, 32, 48, 128)) {
  Save-HuIcon $size (Join-Path $iconDir "icon-$size.png") $false
  Save-HuIcon $size (Join-Path $iconDir "icon-$size-disabled.png") $true
}

Save-HuIcon 512 (Join-Path $iconDir "icon-source.png") $false
Remove-Item (Join-Path $iconDir "test-gen.png") -ErrorAction SilentlyContinue
