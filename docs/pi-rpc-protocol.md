# Pi RPC Protocol

## Overview

Pi runs as a subprocess in RPC mode, communicating via JSONL (newline-delimited JSON) over stdin/stdout. In persistent mode (bridge v2.0.0), a single Pi process handles multiple prompt-response cycles. Between cycles, the bridge sends a `new_session` command that resets the conversation context while keeping the process and loaded extensions alive.

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

In spawn-per-request mode (bridge v1.x), the prompt is written immediately after spawn and only one prompt is sent per process lifecycle. In persistent mode (bridge v2.0.0), multiple prompts are sent to the same process, separated by `new_session` commands that reset the conversation context.

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

## Persistent Mode (v2.0.0)

In persistent mode, the bridge spawns Pi once at startup and reuses it for all requests. This eliminates per-request spawn overhead (extension loading, provider auth, etc.).

### Supported Commands

| Command | Direction | Purpose |
|---------|-----------|---------|
| `prompt` | bridge → Pi | Send a task prompt. Triggers agent_start → message_update(s) → agent_end cycle. |
| `new_session` | bridge → Pi | Reset conversation context. Extensions and provider connections remain loaded. |
| `follow_up` | bridge → Pi | Send a follow-up message within the current session (not currently used by bridge). |
| `steer` | bridge → Pi | Inject a system-level steering message mid-turn (not currently used by bridge). |
| `abort` | bridge → Pi | Cancel the current generation (not currently used by bridge). |
| `get_state` | bridge → Pi | Query Pi's current state (not currently used by bridge). |

### new_session Command

```json
{"type": "new_session"}
```

Pi acknowledges with a `new_session_ack` event on stdout. After acknowledgement, the next `prompt` command starts with a clean conversation context. Extensions remain loaded and provider connections stay open.

## Lifecycle Diagrams

### Persistent Mode (v2.0.0)

```
spawn pi process
     |
     v
extension_ui_request(s)   (extensions initialize once)
     |
     v
ready                     (Pi accepts commands)
     |
     +<--------------------------------------------------+
     |                                                    |
     v                                                    |
prompt                    (bridge writes prompt to stdin)  |
     |                                                    |
     v                                                    |
agent_start               (generation begins)             |
     |                                                    |
     v                                                    |
message_update(s)         (streaming tokens)              |
     |                                                    |
     v                                                    |
agent_end                 (generation complete)            |
     |                                                    |
     v                                                    |
new_session               (bridge resets context)          |
     |                                                    |
     v                                                    |
new_session_ack           (Pi confirms reset)             |
     |                                                    |
     +----------------------------------------------------+
                          (loop for next request)

     ...eventually...

stdin.end()               (bridge shutting down)
     |
     v
process exit
```

### Spawn-per-request Mode (v1.x, deprecated)

```
spawn pi process
     |
     v
extension_ui_request(s)   (optional, as extensions initialize)
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
