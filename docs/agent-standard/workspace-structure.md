[Agent Standard](index.md) > Workspace Structure

# Parts 2–3: Workspace Structure and File Requirements

---

## Part 2: Universal Workspace Structure

Every agent container mounts the shared artifacts volume at `/artifacts`. Every agent's workspace follows this layout:

```
/artifacts/
  {agent-name}/                 Agent's namespace (e.g., /artifacts/researcher/)
    learnings.md                Kaizen log — append-only
    current/                    Work-in-progress for the active issue
      {issue-id}/               Per-issue subdirectory
        input/                  Copies of input artifacts (briefs, referenced data)
        work/                   Intermediate files
        output/                 Final deliverables
    output/                     Completed deliverables (promoted from current/{id}/output/)
    logs/                       Structured execution logs (from logging extension)
    meta.json                   Agent metadata (see below)
  qa/                           QA verdicts (written by QA agent only)
    {issue-id}-verdict.md       Per-issue verdict
  publisher/                    Publish receipts (written by Publisher only)
    {issue-id}-receipt.json     Per-publish metadata
```

### meta.json

Written by the artifacts extension on agent startup. Updated on each invocation.

```json
{
  "agent_name": "researcher",
  "agent_id": "paperclip-agent-uuid",
  "role": "researcher",
  "last_active": "2026-05-26T12:00:00Z",
  "current_issue_id": "issue-uuid-or-null",
  "extensions_loaded": ["escalate", "artifacts", "logging", "web-search", "web-fetch"]
}
```

### Artifact Metadata Sidecars

Every artifact file has a companion `.meta.json`:

```
/artifacts/researcher/output/research-findings.md
/artifacts/researcher/output/research-findings.md.meta.json
```

```json
{
  "agent": "researcher",
  "issue_id": "paperclip-issue-uuid",
  "type": "research",
  "created": "2026-05-26T12:00:00Z",
  "version": 1,
  "format": "markdown",
  "size_bytes": 4200,
  "sources_count": 12,
  "confidence": "high"
}
```

The artifacts extension handles sidecar creation automatically. Agents write content; the extension writes metadata.

---

## Part 3: Universal File Requirements Per Agent

Every agent directory requires these files. No exceptions.

### 3.1 agent.json — Registration Metadata

```json
{
  "name": "Human-Readable Name",
  "role": "slug",
  "title": "Display Title",
  "icon": "icon-name",
  "reportsTo": "CEO",
  "adapterType": "http",
  "adapterConfig": {
    "url": "http://{docker-service-name}:8080/invoke",
    "timeoutSec": 300
  },
  "capabilities": "Short capability summary",
  "runtimeConfig": {
    "heartbeat": {
      "enabled": true,
      "intervalSec": 120,
      "wakeOnDemand": true
    }
  }
}
```

Fields explained:
- `role`: machine-readable slug, matches directory name
- `reportsTo`: org chart parent (all report to CEO except CEO which reports to board)
- `adapterConfig.url`: Docker internal network hostname, always port 8080
- `runtimeConfig`: heartbeat polls every 120s for work discovery; `wakeOnDemand` adds reactive wakes for lifecycle events. Both are needed — heartbeat for assignment discovery, wakeOnDemand for state-change signals.

### 3.2 AGENTS.md — System Prompt

The most critical file. This is the agent's brain. Structure:

```markdown
# {Agent Name} Agent

[One paragraph: who you are, what you do, where you fit in the team]

## Responsibilities
[Bulleted list of what this agent does]

## Constraints
[Bulleted list of what this agent does NOT do — explicit negative space]

## Stop-the-Line Protocol
[Inherited from section 1.1 — copy exactly]

## Self-Verification Before Marking Done
[Inherited from section 1.1 — copy exactly]

## Input Validation
[Inherited from section 1.2 — copy exactly, plus role-specific required fields]

## Input Template
[Role-specific: what this agent expects to receive]

## Output Template
[Role-specific: what this agent must produce]

## Learnings Protocol
[Inherited from section 1.3 — copy exactly]

## Waste Awareness
[Inherited from section 1.6 — copy exactly]

## Verify Before Acting
[Inherited from section 1.8 — copy exactly]

## Post-Completion Reflection
[Inherited from section 1.7 — copy exactly]

## Artifact Conventions
- Write output to: /artifacts/{your-name}/current/{issue-id}/output/
- Read input from: paths provided in the brief
- Reference artifacts by path in Paperclip comments — never inline content
- Include Paperclip issue ID in all artifact metadata

## Role-Specific Behavioral Contracts
[GIVEN/WHEN/THEN contracts specific to this role — from the role spec in tasks/specs/]
```

Total system prompt size target: under 3000 tokens. The TPS sections are boilerplate and compress well. Role-specific content is the variable part.

### 3.3 .pi/agent/config.yml — Model Configuration

Base configuration shared by all agents:

```yaml
modelRoles:
  smol: groq/llama-3.1-8b-instant
  default: nvidia/meta/llama-4-maverick-17b-128e-instruct
  agentic: minimax/MiniMax-M2.7
  plan: deepseek/deepseek-reasoner
  review: deepseek/deepseek-reasoner
  commit: groq/llama-3.1-8b-instant

retry:
  enabled: true
  maxRetries: 5
  fallbackChains:
    - [minimax/MiniMax-M2.7, deepseek/deepseek-chat, nvidia/meta/llama-4-maverick-17b-128e-instruct]
    - [deepseek/deepseek-chat, minimax/MiniMax-M2.7, nvidia/meta/llama-4-maverick-17b-128e-instruct]
    - [nvidia/meta/llama-4-maverick-17b-128e-instruct, deepseek/deepseek-chat, minimax/MiniMax-M2.7]
    - [groq/llama-3.1-8b-instant, cerebras/llama-3.1-8b, mistral/mistral-small-latest]
    - [deepseek/deepseek-reasoner, minimax/MiniMax-M2.7]
  fallbackRevertPolicy: cooldown-expiry

contextPromotion: enabled
compaction:
  enabled: true
  strategy: context-full
  autoContinue: true
edit:
  mode: hashline
  fuzzyMatch: true
lsp:
  enabled: true
  diagnosticsOnWrite: true
cycleOrder: [smol, default, agentic, plan]
skills:
  enabled: true
  enableSkillCommands: true
```

Role-specific overrides documented per agent in [Templates — Per-Agent Requirements](templates.md#part-5-per-agent-requirements).

### 3.4 .pi/agent/models.json — Provider Registry

Identical across all agents. 8 providers:

```json
{
  "nvidia": { "api": "openai-completions", "baseUrl": "https://integrate.api.nvidia.com/v1", "apiKeyEnvVar": "NVIDIA_NIM_API_KEY", "models": [...] },
  "deepseek": { "api": "openai-completions", "baseUrl": "https://api.deepseek.com/v1", "apiKeyEnvVar": "DEEPSEEK_API_KEY", "models": [...] },
  "cerebras": { "api": "openai-completions", "baseUrl": "https://api.cerebras.ai/v1", "apiKeyEnvVar": "CEREBRAS_API_KEY", "models": [...] },
  "minimax": { "api": "openai-completions", "baseUrl": "https://api.minimaxi.chat/v1", "apiKeyEnvVar": "MINIMAX_API_KEY", "models": [...], "compat": {"streamingUsage": false, "noDeveloperRole": true} },
  "openrouter": { "api": "openai-completions", "baseUrl": "https://openrouter.ai/api/v1", "apiKeyEnvVar": "OPENROUTER_API_KEY", "models": [...] },
  "mistral": { "api": "openai-completions", "baseUrl": "https://api.mistral.ai/v1", "apiKeyEnvVar": "MISTRAL_API_KEY", "models": [...] },
  "groq": { "api": "openai-completions", "baseUrl": "https://api.groq.com/openai/v1", "apiKeyEnvVar": "GROQ_API_KEY", "models": [...] }
}
```

### 3.5 .pi/agent/settings.json — Runtime Settings

```json
{
  "packages": ["npm:shitty-extensions", "npm:@ifi/pi-extension-subagents"],
  "terminal": { "showTerminalProgress": true },
  "steeringMode": "all",
  "followUpMode": "all",
  "quietStartup": true,
  "theme": "dark",
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-chat",
  "defaultThinkingLevel": "high",
  "compaction": { "enabled": false }
}
```

### 3.6 .pi/agent/auth.json — Provider API Keys

Gitignored. Copied from root `auth.json` during setup. Contains provider-keyed API keys:

```json
{
  "DEEPSEEK_API_KEY": "...",
  "GROQ_API_KEY": "...",
  "minimax": { "type": "api_key", "key": "..." },
  "deepseek": { "type": "api_key", "key": "..." }
}
```

---

[Prev: TPS Principles](tps-principles.md) | [Next: Templates](templates.md)
