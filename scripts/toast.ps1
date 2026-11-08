# dsh-schedule-calendar - Windows desktop toast helper (Windows PowerShell 5.1).
# Ported from dsh-qq-mail/scripts/toast.ps1 (logic unchanged).
# Runs under powershell.exe -File. ASCII-only on purpose: Title/Body arrive as
# process arguments (UTF-16), so Chinese text is passed verbatim without file encoding issues.
#
# Uses WinRT ToastNotificationManager. AppId must be a REGISTERED AppUserModelID,
# otherwise Show() silently does nothing. DSH desktop registers "electron.app.DSH NEXT".
# If that fails we retry with the built-in Windows PowerShell AUMID as a fallback.

param(
  [string]$Title = "New mail",
  [string]$Body = "",
  [string]$AppId = "electron.app.DSH NEXT",
  [string]$SoundPath = "",
  [switch]$Sound
)

$ErrorActionPreference = "Stop"

function Show-Toast([string]$appId, [string]$title, [string]$body) {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $template.GetElementsByTagName("text")
  [void]$texts.Item(0).AppendChild($template.CreateTextNode($title))
  [void]$texts.Item(1).AppendChild($template.CreateTextNode($body))

  $toast = New-Object Windows.UI.Notifications.ToastNotification $template
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
  $notifier.Show($toast)
}

$ok = $false
try {
  Show-Toast $AppId $Title $Body
  $ok = $true
} catch {
  Write-Warning ("Primary AUMID failed: " + $_.Exception.Message)
}

if (-not $ok) {
  try {
    $fallback = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe"
    Show-Toast $fallback $Title $Body
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
