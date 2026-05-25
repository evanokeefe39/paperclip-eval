# Paperclip Learnings

Running notes on issues, workarounds, and architectural observations discovered while evaluating [Paperclip](https://github.com/paperclipai/paperclip) for agent orchestration. Each entry captures what went wrong, why, and what to do about it.

---

## 2026-05-25 — pi_local adapter hits Windows command line length limit

### What happened

The pi_local adapter failed with `The command line is too long` when Paperclip attempted to invoke the Pi CLI. The assembled command included agent instructions (AGENTS.md), the execution contract, the wake payload, and a continuation summary — all passed inline as a single `--append-system-prompt` argument. On Windows, `cmd.exe` enforces a hard ~8,191 character limit on total command line length, and the prompt easily exceeded that.

### Root cause

The pi_local adapter injects the system prompt as a CLI argument rather than writing it to a temp file and passing a file path. The claude_local adapter already avoids this by using `--append-system-prompt-file`, but pi_local hasn't adopted that pattern. The problem compounds over time because wake payloads and continuation summaries grow with each heartbeat, so even a short AGENTS.md will eventually hit the limit on non-trivial tasks.

### Silent degradation mode

When the command doesn't outright fail, Windows can truncate or fragment the argument. Pi then receives each word as a separate message (e.g. "are", "the", "CEO.") and responds to gibberish, burning tokens on nonsense replies. This is documented in issues [#3114](https://github.com/paperclipai/paperclip/issues/3114) and [#3180](https://github.com/paperclipai/paperclip/issues/3180).

### Additional observation

The execution contract text appeared twice in the assembled command — once from the adapter's standard injection and once from the wake payload. This redundancy accelerates hitting the limit and is worth flagging as a separate bug.

### Workarounds

1. **Run Paperclip inside WSL2** — Linux has a ~2MB argument limit, which eliminates the problem entirely. Requires installing Node.js, pnpm, and pi inside the WSL2 distro.
2. **Trim AGENTS.md** — Reduces headroom pressure but won't hold long-term as continuation summaries grow across heartbeats.

### Status

Open bug as of v2026.517.0. No fix in any current release.

### References

- [Issue #3114 — fragmented message to pi agent](https://github.com/paperclipai/paperclip/issues/3114)
- [Issue #3180 — Pi adapter sends fragmented messages word by word](https://github.com/paperclipai/paperclip/issues/3180)
- [Issue #1673 — Windows/WSL2 setup guide for local adapters](https://github.com/paperclipai/paperclip/issues/1673)