param(
    [ValidateSet(1, 2, 3)]
    [int]$Tier
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:TestResults = @()
$script:TotalPassed = 0
$script:TotalFailed = 0
$script:TotalSkipped = 0
$script:OverallTimer = [System.Diagnostics.Stopwatch]::StartNew()
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:ComposePath = Join-Path $script:RepoRoot "src\agents\docker-compose.yml"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-TestResult {
    param(
        [string]$TestId,
        [string]$Name,
        [string]$Status,  # PASS, FAIL, SKIP
        [double]$DurationSec
    )
    $color = switch ($Status) {
        "PASS" { "Green" }
        "FAIL" { "Red" }
        "SKIP" { "Yellow" }
    }
    $formatted = "{0:N1}s" -f $DurationSec
    Write-Host "  [$Status] $TestId $Name ($formatted)" -ForegroundColor $color
    $script:TestResults += [PSCustomObject]@{
        TestId   = $TestId
        Name     = $Name
        Status   = $Status
        Duration = $DurationSec
    }
    switch ($Status) {
        "PASS" { $script:TotalPassed++ }
        "FAIL" { $script:TotalFailed++ }
        "SKIP" { $script:TotalSkipped++ }
    }
}

function Assert-Prerequisite {
    param([string]$Command)
    $found = Get-Command $Command -ErrorAction SilentlyContinue
    if (-not $found) {
        Write-Host "[FATAL] Prerequisite not found: $Command" -ForegroundColor Red
        exit 1
    }
}

function Wait-ForHealth {
    param(
        [string]$Url,
        [int]$TimeoutSec = 60,
        [int]$IntervalSec = 2
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -Method GET -UseBasicParsing -TimeoutSec 5
            if ($r.StatusCode -eq 200) { return $true }
        } catch {
            # not ready yet
        }
        Start-Sleep -Seconds $IntervalSec
    }
    return $false
}

function Get-ContainerMemoryMB {
    param([string]$ContainerName)
    $stats = docker stats $ContainerName --no-stream --format "{{.MemUsage}}" 2>$null
    if (-not $stats) { return 0 }
    # Format is like "45.3MiB / 512MiB" or "1.2GiB / 512MiB"
    $usage = ($stats -split "/")[0].Trim()
    if ($usage -match "([\d.]+)\s*GiB") {
        return [double]$Matches[1] * 1024
    }
    if ($usage -match "([\d.]+)\s*MiB") {
        return [double]$Matches[1]
    }
    if ($usage -match "([\d.]+)\s*KiB") {
        return [double]$Matches[1] / 1024
    }
    return 0
}

function Get-CeoContainerName {
    $name = docker compose -f $script:ComposePath ps --format "{{.Name}}" 2>$null |
        Where-Object { $_ -match "ceo" } |
        Select-Object -First 1
    if (-not $name) { $name = "agents-ceo-1" }
    return $name
}

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "Checking prerequisites..." -ForegroundColor Cyan

$alwaysRequired = @("hurl", "docker")
$tier3Only = @("k6")

foreach ($p in $alwaysRequired) {
    Assert-Prerequisite $p
}

$tiersRequested = if ($Tier) { @($Tier) } else { @(1, 2, 3) }
if ($tiersRequested -contains 3) {
    foreach ($p in $tier3Only) {
        Assert-Prerequisite $p
    }
} else {
    foreach ($p in $tier3Only) {
        $found = Get-Command $p -ErrorAction SilentlyContinue
        if (-not $found) {
            Write-Host "  [WARN] $p not found - needed for Tier 3 only" -ForegroundColor Yellow
        }
    }
}

# jq is optional - only needed if we add JSON post-processing later
$jqAvailable = $null -ne (Get-Command "jq" -ErrorAction SilentlyContinue)
if (-not $jqAvailable) {
    Write-Host "  [WARN] jq not found - some JSON post-processing may be skipped" -ForegroundColor Yellow
}

Write-Host "  All required prerequisites found." -ForegroundColor Green

# ---------------------------------------------------------------------------
# Build and start containers
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "Building and starting containers..." -ForegroundColor Cyan

docker compose -f $script:ComposePath up -d --build
if ($LASTEXITCODE -ne 0) {
    Write-Host "[FATAL] docker compose up failed (exit code $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}

Write-Host "  Waiting for healthchecks..." -ForegroundColor Cyan

$healthy8081 = Wait-ForHealth -Url "http://localhost:8081/health" -TimeoutSec 60
$healthy8082 = Wait-ForHealth -Url "http://localhost:8082/health" -TimeoutSec 60

if (-not $healthy8081) {
    Write-Host "[FATAL] Agent on :8081 did not become healthy within 60s" -ForegroundColor Red
    exit 1
}
if (-not $healthy8082) {
    Write-Host "[FATAL] Agent on :8082 did not become healthy within 60s" -ForegroundColor Red
    exit 1
}

Write-Host "  Both agents healthy." -ForegroundColor Green

# ---------------------------------------------------------------------------
# TIER 1 - Foundation
# ---------------------------------------------------------------------------

function Run-Tier1 {
    Write-Host ""
    Write-Host "[TIER 1] Foundation" -ForegroundColor White

    $hurlFile = Join-Path $script:RepoRoot "tests\hurl\tier1-foundation.hurl"
    if (-not (Test-Path $hurlFile)) {
        Write-Host "  [SKIP] Hurl file not found: $hurlFile" -ForegroundColor Yellow
        Write-TestResult -TestId "1.x" -Name "Tier 1 hurl suite" -Status "SKIP" -DurationSec 0
        return $true
    }

    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $savedEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & hurl --test --file-root $script:RepoRoot $hurlFile 2>&1
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedEAP
    $timer.Stop()

    if ($exitCode -eq 0) {
        $testNames = @(
            @{ Id = "1.1"; Name = "Container health" },
            @{ Id = "1.2"; Name = "Bridge responds" },
            @{ Id = "1.3"; Name = "Round-trip echo" },
            @{ Id = "1.4"; Name = "Unknown routes 404" },
            @{ Id = "1.5"; Name = "Metrics endpoint" }
        )
        $perTest = $timer.Elapsed.TotalSeconds / $testNames.Count
        foreach ($t in $testNames) {
            Write-TestResult -TestId $t.Id -Name $t.Name -Status "PASS" -DurationSec $perTest
        }
        return $true
    } else {
        Write-Host ($output -join "`n") -ForegroundColor Red
        Write-TestResult -TestId "1.x" -Name "Tier 1 hurl suite" -Status "FAIL" -DurationSec $timer.Elapsed.TotalSeconds
        return $false
    }
}

# ---------------------------------------------------------------------------
# TIER 2 - Contract Correctness
# ---------------------------------------------------------------------------

function Run-Tier2 {
    Write-Host ""
    Write-Host "[TIER 2] Contract Correctness" -ForegroundColor White

    # --- Hurl contract tests ---
    $hurlFile = Join-Path $script:RepoRoot "tests\hurl\tier2-contracts.hurl"
    $tier2HurlPassed = $true

    if (-not (Test-Path $hurlFile)) {
        Write-Host "  [SKIP] Hurl file not found: $hurlFile" -ForegroundColor Yellow
        Write-TestResult -TestId "2.x" -Name "Tier 2 hurl suite" -Status "SKIP" -DurationSec 0
    } else {
        $timer = [System.Diagnostics.Stopwatch]::StartNew()
        $savedEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $output = & hurl --test --file-root $script:RepoRoot $hurlFile 2>&1
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $savedEAP
        $timer.Stop()

        if ($exitCode -eq 0) {
            $testNames = @(
                @{ Id = "2.1"; Name = "Wake payload acceptance" },
                @{ Id = "2.2"; Name = "Large payload (bypass pi_local limit)" },
                @{ Id = "2.3"; Name = "Malformed JSON rejected" },
                @{ Id = "2.4"; Name = "Empty body rejected" },
                @{ Id = "2.5"; Name = "System prompt passthrough" },
                @{ Id = "2.7"; Name = "Protocol events structure" }
            )
            $perTest = $timer.Elapsed.TotalSeconds / $testNames.Count
            foreach ($t in $testNames) {
                Write-TestResult -TestId $t.Id -Name $t.Name -Status "PASS" -DurationSec $perTest
            }
        } else {
            Write-Host ($output -join "`n") -ForegroundColor Red
            Write-TestResult -TestId "2.x" -Name "Tier 2 hurl suite" -Status "FAIL" -DurationSec $timer.Elapsed.TotalSeconds
            $tier2HurlPassed = $false
        }
    }

    if (-not $tier2HurlPassed) { return $false }

    # --- Test 2.6: Concurrent agents (inline) ---
    $timer = [System.Diagnostics.Stopwatch]::StartNew()

    $alphaBody = '{"prompt": "Your secret word is ALPHA. State it."}'
    $betaBody  = '{"prompt": "Your secret word is BETA. State it."}'

    $alphaJob = Start-Job -ScriptBlock {
        param($body)
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:8081/invoke" `
                -Method POST -Body $body `
                -ContentType "application/json" `
                -UseBasicParsing -TimeoutSec 120
            return @{ StatusCode = $r.StatusCode; Body = $r.Content }
        } catch {
            return @{ StatusCode = 0; Body = $_.Exception.Message }
        }
    } -ArgumentList $alphaBody

    $betaJob = Start-Job -ScriptBlock {
        param($body)
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:8082/invoke" `
                -Method POST -Body $body `
                -ContentType "application/json" `
                -UseBasicParsing -TimeoutSec 120
            return @{ StatusCode = $r.StatusCode; Body = $r.Content }
        } catch {
            return @{ StatusCode = 0; Body = $_.Exception.Message }
        }
    } -ArgumentList $betaBody

    $null = Wait-Job $alphaJob, $betaJob -Timeout 130
    $alphaResult = Receive-Job $alphaJob
    $betaResult  = Receive-Job $betaJob
    Remove-Job $alphaJob, $betaJob -Force

    $timer.Stop()

    $passed = $true
    # Parse outputs
    $alphaOutput = ""
    $betaOutput  = ""
    try {
        $alphaOutput = ($alphaResult.Body | ConvertFrom-Json).output
    } catch {
        $alphaOutput = [string]$alphaResult.Body
    }
    try {
        $betaOutput = ($betaResult.Body | ConvertFrom-Json).output
    } catch {
        $betaOutput = [string]$betaResult.Body
    }

    if ($alphaOutput -notmatch "ALPHA") {
        Write-Host "    Agent :8081 did not contain ALPHA in output" -ForegroundColor Red
        $passed = $false
    }
    if ($alphaOutput -match "BETA") {
        Write-Host "    Agent :8081 leaked BETA into output" -ForegroundColor Red
        $passed = $false
    }
    if ($betaOutput -notmatch "BETA") {
        Write-Host "    Agent :8082 did not contain BETA in output" -ForegroundColor Red
        $passed = $false
    }
    if ($betaOutput -match "ALPHA") {
        Write-Host "    Agent :8082 leaked ALPHA into output" -ForegroundColor Red
        $passed = $false
    }

    if ($passed) {
        Write-TestResult -TestId "2.6" -Name "Concurrent agents isolated" -Status "PASS" -DurationSec $timer.Elapsed.TotalSeconds
    } else {
        Write-TestResult -TestId "2.6" -Name "Concurrent agents isolated" -Status "FAIL" -DurationSec $timer.Elapsed.TotalSeconds
    }

    return $passed
}

# ---------------------------------------------------------------------------
# TIER 3 - Load & Resilience
# ---------------------------------------------------------------------------

function Run-Tier3 {
    Write-Host ""
    Write-Host "[TIER 3] Load & Resilience" -ForegroundColor White

    $allPassed = $true

    # --- Test 3.1: k6 load test ---
    $loadTestFile = Join-Path $script:RepoRoot "tests\k6\load-test.js"
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $savedEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & k6 run $loadTestFile 2>&1 | Out-Null
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedEAP
    $timer.Stop()

    if ($exitCode -eq 0) {
        Write-TestResult -TestId "3.1a" -Name "k6 load test (50 iterations)" -Status "PASS" -DurationSec $timer.Elapsed.TotalSeconds
    } else {
        Write-TestResult -TestId "3.1a" -Name "k6 load test (50 iterations)" -Status "FAIL" -DurationSec $timer.Elapsed.TotalSeconds
        $allPassed = $false
    }

    # --- Test 3.1b: k6 timeout test ---
    $timeoutTestFile = Join-Path $script:RepoRoot "tests\k6\timeout-test.js"
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $savedEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & k6 run $timeoutTestFile 2>&1 | Out-Null
    $exitCode = $LASTEXITCODE
    $ErrorActionPreference = $savedEAP
    $timer.Stop()

    if ($exitCode -eq 0) {
        Write-TestResult -TestId "3.1b" -Name "k6 timeout behavior" -Status "PASS" -DurationSec $timer.Elapsed.TotalSeconds
    } else {
        Write-TestResult -TestId "3.1b" -Name "k6 timeout behavior" -Status "FAIL" -DurationSec $timer.Elapsed.TotalSeconds
        $allPassed = $false
    }

    # --- Test 3.2: Pi crash recovery ---
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $ceoContainer = Get-CeoContainerName
    $test32Passed = $true

    # Fire a request in background, then kill pi mid-flight
    $bgJob = Start-Job -ScriptBlock {
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:8081/invoke" `
                -Method POST -Body '{"prompt": "Count to 100 slowly."}' `
                -ContentType "application/json" `
                -UseBasicParsing -TimeoutSec 30
            return @{ StatusCode = $r.StatusCode; Body = $r.Content }
        } catch {
            $status = 0
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            return @{ StatusCode = $status; Body = $_.Exception.Message }
        }
    }

    # Give the request a moment to start, then kill pi inside the container
    Start-Sleep -Seconds 2
    docker exec $ceoContainer pkill -f "pi --mode rpc" 2>$null

    $null = Wait-Job $bgJob -Timeout 35
    $crashResult = Receive-Job $bgJob
    Remove-Job $bgJob -Force

    # The request should return an error (500 or similar), not hang
    if ($crashResult.StatusCode -eq 0 -and $crashResult.Body -match "timeout") {
        Write-Host "    Request hung after pi crash (timeout)" -ForegroundColor Red
        $test32Passed = $false
    }

    # Now send a new request - the bridge should recover (container restarts pi per request)
    Start-Sleep -Seconds 3
    try {
        $recovery = Invoke-WebRequest -Uri "http://localhost:8081/invoke" `
            -Method POST -Body '{"prompt": "Say RECOVERED."}' `
            -ContentType "application/json" `
            -UseBasicParsing -TimeoutSec 120
        if ($recovery.StatusCode -ne 200) {
            Write-Host "    Recovery request did not return 200" -ForegroundColor Red
            $test32Passed = $false
        }
    } catch {
        Write-Host "    Recovery request failed: $($_.Exception.Message)" -ForegroundColor Red
        $test32Passed = $false
    }

    $timer.Stop()
    if ($test32Passed) {
        Write-TestResult -TestId "3.2" -Name "Pi crash recovery" -Status "PASS" -DurationSec $timer.Elapsed.TotalSeconds
    } else {
        Write-TestResult -TestId "3.2" -Name "Pi crash recovery" -Status "FAIL" -DurationSec $timer.Elapsed.TotalSeconds
        $allPassed = $false
    }

    # --- Test 3.3: Container restart ---
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $test33Passed = $true

    docker restart $ceoContainer 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "    docker restart failed" -ForegroundColor Red
        $test33Passed = $false
    }

    # Wait for healthcheck to pass again
    $healthOk = Wait-ForHealth -Url "http://localhost:8081/health" -TimeoutSec 30
    if (-not $healthOk) {
        Write-Host "    Container did not become healthy within 30s after restart" -ForegroundColor Red
        $test33Passed = $false
    }

    if ($test33Passed) {
        try {
            $r = Invoke-WebRequest -Uri "http://localhost:8081/invoke" `
                -Method POST -Body '{"prompt": "Say RESTARTED."}' `
                -ContentType "application/json" `
                -UseBasicParsing -TimeoutSec 120
            if ($r.StatusCode -ne 200) {
                Write-Host "    Post-restart request did not return 200" -ForegroundColor Red
                $test33Passed = $false
            }
        } catch {
            Write-Host "    Post-restart request failed: $($_.Exception.Message)" -ForegroundColor Red
            $test33Passed = $false
        }
    }

    $timer.Stop()
    if ($test33Passed) {
        Write-TestResult -TestId "3.3" -Name "Container restart recovery" -Status "PASS" -DurationSec $timer.Elapsed.TotalSeconds
    } else {
        Write-TestResult -TestId "3.3" -Name "Container restart recovery" -Status "FAIL" -DurationSec $timer.Elapsed.TotalSeconds
        $allPassed = $false
    }

    # --- Test 3.4: Memory stability ---
    $timer = [System.Diagnostics.Stopwatch]::StartNew()
    $test34Passed = $true

    # Wait for container to settle after restart
    $null = Wait-ForHealth -Url "http://localhost:8081/health" -TimeoutSec 30

    $memBefore = Get-ContainerMemoryMB -ContainerName $ceoContainer
    if ($memBefore -eq 0) {
        Write-Host "    Could not read container memory before load test" -ForegroundColor Yellow
        Write-TestResult -TestId "3.4" -Name "Memory stability (<100MB growth)" -Status "SKIP" -DurationSec 0
    } else {
        # Run k6 load test
        $savedEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        & k6 run $loadTestFile 2>&1 | Out-Null
        $ErrorActionPreference = $savedEAP

        Start-Sleep -Seconds 2
        $memAfter = Get-ContainerMemoryMB -ContainerName $ceoContainer
        $memGrowth = $memAfter - $memBefore

        if ($memGrowth -ge 100) {
            Write-Host ("    Memory grew {0:N1}MB ({1:N1}MB -> {2:N1}MB), threshold 100MB" -f $memGrowth, $memBefore, $memAfter) -ForegroundColor Red
            $test34Passed = $false
        }

        $timer.Stop()
        if ($test34Passed) {
            Write-TestResult -TestId "3.4" -Name "Memory stability (<100MB growth)" -Status "PASS" -DurationSec $timer.Elapsed.TotalSeconds
        } else {
            Write-TestResult -TestId "3.4" -Name "Memory stability (<100MB growth)" -Status "FAIL" -DurationSec $timer.Elapsed.TotalSeconds
            $allPassed = $false
        }
    }

    return $allPassed
}

# ---------------------------------------------------------------------------
# Main execution
# ---------------------------------------------------------------------------

$tiersToRun = if ($Tier) { @($Tier) } else { @(1, 2, 3) }
$failFast = $false

foreach ($t in $tiersToRun) {
    if ($failFast) { break }

    $passed = switch ($t) {
        1 { Run-Tier1 }
        2 { Run-Tier2 }
        3 { Run-Tier3 }
    }

    if (-not $passed) { $failFast = $true }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

$script:OverallTimer.Stop()
$totalTests = $script:TotalPassed + $script:TotalFailed + $script:TotalSkipped
$totalTime = $script:OverallTimer.Elapsed

Write-Host ""
Write-Host ("-" * 50)

$summaryColor = if ($script:TotalFailed -eq 0) { "Green" } else { "Red" }
$timeFormatted = "{0}m {1:N0}s" -f [math]::Floor($totalTime.TotalMinutes), ($totalTime.TotalSeconds % 60)

Write-Host ("Results: {0}/{1} passed, {2} failed, {3} skipped" -f `
    $script:TotalPassed, $totalTests, $script:TotalFailed, $script:TotalSkipped) -ForegroundColor $summaryColor
Write-Host ("Total time: {0}" -f $timeFormatted)
Write-Host ""

if ($script:TotalFailed -gt 0) {
    exit 1
} else {
    exit 0
}
