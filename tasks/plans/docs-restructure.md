# Plan: Break Up Long Docs into Linked Pages

## Intent

Split `docs/agent-operating-standard.md` (1260 LOC) into ~7 focused pages. Group Toyota docs into a subdir. Add an index page linking everything. Goal: each doc under 250 LOC, easy to navigate, cross-linked.

## Current state

| File | Lines | Action |
|------|-------|--------|
| agent-operating-standard.md | 1260 | Split into agent-standard/ subdir |
| toyota-way-principles-integration.md | 382 | Move to toyota-way/ subdir |
| paperclip-integration.md | 344 | Keep (cohesive) |
| architecture.md | 268 | Keep |
| discord-setup.md | 229 | Keep |
| toyota-way-principles-reference.md | 186 | Move to toyota-way/ subdir |
| bridge-design.md | 160 | Keep |
| pi-rpc-protocol.md | 148 | Keep |

## Target structure

```
docs/
  index.md                          — hub page linking all docs
  architecture.md                   — stays
  bridge-design.md                  — stays
  pi-rpc-protocol.md                — stays
  discord-setup.md                  — stays
  paperclip-integration.md          — stays

  agent-standard/                   — split from 1260 LOC monolith
    index.md                        — overview + links to all parts
    tps-principles.md               — Part 1: principles 1.1-1.9 (~250 LOC)
    workspace-structure.md          — Parts 2-3: workspace layout + file requirements (~250 LOC)
    templates.md                    — Parts 4-5: templates + agent role configs (~200 LOC)
    extensions.md                   — Part 6: universal extensions (~150 LOC)
    security.md                     — Part 7: security model + permissions (~100 LOC)
    shared-resources.md             — Parts 8-9: shared resources + mgmt principles (~150 LOC)
    implementation-checklist.md     — Part 10 + appendices A/B (~100 LOC)

  toyota-way/                       — group the pair
    principles-integration.md       — from toyota-way-principles-integration.md
    principles-reference.md         — from toyota-way-principles-reference.md
```

## Cross-linking strategy

- Each page starts with a breadcrumb: `[Agent Standard](index.md) > Security`
- Each page ends with prev/next links to adjacent sections
- index.md has a table of contents with one-line descriptions per page
- docs/index.md links to all top-level docs and subdirs

## Steps

1. Create `docs/agent-standard/` directory
2. Split agent-operating-standard.md into 7 files along Part boundaries
3. Add breadcrumbs and prev/next links to each page
4. Create `docs/agent-standard/index.md` with TOC
5. Move Toyota docs into `docs/toyota-way/`
6. Create `docs/index.md` hub page
7. Delete old `docs/agent-operating-standard.md` and flat Toyota files
8. Update any cross-references in other docs pointing to old filenames
9. Update CLAUDE.md docs/ section in repo layout
