# Pi RPC Protocol

## Overview

Pi runs as a subprocess in RPC mode, communicating via JSONL (newline-delimited JSON) over stdin/stdout. Each invocation is a single prompt-response cycle with no session persistence.

## Spawn Arguments

```
pi --mode rpc --no-session --provider <provider> --model <model> [--append-system-prompt <text>]
```

- `--mode rpc` - enables JSONL protocol on stdio
- `--no-session` - disables conversation history persistence
- `--provider` - LLM provider (e.g., minimax, deepseek, groq)
- `--model` - model identifier (e.g., MiniMax-M2.7)
- `--append-system-prompt` - optional system prompt appended to agent instructions

## Input Format

Write a single JSON object followed by a newline to stdin:

```json
{"type": "prompt", "message": "Your task description here"}
```

The prompt is written immediately after spawn. Only one prompt per process lifecycle.

## Output Events

Pi emits one JSON object per line on stdout. Event types:

### agent_start

Pi has accepted the prompt and begun processing.

```json
{"type": "agent_start"}
```

### message_update

Streaming token output. Contains nested event structure.

```json
{"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "token text"}}
```

The `delta` field contains the incremental text. Concatenating all deltas produces the full response.

### agent_end

Pi has finished processing. The response is complete.

```json
{"type": "agent_end"}
```

### extension_ui_request

Emitted by Pi extensions (e.g., oh-my-pi, subagents). Informational only. The bridge logs these but does not act on them.

```json
{"type": "extension_ui_request", ...}
```

### response (failure)

Prompt was rejected by Pi (e.g., invalid configuration, provider error before generation starts).

```json
{"type": "response", "success": false, ...}
```

## Lifecycle Diagrams

### With Extensions

```
spawn pi process
     |
     v
extension_ui_request   (one or more, as extensions initialize)
     |
     v
agent_start            (prompt accepted, generation begins)
     |
     v
message_update         (repeated, one per streaming token batch)
message_update
message_update
     |
     v
agent_end              (generation complete)
     |
     v
stdin.end()            (bridge closes stdin)
     |
     v
process exit
```

### Without Extensions

```
spawn pi process
     |
     v
agent_start
     |
     v
message_update(s)
     |
     v
agent_end
     |
     v
stdin.end()
     |
     v
process exit
```

## Error Conditions

### Process exit before agent_start

Pi exits (crash, missing provider credentials, binary not found) before emitting `agent_start`. The bridge returns HTTP 500 with error `pi_spawn_failed`.

### Timeout waiting for agent_start

Pi does not emit `agent_start` within `BRIDGE_TIMEOUT_MS` (default 120s). The bridge kills the process and returns HTTP 504 with error `timeout`.

### Timeout waiting for agent_end

Pi emitted `agent_start` but does not emit `agent_end` within `BRIDGE_TIMEOUT_MS`. The bridge kills the process and returns HTTP 504 with error `timeout`.

### JSONL parse errors

A stdout line is not valid JSON. The bridge logs a warning and skips the line. Non-fatal — processing continues.

### Prompt rejection

Pi emits `{"type": "response", "success": false}` before `agent_start`. The bridge returns HTTP 500 with error `pi_spawn_failed` and detail `pi rejected prompt`.

## stderr

Pi may write diagnostic output to stderr (extension logs, warnings). The bridge captures this and includes it in warning-level log entries. It does not affect the response unless Pi exits abnormally.
