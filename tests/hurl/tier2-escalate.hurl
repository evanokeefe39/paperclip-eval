# Tier 2: Escalate Extension API Contracts
# Tests the Paperclip API surface used by the escalate extension.
# Requires: Paperclip at localhost:3100 in authenticated mode.

# --- Auth ---

# 2.E.1 Authenticate for subsequent requests
POST http://localhost:3100/api/auth/sign-in/email
Origin: http://localhost:3100
Content-Type: application/json
{
  "email": "admin@eval.local",
  "password": "eval-admin-2026"
}
HTTP 200
[Asserts]
header "Set-Cookie" contains "paperclip-default.session_token"
jsonpath "$.user.id" exists
jsonpath "$.token" exists
[Captures]
session: cookie "paperclip-default.session_token"

# --- Labels ---

# 2.E.2 List labels returns array
GET http://localhost:3100/api/companies/{{company_id}}/labels
Origin: http://localhost:3100
Cookie: paperclip-default.session_token={{session}}
HTTP 200
[Asserts]
jsonpath "$" isCollection

# 2.E.3 Create label returns 201
POST http://localhost:3100/api/companies/{{company_id}}/labels
Origin: http://localhost:3100
Cookie: paperclip-default.session_token={{session}}
Content-Type: application/json
{
  "name": "hurl-test-label",
  "color": "#00ff00"
}
HTTP 201
[Asserts]
jsonpath "$.id" exists
jsonpath "$.name" == "hurl-test-label"
jsonpath "$.color" == "#00ff00"
[Captures]
test_label_id: jsonpath "$.id"

# --- Issues ---

# 2.E.4 Create minimal issue
POST http://localhost:3100/api/companies/{{company_id}}/issues
Origin: http://localhost:3100
Cookie: paperclip-default.session_token={{session}}
Content-Type: application/json
{
  "title": "Hurl contract test: minimal"
}
HTTP 201
[Asserts]
jsonpath "$.id" exists
jsonpath "$.identifier" matches /^EVA-\d+$/
jsonpath "$.title" == "Hurl contract test: minimal"
jsonpath "$.status" == "backlog"
jsonpath "$.issueNumber" isInteger

# 2.E.5 Create issue with full escalation payload
POST http://localhost:3100/api/companies/{{company_id}}/issues
Origin: http://localhost:3100
Cookie: paperclip-default.session_token={{session}}
Content-Type: application/json
{
  "title": "Hurl contract test: full escalation",
  "description": "Need human decision on database.\n\n---\n\n## Requested Input\n\n**Database** (choose one):\n- PostgreSQL\n- SQLite\n\n```escalation-schema\n{\"message\":\"Which DB?\",\"inputs\":[{\"id\":\"db\",\"label\":\"Database\",\"type\":\"select\"}]}\n```",
  "priority": "high",
  "labelIds": ["{{test_label_id}}"]
}
HTTP 201
[Asserts]
jsonpath "$.id" exists
jsonpath "$.title" == "Hurl contract test: full escalation"
jsonpath "$.description" contains "escalation-schema"
jsonpath "$.description" contains "Requested Input"
jsonpath "$.priority" == "high"
[Captures]
escalation_issue_id: jsonpath "$.id"

# 2.E.6 Issue with high priority
POST http://localhost:3100/api/companies/{{company_id}}/issues
Origin: http://localhost:3100
Cookie: paperclip-default.session_token={{session}}
Content-Type: application/json
{
  "title": "Hurl: blocking priority",
  "priority": "high"
}
HTTP 201
[Asserts]
jsonpath "$.priority" == "high"

# 2.E.7 Issue with medium priority
POST http://localhost:3100/api/companies/{{company_id}}/issues
Origin: http://localhost:3100
Cookie: paperclip-default.session_token={{session}}
Content-Type: application/json
{
  "title": "Hurl: when_you_can priority",
  "priority": "medium"
}
HTTP 201
[Asserts]
jsonpath "$.priority" == "medium"

# 2.E.8 List issues returns array including our created issue
GET http://localhost:3100/api/companies/{{company_id}}/issues
Origin: http://localhost:3100
Cookie: paperclip-default.session_token={{session}}
HTTP 200
[Asserts]
jsonpath "$" isCollection

# --- Agent Pause / Resume ---

# 2.E.9 Pause agent
POST http://localhost:3100/api/agents/{{agent_id}}/pause
Origin: http://localhost:3100
Cookie: paperclip-default.session_token={{session}}
Content-Type: application/json
{
  "reason": "escalation"
}
HTTP 200
[Asserts]
jsonpath "$.status" == "paused"
jsonpath "$.pauseReason" exists
jsonpath "$.pausedAt" exists

# 2.E.10 Resume agent
POST http://localhost:3100/api/agents/{{agent_id}}/resume
Origin: http://localhost:3100
Cookie: paperclip-default.session_token={{session}}
Content-Type: application/json
{}
HTTP 200
[Asserts]
jsonpath "$.status" == "idle"
