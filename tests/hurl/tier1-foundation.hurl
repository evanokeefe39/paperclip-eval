# Test 1.1: Container health
GET http://localhost:8081/health
HTTP 200
[Asserts]
jsonpath "$.status" == "ok"
jsonpath "$.config.provider" exists
jsonpath "$.config.model" exists
duration < 1000

# Test 1.2: Bridge responds to POST
POST http://localhost:8081/invoke
Content-Type: application/json
{
  "prompt": "respond with exactly: PONG"
}
HTTP 200
[Asserts]
header "Content-Type" contains "application/json"
jsonpath "$.output" exists
jsonpath "$.exitCode" exists

# Test 1.3: Round-trip echo
POST http://localhost:8081/invoke
Content-Type: application/json
{
  "prompt": "Respond with ONLY the word PONG. Nothing else. No punctuation."
}
HTTP 200
[Asserts]
jsonpath "$.output" contains "PONG"
jsonpath "$.exitCode" == 0
duration < 30000

# Test 1.4: 404 on unknown routes
GET http://localhost:8081/nonexistent
HTTP 404

POST http://localhost:8081/health
HTTP 404

GET http://localhost:8081/invoke
HTTP 404

# Test 1.5: Metrics endpoint
GET http://localhost:8081/metrics
HTTP 200
[Asserts]
jsonpath "$.requests_total" >= 0
jsonpath "$.requests_active" >= 0
