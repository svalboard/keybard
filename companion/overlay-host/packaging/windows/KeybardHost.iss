; Keybard Host installer (Inno Setup 6). Built by build.py, which passes the
; version and paths below. Installs per user: no administrator prompt.

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef NumericVersion
  #define NumericVersion "0.0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\..\..\build-windows\dist\Keybard Host"
#endif
#ifndef ParanoidFile
  #define ParanoidFile "..\..\..\..\dist-paranoid\keybard-paranoid.html"
#endif
#ifndef IconFile
  #define IconFile "..\..\keybard_host\assets\svalboard.ico"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\..\..\build-windows"
#endif

[Setup]
AppId={{9D3A0B6E-5C1F-4B7A-9E2D-8F4C6A1B3D57}
AppName=Keybard Host
AppVersion={#AppVersion}
AppVerName=Keybard Host {#AppVersion}
AppPublisher=Svalboard
AppPublisherURL=https://keybard.svalboard.com
AppSupportURL=https://github.com/svalboard/keybard
DefaultDirName={localappdata}\Programs\Keybard Host
DefaultGroupName=Keybard
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=KeybardHostSetup
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\Keybard Host.exe
UninstallDisplayName=Keybard Host
VersionInfoVersion={#NumericVersion}
VersionInfoProductName=Keybard Host
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
; Close a running Keybard Host before replacing or removing its files.
CloseApplications=force
RestartApplications=no
#ifdef Sign
; Signs the installer and its uninstaller with the command build.py passes as /Skeybard=.
SignTool=keybard
SignedUninstaller=yes
#endif

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked
Name: "startup"; Description: "Start Keybard Host when I sign in"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#ParanoidFile}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Keybard Host"; Filename: "{app}\Keybard Host.exe"; Comment: "Desktop overlay for Keybard's Trainer"
Name: "{group}\Keybard Host (Paranoid)"; Filename: "{app}\Keybard Host.exe"; Parameters: "--paranoid"; Comment: "Keybard Paranoid with the overlay; accepts no websites"
Name: "{group}\Keybard Paranoid (offline)"; Filename: "{app}\Keybard Host.exe"; Parameters: "--open-file ""{app}\keybard-paranoid.html"""; Comment: "Keybard as a local file in a contained browser, without the overlay"
Name: "{group}\Uninstall Keybard Host"; Filename: "{uninstallexe}"
Name: "{userdesktop}\Keybard Host"; Filename: "{app}\Keybard Host.exe"; Tasks: desktopicon
Name: "{userstartup}\Keybard Host"; Filename: "{app}\Keybard Host.exe"; Parameters: "--no-open"; Tasks: startup

[Run]
Filename: "{app}\Keybard Host.exe"; Description: "Start Keybard Host now"; Flags: nowait postinstall skipifsilent
