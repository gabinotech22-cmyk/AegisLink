; AegisLink Windows Installer — NSIS script
; Run: makensis scripts\installer.nsi

Unicode True

!define APPNAME    "AegisLink"
!define APPVERSION "0.1.0"
!define PUBLISHER  "AegisLink"
!define APPEXE     "aegislink.exe"
!define INSTDIR_DEFAULT "$LOCALAPPDATA\${APPNAME}"

Name    "${APPNAME} ${APPVERSION}"
OutFile "..\out\make\AegisLinkInstaller.exe"
InstallDir "${INSTDIR_DEFAULT}"
InstallDirRegKey HKCU "Software\${APPNAME}" "InstallPath"
RequestExecutionLevel user   ; no UAC prompt — installs per-user
SetCompressor /SOLID lzma

; ── Pages ──────────────────────────────────────────────────────────────────────
!include "MUI2.nsh"
!define MUI_ICON "..\assets\icon.ico"
!define MUI_UNICON "..\assets\icon.ico"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; ── Install ────────────────────────────────────────────────────────────────────
Section "Install"
  SetOutPath "$INSTDIR"
  File /r "..\out\AegisLink-win32-x64\*.*"

  ; Shortcut on Desktop
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\${APPEXE}" 0

  ; Shortcut in Start Menu
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${APPEXE}" "" "$INSTDIR\${APPEXE}" 0
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall.lnk"  "$INSTDIR\Uninstall.exe"

  ; Registry: Add/Remove Programs entry
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayName"    "${APPNAME}"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayVersion" "${APPVERSION}"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "Publisher"      "${PUBLISHER}"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr   HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayIcon"    "$INSTDIR\${APPEXE}"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "NoModify"       1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "NoRepair"       1

  ; Save install path
  WriteRegStr HKCU "Software\${APPNAME}" "InstallPath" "$INSTDIR"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

; ── Uninstall ──────────────────────────────────────────────────────────────────
Section "Uninstall"
  RMDir /r "$INSTDIR"
  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
  DeleteRegKey HKCU "Software\${APPNAME}"
SectionEnd
