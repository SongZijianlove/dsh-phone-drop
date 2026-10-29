<#
  dsh-phone-drop first-run settings dialog.

  Spawned by lib/setup.js. It owns the UI only: it collects three answers and
  writes them as JSON to -OutFile. It never touches the settings file itself,
  so a cancelled dialog leaves the previous state exactly as it was.

  Written for Windows PowerShell 5.1: the file MUST keep its UTF-8 BOM or the
  Chinese labels come out as mojibake. `-Sta` is required for WinForms.
#>
param(
    [Parameter(Mandatory = $true)][string]$OutFile,
    [string]$DefaultDir = '',
    [string]$DefaultShortcut = 'true',
    [string]$DefaultAutoOpen = 'true',
    [string]$Title = 'dsh-phone-drop 首次设置',
    [string]$ShortcutDir = '',
    [string]$Subtitle = '',
    [switch]$Silent
)

$ErrorActionPreference = 'Stop'

function Write-Result {
    param(
        [bool]$Cancelled,
        [string]$Dir,
        [bool]$Shortcut,
        [bool]$AutoOpen
    )
    $payload = [ordered]@{
        cancelled = $Cancelled
        dir       = $Dir
        shortcut  = $Shortcut
        autoOpen  = $AutoOpen
        at        = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        pid       = $PID
    }
    $json = $payload | ConvertTo-Json -Compress
    # UTF8Encoding($false): no BOM, so JSON.parse on the Node side sees `{` first.
    [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$shortcutWanted = ($DefaultShortcut -eq 'true')
$autoOpenWanted = ($DefaultAutoOpen -eq 'true')

# -Silent exists so the plumbing (JS -> PS -> JSON -> JS) can be tested without
# a desktop session, and so postinstall can degrade instead of hanging.
if ($Silent) {
    Write-Result -Cancelled $false -Dir $DefaultDir -Shortcut $shortcutWanted -AutoOpen $autoOpenWanted
    exit 0
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$fontBody = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$fontHead = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)
$fontNote = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.ClientSize = New-Object System.Drawing.Size(540, 336)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true
$form.TopMost = $true
$form.Font = $fontBody

$head = New-Object System.Windows.Forms.Label
$head.Text = '手机直传 · 先设三件事'
$head.Font = $fontHead
$head.AutoSize = $true
$head.Location = New-Object System.Drawing.Point(20, 16)
$form.Controls.Add($head)

$desc = New-Object System.Windows.Forms.Label
$desc.Text = if ($Subtitle -ne '') { $Subtitle } else {
    "装好了。下面三项决定它以后怎么用，随时可以改（运行 dsh-phone-drop --setup 再打开这个窗口）。"
}
$desc.AutoSize = $false
$desc.Size = New-Object System.Drawing.Size(500, 34)
$desc.Location = New-Object System.Drawing.Point(20, 46)
$desc.ForeColor = [System.Drawing.Color]::FromArgb(90, 90, 90)
$form.Controls.Add($desc)

# ---- 1. 保存位置 -----------------------------------------------------------
$lblDir = New-Object System.Windows.Forms.Label
$lblDir.Text = '1. 手机上拍的照片存到哪儿'
$lblDir.AutoSize = $true
$lblDir.Location = New-Object System.Drawing.Point(20, 92)
$form.Controls.Add($lblDir)

$txtDir = New-Object System.Windows.Forms.TextBox
$txtDir.Text = $DefaultDir
$txtDir.Location = New-Object System.Drawing.Point(20, 114)
$txtDir.Size = New-Object System.Drawing.Size(400, 24)
$form.Controls.Add($txtDir)

$btnBrowse = New-Object System.Windows.Forms.Button
$btnBrowse.Text = '浏览...'
$btnBrowse.Location = New-Object System.Drawing.Point(430, 113)
$btnBrowse.Size = New-Object System.Drawing.Size(90, 26)
$btnBrowse.Add_Click({
    $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
    $dlg.Description = '选择手机照片保存的文件夹'
    $dlg.ShowNewFolderButton = $true
    if ($txtDir.Text -ne '' -and (Test-Path -LiteralPath $txtDir.Text)) {
        $dlg.SelectedPath = $txtDir.Text
    }
    if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        $txtDir.Text = $dlg.SelectedPath
    }
    $dlg.Dispose()
})
$form.Controls.Add($btnBrowse)

# ---- 2. 快捷方式 -----------------------------------------------------------
$chkShortcut = New-Object System.Windows.Forms.CheckBox
$chkShortcut.Text = '2. 在桌面创建「手机直传」快捷方式'
$chkShortcut.AutoSize = $true
$chkShortcut.Location = New-Object System.Drawing.Point(20, 154)
$chkShortcut.Checked = $shortcutWanted
$form.Controls.Add($chkShortcut)

$lblShortcut = New-Object System.Windows.Forms.Label
$lblShortcut.Text = if ($ShortcutDir -ne '') { "   建在：$ShortcutDir" } else { '   建在当前用户的桌面上' }
$lblShortcut.AutoSize = $true
$lblShortcut.Font = $fontNote
$lblShortcut.ForeColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
$lblShortcut.Location = New-Object System.Drawing.Point(38, 176)
$form.Controls.Add($lblShortcut)

# ---- 3. 自动打开 -----------------------------------------------------------
$chkAutoOpen = New-Object System.Windows.Forms.CheckBox
$chkAutoOpen.Text = '3. 装完立刻打开一次二维码页面'
$chkAutoOpen.AutoSize = $true
$chkAutoOpen.Location = New-Object System.Drawing.Point(20, 208)
$chkAutoOpen.Checked = $autoOpenWanted
$form.Controls.Add($chkAutoOpen)

$lblAutoOpen = New-Object System.Windows.Forms.Label
$lblAutoOpen.Text = '   只这一次。以后要传图，双击快捷方式或在命令行运行 dsh-phone-drop --open'
$lblAutoOpen.AutoSize = $true
$lblAutoOpen.Font = $fontNote
$lblAutoOpen.ForeColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
$lblAutoOpen.Location = New-Object System.Drawing.Point(38, 230)
$form.Controls.Add($lblAutoOpen)

$lblHint = New-Object System.Windows.Forms.Label
$lblHint.Text = '提示：手机和电脑要连同一个 Wi-Fi；首次运行时 Windows 防火墙会问一次，选「允许访问」。'
$lblHint.AutoSize = $false
$lblHint.Size = New-Object System.Drawing.Size(500, 32)
$lblHint.Font = $fontNote
$lblHint.ForeColor = [System.Drawing.Color]::FromArgb(120, 120, 120)
$lblHint.Location = New-Object System.Drawing.Point(20, 258)
$form.Controls.Add($lblHint)

$btnOk = New-Object System.Windows.Forms.Button
$btnOk.Text = '就这样'
$btnOk.Location = New-Object System.Drawing.Point(330, 296)
$btnOk.Size = New-Object System.Drawing.Size(90, 28)
$btnOk.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($btnOk)

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = '跳过'
$btnCancel.Location = New-Object System.Drawing.Point(430, 296)
$btnCancel.Size = New-Object System.Drawing.Size(90, 28)
$btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($btnCancel)

$form.AcceptButton = $btnOk
$form.CancelButton = $btnCancel

$result = $form.ShowDialog()

if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    $chosen = $txtDir.Text.Trim()
    if ($chosen -eq '') { $chosen = $DefaultDir }
    Write-Result -Cancelled $false -Dir $chosen -Shortcut $chkShortcut.Checked -AutoOpen $chkAutoOpen.Checked
}
else {
    Write-Result -Cancelled $true -Dir $DefaultDir -Shortcut $false -AutoOpen $false
}

$form.Dispose()
exit 0
