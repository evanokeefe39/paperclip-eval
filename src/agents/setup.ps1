# Thin wrapper — all logic lives in setup.sh
$scriptDir = $PSScriptRoot -replace '\\', '/' -replace '^C:', '/mnt/c'
wsl bash -c "cd '$scriptDir' && ./setup.sh"
