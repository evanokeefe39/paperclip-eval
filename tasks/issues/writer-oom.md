# Writer container OOM crash

## Status

Fixed (2026-05-27).

## Symptom

Writer container crashes with `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory` during first invocation. Docker restarts the container (restart: unless-stopped) but the crash repeats on next invocation.

Stack trace points to `v8::internal::Runtime_StringSplit` — likely processing a large string (skills content or system prompt).

## Context

Writer uses deepseek-chat provider. All agents load the same extensions and skills:
- 8 extensions (-e flags)
- 3 Paperclip skills (--skill flags with SKILL.md + references)
- Pi base extensions (shitty-extensions, pi-extension-subagents, pi-otel)

Total skill content is substantial — the Paperclip SKILL.md alone plus its 5 reference files is several KB. Combined with system prompt and execution contract, the payload may exceed Node's default heap limit.

## Evidence

```
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
 1: 0xe46bbe node::OOMErrorHandler
...
12: 0x18b40b2 v8::internal::Runtime_StringSplit
```

Writer is the only agent using deepseek provider. Other agents (MiniMax) don't OOM — unclear if this is coincidence or if DeepSeek's response handling uses more memory.

## Fix applied

1. `NODE_OPTIONS=--max-old-space-size=1024` added to writer's `.env`
2. Writer container memory limit increased to 1G in `docker-compose.yml`

## Original fix options

1. `NODE_OPTIONS=--max-old-space-size=1024` in writer's environment (docker-compose or .env)
2. Increase container memory limit (currently no explicit limit on writer)
3. Reduce skills/extensions loaded for writer (does writer need web-search, web-scrape, duckdb?)

## Impact

Writer cannot complete any work. EVA-4 (report synthesis) blocked.
