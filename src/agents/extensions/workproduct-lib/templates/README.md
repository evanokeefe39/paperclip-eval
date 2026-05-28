# Agent Templates

Standardized templates for all agent input, output, workspace, and meta artifacts. These are the poka-yoke layer — they make omissions visible and deviation detectable.

## Structure

```
templates/
  briefs/                  Issue templates — CEO uses these to create work
    research-brief.md
    analysis-brief.md
    content-brief.md
    publish-brief.md
    qa-review.md
  outputs/                 Output templates — agents produce work in these formats
    research-output.md
    analysis-output.md
    content-output.md
    qa-verdict.md
    publish-receipt.md
  workspace/               Workspace initialization files — copied into /artifacts/{agent}/
    learnings.md           Empty learnings log with format instructions
    meta.json.template     Agent metadata template (filled by artifacts extension)
  meta/                    Centralized meta-artifacts — learnings drain, agent profiles
    agent-profile.md       Per-agent profile template (capabilities, health, patterns)
    learnings-digest.md    Periodic learnings digest template
```

## How templates are used

- **Briefs** are injected into agents' AGENTS.md as "input template" reference, and used by CEO when creating Paperclip issues.
- **Outputs** are injected into agents' AGENTS.md as "output template" reference. QA validates against them. The verification plugin (Phase 2) enforces them mechanically.
- **Workspace** files are copied into `/artifacts/{agent-name}/` by the artifacts extension on first run.
- **Meta** templates define the format for centralized learnings and agent profiles in `/artifacts/meta/`.

## Template loading

Templates live inside the `workproduct-lib/` extension directory and are copied into agent containers as part of the extensions COPY in the Dockerfile base stage. The artifacts extension reads them from `/root/.pi/agent/extensions/workproduct-lib/templates/` inside the container and uses them for workspace initialization and output validation.
