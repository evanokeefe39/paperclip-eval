[Agent Standard](index.md) > Security

# Part 7: Security Model

---

## 7.1 Principle of Least Privilege

Every agent gets exactly the capabilities its role requires. Nothing more. The security boundary is the Docker container + extension loading. Agents cannot escalate their own permissions.

---

## 7.2 Permission Matrix (Summary)

| Agent | Code Exec | Web Egress | File Write | File Delete | Publish | HITL Required |
|-------|-----------|-----------|------------|-------------|---------|---------------|
| CEO | No | No | /artifacts/ceo/ | No | No | No |
| Researcher | No | Yes (search/fetch) | /artifacts/researcher/ | No | No | No |
| Analyst | No | No | /artifacts/analyst/ | No | No | No |
| Data Engineer | SQL only | Yes (scraping) | /artifacts/data-engineer/ | Workspace only | No | No |
| Dev | Yes (sandbox) | Allowlist only | /workspace + /artifacts/dev/ | Workspace only | No | No |
| Writer | No | No | /artifacts/writer/ | No | No | No |
| QA | No | No | /artifacts/qa/ | No | No | No |
| Publisher | No | Yes (platforms) | /artifacts/publisher/ | No | Yes | Yes, always |

---

## 7.3 Container Security (All Agents)

Standard container config (docker-compose.yml):

```yaml
deploy:
  resources:
    limits:
      memory: 512M    # 4G for Dev
    reservations:
      memory: 256M
security_opt:
  - no-new-privileges:true
read_only: true          # Read-only root filesystem
tmpfs:
  - /tmp:size=100M       # Writable tmp
volumes:
  - shared-artifacts:/artifacts     # Shared volume
  - {agent}-workspace:/workspace    # Per-agent workspace (writable)
```

Dev agent gets additional hardening:

```yaml
user: "1000:1000"        # Non-root
deploy:
  resources:
    limits:
      cpus: "2"
      memory: 4G
networks:
  - internal             # No external network by default
  # Allowlisted egress via network policy
```

---

## 7.4 Secrets Management

- Provider API keys: `.pi/agent/auth.json` (gitignored, copied from root during setup)
- Platform credentials (Publisher): agent-specific auth, never shared
- Paperclip auth: Bearer token via per-agent API key (`PAPERCLIP_API_KEY`)
- No secrets in artifacts, logs, or Paperclip issue comments
- No secrets in agent.json or AGENTS.md

---

## 7.5 Security Monitoring

Logging extension captures:
- All external API calls (URLs, response codes, latency)
- All file writes (paths, sizes)
- All escalation events
- All error events

Anomaly indicators (flagged in logs, reviewed by meta-agents or board):
- Agent writing outside its namespace
- Unexpected external network calls
- Unusually large artifacts
- Repeated tool failures (possible credential issues)
- Agent attempting to read other agents' auth.json

---

[Prev: Extensions](extensions.md) | [Next: Shared Resources](shared-resources.md)
