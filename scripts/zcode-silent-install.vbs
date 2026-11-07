' ZCode fork silent install wrapper (2026-11-07).
' Why: (1) schtasks + cmd leaves a dangling console window and NSIS /S shows
' no progress, so the user could not tell what stage the install was at;
' (2) a silent upgrade removes the previous desktop shortcut and NSIS /S does
' not recreate it (electron-builder assisted installer skips desktop icon
' tasks in silent mode). This wrapper runs GUI-only (wscript, no console),
' reports stages with native popups and self-heals the desktop shortcut.
' Usage: wscript.exe zcode-silent-install.vbs <installer.exe> <buildLabel>

Option Explicit
Dim args, shell, fso, installer, label, code, desktop, shortcut, target
Set args = WScript.Arguments
If args.Count < 2 Then
  MsgBox "Usage: wscript zcode-silent-install.vbs <installer.exe> <buildLabel>", 16, "ZCode install"
  WScript.Quit 2
End If
installer = args(0)
label = args(1)
target = "C:\Program Files\ZCode\ZCode.exe"

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Stage 1: announce. Auto-dismiss in 10 s so an unattended run never blocks.
shell.Popup "Installing ZCode " & label & "." & vbCrLf & vbCrLf & _
  "The app will close now; installation takes about a minute." & vbCrLf & _
  "This box closes itself in 10 seconds.", 10, "ZCode silent install", 64

' Stage 2: run the installer hidden (/S), wait for completion.
code = shell.Run("""" & installer & """ /S", 0, True)

' Stage 3: self-heal the desktop shortcut (silent upgrades remove it).
desktop = shell.SpecialFolders("Desktop")
shortcut = desktop & "\ZCode.lnk"
If code = 0 And fso.FileExists(target) Then
  Dim link
  Set link = shell.CreateShortcut(shortcut)
  link.TargetPath = target
  link.WorkingDirectory = "C:\Program Files\ZCode"
  link.IconLocation = target & ",0"
  link.Save
  shell.Popup "Done: build " & label & " installed." & vbCrLf & vbCrLf & _
    "Desktop shortcut verified. Launch ZCode from the desktop.", 30, "ZCode silent install", 64
Else
  shell.Popup "Installer exited with code " & code & "." & vbCrLf & _
    "Run the installer manually: " & installer, 0, "ZCode silent install", 48
End If
