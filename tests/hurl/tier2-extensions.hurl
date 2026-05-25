# Test 2.8: Extension-triggered invocation (web_fetch on known URL)
# Uses httpbin.org/html which returns static HTML — no API key needed.
POST http://localhost:8082/invoke
Content-Type: application/json
{
  "prompt": "Use your web_fetch tool to fetch https://httpbin.org/html and return the title or first heading you find.",
  "systemPrompt": "You have access to web_fetch. You MUST use it. Do not refuse."
}
HTTP 200
[Asserts]
jsonpath "$.output" != ""
jsonpath "$.exitCode" == 0
duration < 120000

# Test 2.9: Extension error does not crash bridge
# web_search without valid API key should produce an error message, not HTTP 500
POST http://localhost:8082/invoke
Content-Type: application/json
{
  "prompt": "Use web_search to search for 'test'. If it fails, report the error message.",
  "systemPrompt": "You have web_search available. Call it. If it errors, report the error text."
}
HTTP 200
[Asserts]
jsonpath "$.output" != ""
jsonpath "$.exitCode" == 0

# Test 2.10: Both extensions available in same session
POST http://localhost:8081/invoke
Content-Type: application/json
{
  "prompt": "List every tool name you have access to. Output them as a comma-separated list.",
  "systemPrompt": "List all registered tool names available to you."
}
HTTP 200
[Asserts]
jsonpath "$.output" != ""
jsonpath "$.exitCode" == 0
