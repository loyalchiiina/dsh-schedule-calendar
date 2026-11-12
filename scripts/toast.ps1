# dsh-schedule-calendar - Windows desktop toast / capsule helper (Windows PowerShell 5.1).
# Ported from dsh-qq-mail/scripts/toast.ps1 (toast logic unchanged), extended with a
# self-drawn "capsule" window so the on-screen dwell time can be set in seconds.
#
# Two display modes:
#   -Seconds 0        : WinRT toast (enters the Action Center, ~7s on screen).
#   -Seconds >= 3     : WPF capsule, bottom-right, topmost, rounded, fades in, stays
#                       exactly N seconds, fades out, click anywhere to dismiss.
#                       3 is the floor on purpose (anything shorter is unreadable).
#                       If WPF fails for any reason, it falls back to the WinRT toast.
#
# ASCII-only on purpose: Title/Body arrive as process arguments (UTF-16), so Chinese
# text is passed verbatim without file encoding issues. Do not put CJK literals here.

param(
  [string]$Title = "New mail",
  [string]$Body = "",
  [string]$AppId = "electron.app.DSH NEXT",
  [string]$SoundPath = "",
  [int]$Seconds = 0,
  [switch]$Sound
)

$ErrorActionPreference = "Stop"

function Show-SystemToast([string]$appId, [string]$title, [string]$body, [string]$duration) {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  if ($duration) {
    try { [void]$template.DocumentElement.SetAttribute("duration", $duration) } catch { }
  }
  $texts = $template.GetElementsByTagName("text")
  [void]$texts.Item(0).AppendChild($template.CreateTextNode($title))
  [void]$texts.Item(1).AppendChild($template.CreateTextNode($body))

  $toast = New-Object Windows.UI.Notifications.ToastNotification $template
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
  $notifier.Show($toast)
}

function New-Brush([int]$a, [int]$r, [int]$g, [int]$b) {
  return New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb($a, $r, $g, $b))
}

function Show-Capsule([string]$title, [string]$body, [int]$seconds) {
  Add-Type -AssemblyName PresentationFramework
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName WindowsBase

  $wa = [System.Windows.SystemParameters]::WorkArea

  $win = New-Object System.Windows.Window
  $win.WindowStyle = [System.Windows.WindowStyle]::None
  $win.ResizeMode = [System.Windows.ResizeMode]::NoResize
  $win.AllowsTransparency = $true
  $win.Background = [System.Windows.Media.Brushes]::Transparent
  $win.Topmost = $true
  $win.ShowInTaskbar = $false
  $win.ShowActivated = $false
  $win.Width = 372
  $win.SizeToContent = [System.Windows.SizeToContent]::Height
  $win.Opacity = 0

  $border = New-Object System.Windows.Controls.Border
  $border.CornerRadius = New-Object System.Windows.CornerRadius(14)
  $border.Background = New-Brush 250 22 28 42
  $border.BorderBrush = New-Brush 46 255 255 255
  $border.BorderThickness = New-Object System.Windows.Thickness(1)
  $border.Padding = New-Object System.Windows.Thickness(16, 12, 16, 13)
  $border.Cursor = [System.Windows.Input.Cursors]::Hand

  $shadow = New-Object System.Windows.Media.Effects.DropShadowEffect
  $shadow.BlurRadius = 26
  $shadow.Opacity = 0.36
  $shadow.ShadowDepth = 6
  $shadow.Direction = 270
  $shadow.Color = [System.Windows.Media.Colors]::Black
  $border.Effect = $shadow

  $stack = New-Object System.Windows.Controls.StackPanel

  $txtTitle = New-Object System.Windows.Controls.TextBlock
  $txtTitle.Text = $title
  $txtTitle.FontFamily = New-Object System.Windows.Media.FontFamily("Microsoft YaHei UI")
  $txtTitle.FontSize = 14
  $txtTitle.FontWeight = [System.Windows.FontWeights]::SemiBold
  $txtTitle.Foreground = New-Brush 255 255 255 255
  $txtTitle.TextWrapping = [System.Windows.TextWrapping]::Wrap
  $txtTitle.Margin = New-Object System.Windows.Thickness(0, 0, 0, 4)
  [void]$stack.Children.Add($txtTitle)

  $txtBody = New-Object System.Windows.Controls.TextBlock
  $txtBody.Text = $body
  $txtBody.FontFamily = New-Object System.Windows.Media.FontFamily("Microsoft YaHei UI")
  $txtBody.FontSize = 12
  $txtBody.Foreground = New-Brush 255 214 224 247
  $txtBody.TextWrapping = [System.Windows.TextWrapping]::Wrap
  $txtBody.LineHeight = 18
  $txtBody.MaxHeight = 108
  $txtBody.TextTrimming = [System.Windows.TextTrimming]::CharacterEllipsis
  if ($body) { [void]$stack.Children.Add($txtBody) }

  $border.Child = $stack
  $win.Content = $border

  # position: bottom-right of the work area (above the taskbar)
  $win.add_Loaded({
    $h = $win.ActualHeight
    if (-not $h -or $h -lt 40) { $h = 96 }
    $win.Left = $wa.Right - $win.Width - 26
    $win.Top = $wa.Bottom - $h - 26
    $fadeIn = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, 1.0, (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(220))))
    $win.BeginAnimation([System.Windows.Window]::OpacityProperty, $fadeIn)
  })

  $dismiss = {
    try {
      $fadeOut = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.0, (New-Object System.Windows.Duration([TimeSpan]::FromMilliseconds(320))))
      $fadeOut.Add_Completed({ try { $win.Close() } catch { } })
      $win.BeginAnimation([System.Windows.Window]::OpacityProperty, $fadeOut)
    } catch {
      try { $win.Close() } catch { }
    }
  }

  $border.Add_MouseLeftButtonUp({ & $dismiss })

  $timer = New-Object System.Windows.Threading.DispatcherTimer
  $timer.Interval = [TimeSpan]::FromSeconds($seconds)
  $timer.add_Tick({ $timer.Stop(); & $dismiss })
  $win.add_Loaded({ $timer.Start() })

  [void]$win.ShowDialog()
}

$useCapsule = ($Seconds -ge 3)
$ok = $false

if ($useCapsule) {
  try {
    Show-Capsule $Title $Body ([Math]::Min(60, $Seconds))
    $ok = $true
  } catch {
    Write-Warning ("Capsule failed, falling back to system toast: " + $_.Exception.Message)
  }
}

if (-not $ok) {
  try {
    Show-SystemToast $AppId $Title $Body ""
    $ok = $true
  } catch {
    Write-Warning ("Primary AUMID failed: " + $_.Exception.Message)
  }
}

if (-not $ok) {
  try {
    $fallback = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    Show-SystemToast $fallback $Title $Body ""
    $ok = $true
  } catch {
    Write-Error ("Toast failed: " + $_.Exception.Message)
    exit 1
  }
}

if ($Sound) {
  try {
    if ($SoundPath -and (Test-Path -LiteralPath $SoundPath)) {
      $player = New-Object System.Media.SoundPlayer $SoundPath
      $player.Play()
    } else {
      [System.Media.SystemSounds]::Notification.Play()
    }
  } catch {
    # sound is best-effort; never fail the toast because of it
  }
}

exit 0