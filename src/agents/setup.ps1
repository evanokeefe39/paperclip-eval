# Thin wrapper — all logic lives in setup.sh
$scriptDir = $PSScriptRoot -replace '\\', '/' -replace '^C:', '/mnt/c'
$escapedArgs = $args | ForEach-Object { "'$_'" }
$argStr = $escapedArgs -join ' '
wsl bash -c "cd '$scriptDir' && ./setup.sh $argStr"
