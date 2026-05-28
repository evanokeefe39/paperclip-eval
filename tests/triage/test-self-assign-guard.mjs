import { strict as assert } from "node:assert";

const CEO_AGENT_ID = "test-ceo-id-123";

/**
 * Pure-function reimplementation of the self-assignment guard added to
 * the tool_call hook in triage-workflow.ts.
 *
 * Returns true when the call should be blocked.
 */
function shouldBlockSelfAssign(toolName, input, agentId) {
  if (toolName !== "paperclip_create_issue") return false;
  if (!input.assigneeAgentId) return false;
  return input.assigneeAgentId === agentId;
}

// 1. Self-assignment is blocked
assert.ok(
  shouldBlockSelfAssign(
    "paperclip_create_issue",
    { assigneeAgentId: CEO_AGENT_ID, title: "test" },
    CEO_AGENT_ID,
  ),
  "should block when assigneeAgentId matches CEO agent ID",
);

// 2. Different assignee is allowed
assert.ok(
  !shouldBlockSelfAssign(
    "paperclip_create_issue",
    { assigneeAgentId: "other-agent-456", title: "test" },
    CEO_AGENT_ID,
  ),
  "should allow when assigneeAgentId differs from CEO agent ID",
);

// 3. No assignee at all is allowed (Paperclip handles default assignment)
assert.ok(
  !shouldBlockSelfAssign(
    "paperclip_create_issue",
    { title: "test" },
    CEO_AGENT_ID,
  ),
  "should allow when assigneeAgentId is absent",
);

// 4. Other tools are not affected even if assigneeAgentId matches
assert.ok(
  !shouldBlockSelfAssign(
    "paperclip_add_comment",
    { assigneeAgentId: CEO_AGENT_ID },
    CEO_AGENT_ID,
  ),
  "should not block non-create-issue tools",
);

// 5. Explicit undefined assigneeAgentId is allowed
assert.ok(
  !shouldBlockSelfAssign(
    "paperclip_create_issue",
    { assigneeAgentId: undefined, title: "test" },
    CEO_AGENT_ID,
  ),
  "should allow when assigneeAgentId is explicitly undefined",
);

// 6. Null assigneeAgentId is allowed
assert.ok(
  !shouldBlockSelfAssign(
    "paperclip_create_issue",
    { assigneeAgentId: null, title: "test" },
    CEO_AGENT_ID,
  ),
  "should allow when assigneeAgentId is null",
);

console.log("PASS: self-assignment guard logic correct (6/6 assertions)");
