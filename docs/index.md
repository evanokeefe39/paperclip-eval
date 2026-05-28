# Documentation

## Architecture and Design

| Document | Description |
|----------|-------------|
| [Architecture](architecture.md) | System architecture overview |
| [Bridge Design](bridge-design.md) | HTTP-to-RPC bridge design and protocol |
| [Pi RPC Protocol](pi-rpc-protocol.md) | Pi's JSONL-over-stdin/stdout RPC protocol |
| [Paperclip Integration](paperclip-integration.md) | Paperclip platform integration details |
| [Discord Setup](discord-setup.md) | Discord plugin configuration for escalation and notifications |

## Agent Operating Standard

The concrete implementation guide for every agent. Split into focused pages:

| Document | Description |
|----------|-------------|
| [Agent Standard](agent-standard/index.md) | Index — overview and table of contents |
| [TPS Principles](agent-standard/tps-principles.md) | Nine TPS principles as auditable agent requirements |
| [Workspace Structure](agent-standard/workspace-structure.md) | Universal workspace layout and per-agent file requirements |
| [Templates](agent-standard/templates.md) | Brief, output, workspace, and meta templates plus per-agent role configs |
| [Extensions](agent-standard/extensions.md) | Three universal extensions: escalate, artifacts, logging |
| [Security](agent-standard/security.md) | Permission matrix, container security, secrets management |
| [Shared Resources](agent-standard/shared-resources.md) | Shared infrastructure and Toyota management principles |
| [Implementation Checklist](agent-standard/implementation-checklist.md) | New-agent checklist and appendices |

## Toyota Way

TPS principles and their application to the Paperclip agent pipeline:

| Document | Description |
|----------|-------------|
| [Principles Integration](toyota-way/principles-integration.md) | TPS content pipeline architecture — the system design |
| [Principles Reference](toyota-way/principles-reference.md) | Reference map tying each TPS principle to its Paperclip implementation |
