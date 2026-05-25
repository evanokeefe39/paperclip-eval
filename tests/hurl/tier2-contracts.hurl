# Test 2.1: Paperclip wake payload acceptance
POST http://localhost:8081/invoke
Content-Type: application/json
file,tests/fixtures/wake-payload.json;
HTTP 200
[Asserts]
jsonpath "$.output" != ""
jsonpath "$.output" != null
jsonpath "$.events" count > 0
jsonpath "$.exitCode" == 0

# Test 2.2: Large payload (bypass pi_local limit)
POST http://localhost:8081/invoke
Content-Type: application/json
file,tests/fixtures/large-payload.json;
HTTP 200
[Asserts]
jsonpath "$.output" != ""
jsonpath "$.exitCode" == 0
duration < 60000

# Test 2.3: Malformed JSON → 400
POST http://localhost:8081/invoke
Content-Type: application/json
```
not json at all
```
HTTP 400
[Asserts]
jsonpath "$.error" == "invalid_json"

# Test 2.4: Empty body → 400
POST http://localhost:8081/invoke
Content-Type: application/json
HTTP 400

# Test 2.5: System prompt passed through
POST http://localhost:8081/invoke
Content-Type: application/json
{
  "prompt": "What is your role? Answer in one sentence.",
  "systemPrompt": "You are a pirate captain named Blackbeard. Always speak like a pirate."
}
HTTP 200
[Asserts]
jsonpath "$.output" matches "(?i)(pirate|arr|captain|blackbeard|matey|ye)"
jsonpath "$.exitCode" == 0

# Test 2.7: Events array contains expected protocol messages
POST http://localhost:8081/invoke
Content-Type: application/json
{
  "prompt": "Say hello."
}
HTTP 200
[Asserts]
jsonpath "$.events[0].type" == "ready"
