# Agent: Dev

## Status

Stub. Empty directory at src/agents/dev/.

## Intent

Code execution and technical implementation agent. Runs code, analyzes codebases, builds tools, generates tests, and handles technical tasks that require sandboxed execution. The team's hands — writes and runs code in isolation.

Maps to "Coder" in ROADMAP.md.

## Upstream / Downstream

- Upstream: CEO (implementation tasks), QA (fix requests after review failures)
- Downstream: QA (code for review), CEO (technical analysis), other agents (built tools/scripts)
- Produces: code, scripts, technical analyses, test suites, tool implementations
- Consumes: implementation specs, bug reports, technical questions

## Capabilities

- Code writing and execution (sandboxed container)
- Code analysis and review
- Test generation and execution
- Script/tool building for other agents
- Technical documentation
- Linting and static analysis

## Extensions

- `artifacts` (artifacts.ts) — read/write code outputs to shared storage
- `escalate` (escalate.ts) — escalate technical decisions to human
- Future: specialized coding tools (linting, test generation, refactoring)
- Future: file system tools scoped to /workspace and /artifacts

## Model Configuration

TBD — coding tasks benefit from capable models:
- Default: nvidia/meta/llama-4-maverick-17b-128e-instruct
- Agentic (complex implementation): minimax/MiniMax-M2.7
- Planning: deepseek/deepseek-reasoner
- Smol: groq/llama-3.1-8b-instant

## Security / Permissions (from ROADMAP.md)

| Capability | Allowed |
|-----------|---------|
| Code execution | Yes (sandboxed) |
| Web egress | Limited (allowlisted package registries) |
| File delete | Workspace only |
| Publish | No |
| HITL required | No |

### Container Security Guardrails

- Runs as non-root user (no `--privileged`)
- Read-only filesystem except /workspace (working dir) and /artifacts (shared output)
- Resource limits: CPU (2 cores), memory (4GB), no swap
- Network: egress restricted to internal Docker network + allowlisted domains
- No host volume mounts beyond workspace and artifacts
- Execution timeout per invocation (configurable, default 5min)
- No docker.sock access — cannot spawn sibling containers
- /workspace wiped between invocations (ephemeral)
- Stdout/stderr size cap to prevent memory exhaustion in bridge

### File Permissions

- Read, write, execute within /workspace
- Read from /artifacts (all agents)
- Write to /artifacts/{own-context}/
- No delete outside /workspace

## Behavioral Contracts

GIVEN an implementation specification
WHEN Dev executes
THEN produce working code with tests, following the spec exactly — no extra features

GIVEN a failing test or bug report
WHEN Dev investigates
THEN identify root cause (five whys), fix at root, add regression test

GIVEN a code review rejection from QA
WHEN fix requested
THEN address all flagged issues, re-run tests, resubmit

GIVEN a technical question from another agent
WHEN analysis requested
THEN provide concrete analysis with code references, not abstract advice

## Constraints

- Never make architectural decisions without escalation
- Never exceed specified scope — no speculative features
- All code must have corresponding tests
- No network access beyond allowlisted domains
- No persistent state between invocations (/workspace is ephemeral)
- Cannot escalate own permissions

## Files Needed

```
src/agents/dev/
  agent.json              Registration metadata
  AGENTS.md               System prompt / role instructions
  .pi/agent/config.yml    Model roles, retry, compaction
  .pi/agent/models.json   Provider configs
  .pi/agent/settings.json Extensions, defaults
  .pi/agent/auth.json     Provider API keys (gitignored, copy from root)
```

## Open Questions

- Which package registries go on the network allowlist?
- Does Dev need access to the findings store or org data?
- What languages/runtimes should be pre-installed in the container?
- How does Dev handle tasks that need external APIs (e.g., building an integration)?
- Should Dev have its own Pi extensions for code-specific tools, or use Pi's built-in coding capabilities?
