# CI only (disposable Windows runners): makes the container-free SSH lab possible.
#  - installs the Windows OpenSSH Server capability if sshd.exe is missing;
#  - sets OpenSSH's DefaultShell to Git Bash so lab fixtures run the same POSIX commands as on
#    macOS and Linux;
#  - disables the stock sshd service so only the lab's own loopback services listen.
$ErrorActionPreference = 'Stop'
$sshd = 'C:\Windows\System32\OpenSSH\sshd.exe'
if (-not (Test-Path $sshd)) {
  $cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*' | Select-Object -First 1
  Add-WindowsCapability -Online -Name $cap.Name | Out-Null
}
if (Get-Service sshd -ErrorAction SilentlyContinue) {
  Stop-Service sshd -ErrorAction SilentlyContinue
  Set-Service sshd -StartupType Disabled
}
$bash = 'C:\Program Files\Git\bin\bash.exe'
if (-not (Test-Path $bash)) { throw "Git Bash not found at $bash" }
New-Item -Path 'HKLM:\SOFTWARE\OpenSSH' -Force | Out-Null
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -Value $bash -PropertyType String -Force | Out-Null
& $sshd -V 2>&1 | Write-Output
