param(
    [string]$ComposePath = (Join-Path $PSScriptRoot 'docker-compose.yml'),
    [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$BaseUrl = 'http://localhost:3100'
$Email = 'admin@eval.local'
$Pass = 'eval-admin-2026'
$ScriptDir = $PSScriptRoot

function Wait-Ready {
    param([int]$Timeout = 90)
    $end = (Get-Date).AddSeconds($Timeout)
    while ((Get-Date) -lt $end) {
        try {
            $r = Invoke-WebRequest -Uri "$BaseUrl/api/health" -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { return $true }
        } catch {}
        Start-Sleep -Seconds 2
    }
    return $false
}

# -- Start containers --
Write-Host 'Starting services...' -ForegroundColor Cyan
if ($SkipBuild) {
    docker compose -f $ComposePath up -d
} else {
    docker compose -f $ComposePath up -d --build
}
if ($LASTEXITCODE -ne 0) { Write-Host 'compose up failed' -ForegroundColor Red; exit 1 }

Write-Host 'Waiting for Paperclip...' -ForegroundColor Cyan
if (-not (Wait-Ready)) {
    Write-Host 'Paperclip not healthy after 90s' -ForegroundColor Red
    docker compose -f $ComposePath logs paperclip --tail 20
    exit 1
}
Write-Host 'Paperclip healthy.' -ForegroundColor Green

$ws = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$hdrs = @{ Origin = $BaseUrl }

# -- Sign up / sign in --
Write-Host 'Authenticating...' -ForegroundColor Cyan
$signup = @{ name = 'Eval Admin'; email = $Email; password = $Pass } | ConvertTo-Json
try {
    $null = Invoke-WebRequest -Uri "$BaseUrl/api/auth/sign-up/email" `
        -Method POST -ContentType 'application/json' -Body $signup `
        -WebSession $ws -UseBasicParsing -Headers $hdrs
} catch {
    $signin = @{ email = $Email; password = $Pass } | ConvertTo-Json
    $null = Invoke-WebRequest -Uri "$BaseUrl/api/auth/sign-in/email" `
        -Method POST -ContentType 'application/json' -Body $signin `
        -WebSession $ws -UseBasicParsing -Headers $hdrs
}
Write-Host '  OK.' -ForegroundColor Green

# -- Bootstrap invite via DB --
Write-Host 'Creating bootstrap invite...' -ForegroundColor Cyan
$pc = docker compose -f $ComposePath ps --format '{{.Name}}' 2>$null |
    Where-Object { $_ -match 'paperclip' } | Select-Object -First 1

docker cp (Join-Path $ScriptDir 'paperclip-config.json') "${pc}:/paperclip/instances/default/config.json" 2>$null
docker exec $pc chown node:node /paperclip/instances/default/config.json 2>$null
docker cp (Join-Path $ScriptDir 'bootstrap-invite.cjs') "${pc}:/tmp/bootstrap-invite.cjs"

$inviteUrl = docker exec $pc node /tmp/bootstrap-invite.cjs 2>&1
if ($inviteUrl -notmatch '/invite/') {
    Write-Host "Bootstrap failed: $inviteUrl" -ForegroundColor Red
    exit 1
}
$token = ($inviteUrl -split '/invite/')[1].Trim()
Write-Host "  Token: $token" -ForegroundColor Green

# -- Accept invite --
Write-Host 'Accepting invite...' -ForegroundColor Cyan
$null = Invoke-WebRequest -Uri "$BaseUrl/api/invites/$token/accept" `
    -Method POST -ContentType 'application/json' -Body '{"requestType":"human"}' `
    -WebSession $ws -UseBasicParsing -Headers $hdrs
Write-Host '  Admin bootstrapped.' -ForegroundColor Green

# -- Create company --
Write-Host 'Creating company...' -ForegroundColor Cyan
$r = Invoke-WebRequest -Uri "$BaseUrl/api/companies" -Method POST `
    -ContentType 'application/json' -Body '{"name":"eval"}' `
    -WebSession $ws -UseBasicParsing -Headers $hdrs
$cid = ($r.Content | ConvertFrom-Json).id
Write-Host "  Company: $cid" -ForegroundColor Green

# -- Register agents --
Write-Host 'Registering agents...' -ForegroundColor Cyan
$ceoJson = @{
    name='CEO'; role='ceo'; title='Chief Executive Officer'; icon='crown'
    capabilities='Strategic leadership, task prioritization, cross-agent coordination'
    adapterType='http'
    adapterConfig=@{ url='http://ceo:8080/invoke'; timeoutSec=300 }
    runtimeConfig=@{ heartbeat=@{ enabled=$false; wakeOnDemand=$true } }
} | ConvertTo-Json -Depth 5
$r = Invoke-WebRequest -Uri "$BaseUrl/api/companies/$cid/agent-hires" `
    -Method POST -ContentType 'application/json' -Body $ceoJson `
    -WebSession $ws -UseBasicParsing -Headers $hdrs
$ceoId = ($r.Content | ConvertFrom-Json).agent.id
Write-Host "  CEO: $ceoId" -ForegroundColor Green

$resJson = @{
    name='Researcher'; role='researcher'; title='Research Analyst'; icon='search'
    reportsTo=$ceoId
    capabilities='Information gathering, structured research, source analysis'
    adapterType='http'
    adapterConfig=@{ url='http://researcher:8080/invoke'; timeoutSec=300 }
    runtimeConfig=@{ heartbeat=@{ enabled=$false; wakeOnDemand=$true } }
} | ConvertTo-Json -Depth 5
$r = Invoke-WebRequest -Uri "$BaseUrl/api/companies/$cid/agent-hires" `
    -Method POST -ContentType 'application/json' -Body $resJson `
    -WebSession $ws -UseBasicParsing -Headers $hdrs
$resId = ($r.Content | ConvertFrom-Json).agent.id
Write-Host "  Researcher: $resId" -ForegroundColor Green

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host "  UI: $BaseUrl"
Write-Host "  Company: $cid"
Write-Host "  CEO: $ceoId"
Write-Host "  Researcher: $resId"
