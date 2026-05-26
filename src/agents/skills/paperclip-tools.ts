import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import {
  request,
  resolveCompanyId,
  resolveAgentId,
  isConfigured,
} from "./client.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== "");
  if (!entries.length) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
}

const Uuid = Type.String({ format: "uuid" });
const OptUuid = Type.Optional(Type.String({ format: "uuid" }));
const IssueId = Type.String({ minLength: 1, description: "Issue UUID or identifier (e.g. ENG-42)" });
const DocKey = Type.String({ minLength: 1, maxLength: 64, description: "Document key" });

export default function (pi: ExtensionAPI) {
  if (!isConfigured()) return;

  function reg(
    name: string,
    label: string,
    description: string,
    parameters: TSchema,
    execute: (id: string, p: any, s: AbortSignal) => Promise<ToolResult>,
  ) {
    pi.registerTool({ name, label, description, parameters, execute });
  }

  // ── Identity & Inbox ─────────────────────────────────────────────

  reg(
    "paperclip_me",
    "Paperclip Me",
    "Get current authenticated agent details — identity, role, company, status.",
    Type.Object({}),
    async () => ok(await request("GET", "/agents/me")),
  );

  reg(
    "paperclip_inbox",
    "Paperclip Inbox",
    "Get compact inbox of issues assigned to you, sorted by priority.",
    Type.Object({}),
    async () => ok(await request("GET", "/agents/me/inbox-lite")),
  );

  reg(
    "paperclip_list_agents",
    "List Agents",
    "List all agents in the company.",
    Type.Object({
      companyId: Type.Optional(Type.String({ description: "Company UUID (defaults to env)" })),
    }),
    async (_id, p) => ok(await request("GET", `/companies/${resolveCompanyId(p.companyId)}/agents`)),
  );

  reg(
    "paperclip_get_agent",
    "Get Agent",
    "Get a single agent by ID.",
    Type.Object({
      agentId: Type.String({ minLength: 1, description: "Agent UUID" }),
      companyId: Type.Optional(Type.String({ description: "Company UUID" })),
    }),
    async (_id, p) => {
      const q = p.companyId ? `?companyId=${encodeURIComponent(p.companyId)}` : "";
      return ok(await request("GET", `/agents/${encodeURIComponent(p.agentId)}${q}`));
    },
  );

  // ── Issues ────────────────────────────────────────────────────────

  reg(
    "paperclip_list_issues",
    "List Issues",
    "List issues with optional filters: status, project, assignee, search query, labels.",
    Type.Object({
      companyId: Type.Optional(Type.String({ description: "Company UUID" })),
      status: Type.Optional(Type.String({ description: "Filter: backlog|todo|in_progress|in_review|done|blocked|cancelled" })),
      projectId: Type.Optional(Type.String({ description: "Filter by project UUID" })),
      assigneeAgentId: Type.Optional(Type.String({ description: "Filter by assignee agent UUID" })),
      participantAgentId: Type.Optional(Type.String({ description: "Filter by participant agent UUID" })),
      labelId: Type.Optional(Type.String({ description: "Filter by label UUID" })),
      q: Type.Optional(Type.String({ description: "Full-text search query" })),
      originKind: Type.Optional(Type.String({ description: "Filter by origin kind" })),
      originId: Type.Optional(Type.String({ description: "Filter by origin ID" })),
      includeRoutineExecutions: Type.Optional(Type.Boolean({ description: "Include routine execution issues" })),
    }),
    async (_id, p) => {
      const cid = resolveCompanyId(p.companyId);
      const params: Record<string, any> = {};
      for (const [k, v] of Object.entries(p)) {
        if (k !== "companyId" && v != null) params[k] = v;
      }
      return ok(await request("GET", `/companies/${cid}/issues${qs(params)}`));
    },
  );

  reg(
    "paperclip_get_issue",
    "Get Issue",
    "Get a single issue by UUID or identifier (e.g. ENG-42).",
    Type.Object({ issueId: IssueId }),
    async (_id, p) => ok(await request("GET", `/issues/${encodeURIComponent(p.issueId)}`)),
  );

  reg(
    "paperclip_get_heartbeat_context",
    "Get Heartbeat Context",
    "Get compact heartbeat context for an issue — includes recent activity, workspace state, and thread summary.",
    Type.Object({
      issueId: IssueId,
      wakeCommentId: Type.Optional(Type.String({ format: "uuid", description: "Comment that triggered the wake" })),
    }),
    async (_id, p) => {
      const q = p.wakeCommentId ? `?wakeCommentId=${encodeURIComponent(p.wakeCommentId)}` : "";
      return ok(await request("GET", `/issues/${encodeURIComponent(p.issueId)}/heartbeat-context${q}`));
    },
  );

  reg(
    "paperclip_create_issue",
    "Create Issue",
    "Create a new issue. Returns the created issue object.",
    Type.Object({
      companyId: Type.Optional(Type.String({ description: "Company UUID" })),
      title: Type.String({ description: "Issue title" }),
      description: Type.Optional(Type.String({ description: "Issue description (markdown)" })),
      status: Type.Optional(Type.String({ description: "backlog|todo|in_progress|in_review|done|blocked|cancelled" })),
      priority: Type.Optional(Type.String({ description: "critical|high|medium|low" })),
      assigneeAgentId: Type.Optional(Type.String({ description: "Agent UUID to assign" })),
      parentId: Type.Optional(Type.String({ description: "Parent issue UUID for sub-issues" })),
      blockedByIssueIds: Type.Optional(Type.Array(Type.String(), { description: "Issue UUIDs that block this one" })),
      goalId: Type.Optional(Type.String({ description: "Goal UUID to link" })),
      projectId: Type.Optional(Type.String({ description: "Project UUID" })),
      workMode: Type.Optional(Type.String({ description: "standard|planning" })),
      labelIds: Type.Optional(Type.Array(Type.String(), { description: "Label UUIDs" })),
    }),
    async (_id, p) => {
      const cid = resolveCompanyId(p.companyId);
      const { companyId: _, ...body } = p;
      return ok(await request("POST", `/companies/${cid}/issues`, body));
    },
  );

  reg(
    "paperclip_update_issue",
    "Update Issue",
    "Patch an issue. Include comment to add a note with the update. Set resume=true to request follow-up on resumable closed work.",
    Type.Object({
      issueId: IssueId,
      title: Type.Optional(Type.String({ description: "New title" })),
      status: Type.Optional(Type.String({ description: "backlog|todo|in_progress|in_review|done|blocked|cancelled" })),
      priority: Type.Optional(Type.String({ description: "critical|high|medium|low" })),
      comment: Type.Optional(Type.String({ description: "Comment to add alongside the update" })),
      assigneeAgentId: Type.Optional(Type.String({ description: "Agent UUID to reassign" })),
      blockedByIssueIds: Type.Optional(Type.Array(Type.String(), { description: "Issue UUIDs that block this" })),
      resume: Type.Optional(Type.Boolean({ description: "Resume agent on closed/done issue" })),
      reopen: Type.Optional(Type.Boolean({ description: "Reopen a closed issue" })),
      interrupt: Type.Optional(Type.Boolean({ description: "Interrupt the currently running agent" })),
    }),
    async (_id, p) => {
      const { issueId, ...body } = p;
      return ok(await request("PATCH", `/issues/${encodeURIComponent(issueId)}`, body));
    },
  );

  reg(
    "paperclip_checkout_issue",
    "Checkout Issue",
    "Checkout an issue for an agent — locks it for exclusive work.",
    Type.Object({
      issueId: IssueId,
      agentId: Type.Optional(Type.String({ description: "Agent UUID (defaults to self)" })),
      expectedStatuses: Type.Optional(
        Type.Array(Type.String(), { description: "Statuses to accept (default: todo, backlog, blocked)" }),
      ),
    }),
    async (_id, p) =>
      ok(
        await request("POST", `/issues/${encodeURIComponent(p.issueId)}/checkout`, {
          agentId: resolveAgentId(p.agentId),
          expectedStatuses: p.expectedStatuses ?? ["todo", "backlog", "blocked"],
        }),
      ),
  );

  reg(
    "paperclip_release_issue",
    "Release Issue",
    "Release an issue checkout — unlocks it for other agents.",
    Type.Object({ issueId: IssueId }),
    async (_id, p) =>
      ok(await request("POST", `/issues/${encodeURIComponent(p.issueId)}/release`, {})),
  );

  // ── Comments ──────────────────────────────────────────────────────

  reg(
    "paperclip_list_comments",
    "List Comments",
    "List comments on an issue. Supports incremental fetching via after cursor.",
    Type.Object({
      issueId: IssueId,
      after: Type.Optional(Type.String({ format: "uuid", description: "Cursor: comment UUID to start after" })),
      order: Type.Optional(Type.String({ description: "asc|desc" })),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500, description: "Max comments to return" })),
    }),
    async (_id, p) => {
      const { issueId, ...rest } = p;
      return ok(await request("GET", `/issues/${encodeURIComponent(issueId)}/comments${qs(rest)}`));
    },
  );

  reg(
    "paperclip_get_comment",
    "Get Comment",
    "Get a single comment by ID.",
    Type.Object({
      issueId: IssueId,
      commentId: Type.String({ format: "uuid", description: "Comment UUID" }),
    }),
    async (_id, p) =>
      ok(
        await request(
          "GET",
          `/issues/${encodeURIComponent(p.issueId)}/comments/${encodeURIComponent(p.commentId)}`,
        ),
      ),
  );

  reg(
    "paperclip_add_comment",
    "Add Comment",
    "Add a comment to an issue. Set resume=true to wake the assigned agent after commenting.",
    Type.Object({
      issueId: IssueId,
      body: Type.String({ description: "Comment body (markdown)" }),
      resume: Type.Optional(Type.Boolean({ description: "Resume/wake the assigned agent" })),
      reopen: Type.Optional(Type.Boolean({ description: "Reopen a closed issue" })),
      interrupt: Type.Optional(Type.Boolean({ description: "Interrupt the running agent" })),
    }),
    async (_id, p) => {
      const { issueId, ...body } = p;
      return ok(await request("POST", `/issues/${encodeURIComponent(issueId)}/comments`, body));
    },
  );

  // ── Documents ─────────────────────────────────────────────────────

  reg(
    "paperclip_list_documents",
    "List Documents",
    "List all documents attached to an issue.",
    Type.Object({ issueId: IssueId }),
    async (_id, p) =>
      ok(await request("GET", `/issues/${encodeURIComponent(p.issueId)}/documents`)),
  );

  reg(
    "paperclip_get_document",
    "Get Document",
    "Get an issue document by key.",
    Type.Object({ issueId: IssueId, key: DocKey }),
    async (_id, p) =>
      ok(
        await request(
          "GET",
          `/issues/${encodeURIComponent(p.issueId)}/documents/${encodeURIComponent(p.key)}`,
        ),
      ),
  );

  reg(
    "paperclip_upsert_document",
    "Upsert Document",
    "Create or update an issue document. Supports optimistic concurrency via baseRevisionId.",
    Type.Object({
      issueId: IssueId,
      key: DocKey,
      body: Type.String({ description: "Document content" }),
      title: Type.Optional(Type.String({ maxLength: 200, description: "Document title" })),
      format: Type.Optional(Type.String({ description: "Document format (default: markdown)" })),
      changeSummary: Type.Optional(Type.String({ maxLength: 500, description: "Summary of changes" })),
      baseRevisionId: Type.Optional(Type.String({ format: "uuid", description: "Base revision for optimistic concurrency" })),
    }),
    async (_id, p) => {
      const { issueId, key, ...body } = p;
      return ok(
        await request(
          "PUT",
          `/issues/${encodeURIComponent(issueId)}/documents/${encodeURIComponent(key)}`,
          body,
        ),
      );
    },
  );

  reg(
    "paperclip_list_document_revisions",
    "List Document Revisions",
    "List revision history for an issue document.",
    Type.Object({ issueId: IssueId, key: DocKey }),
    async (_id, p) =>
      ok(
        await request(
          "GET",
          `/issues/${encodeURIComponent(p.issueId)}/documents/${encodeURIComponent(p.key)}/revisions`,
        ),
      ),
  );

  reg(
    "paperclip_restore_document_revision",
    "Restore Document Revision",
    "Restore a prior revision of an issue document.",
    Type.Object({
      issueId: IssueId,
      key: DocKey,
      revisionId: Type.String({ format: "uuid", description: "Revision UUID to restore" }),
    }),
    async (_id, p) =>
      ok(
        await request(
          "POST",
          `/issues/${encodeURIComponent(p.issueId)}/documents/${encodeURIComponent(p.key)}/revisions/${encodeURIComponent(p.revisionId)}/restore`,
          {},
        ),
      ),
  );

  // ── Projects ──────────────────────────────────────────────────────

  reg(
    "paperclip_list_projects",
    "List Projects",
    "List projects in the company.",
    Type.Object({
      companyId: Type.Optional(Type.String({ description: "Company UUID" })),
    }),
    async (_id, p) =>
      ok(await request("GET", `/companies/${resolveCompanyId(p.companyId)}/projects`)),
  );

  reg(
    "paperclip_get_project",
    "Get Project",
    "Get a project by ID.",
    Type.Object({
      projectId: Type.String({ minLength: 1, description: "Project UUID or short reference" }),
      companyId: Type.Optional(Type.String({ description: "Company UUID" })),
    }),
    async (_id, p) => {
      const q = p.companyId ? `?companyId=${encodeURIComponent(p.companyId)}` : "";
      return ok(await request("GET", `/projects/${encodeURIComponent(p.projectId)}${q}`));
    },
  );

  // ── Goals ─────────────────────────────────────────────────────────

  reg(
    "paperclip_list_goals",
    "List Goals",
    "List goals in the company.",
    Type.Object({
      companyId: Type.Optional(Type.String({ description: "Company UUID" })),
    }),
    async (_id, p) =>
      ok(await request("GET", `/companies/${resolveCompanyId(p.companyId)}/goals`)),
  );

  reg(
    "paperclip_get_goal",
    "Get Goal",
    "Get a goal by ID.",
    Type.Object({
      goalId: Type.String({ format: "uuid", description: "Goal UUID" }),
    }),
    async (_id, p) =>
      ok(await request("GET", `/goals/${encodeURIComponent(p.goalId)}`)),
  );

  // ── Interactions ──────────────────────────────────────────────────

  reg(
    "paperclip_suggest_tasks",
    "Suggest Tasks",
    "Create a suggest_tasks interaction — proposes a list of sub-tasks for human review.",
    Type.Object({
      issueId: IssueId,
      payload: Type.Object({
        version: Type.Literal(1),
        tasks: Type.Array(
          Type.Object({
            clientKey: Type.String({ description: "Unique key for this task suggestion" }),
            title: Type.String({ description: "Task title" }),
            description: Type.Optional(Type.String({ description: "Task description" })),
            priority: Type.Optional(Type.String({ description: "critical|high|medium|low" })),
          }),
        ),
      }),
      idempotencyKey: Type.Optional(Type.String({ maxLength: 255, description: "Prevents duplicate interactions" })),
      title: Type.Optional(Type.String({ maxLength: 240 })),
      summary: Type.Optional(Type.String({ maxLength: 1000 })),
      continuationPolicy: Type.Optional(
        Type.String({ description: "none|wake_assignee|wake_assignee_on_accept (default: wake_assignee)" }),
      ),
    }),
    async (_id, p) => {
      const { issueId, ...body } = p;
      return ok(
        await request("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          kind: "suggest_tasks",
          ...body,
          continuationPolicy: body.continuationPolicy ?? "wake_assignee",
        }),
      );
    },
  );

  reg(
    "paperclip_ask_user_questions",
    "Ask User Questions",
    "Create an ask_user_questions interaction — presents structured questions for human input.",
    Type.Object({
      issueId: IssueId,
      payload: Type.Object({
        version: Type.Literal(1),
        questions: Type.Array(
          Type.Object({
            id: Type.String({ description: "Question identifier" }),
            prompt: Type.String({ description: "Question text" }),
            selectionMode: Type.Optional(Type.String({ description: "single|multiple" })),
            options: Type.Optional(
              Type.Array(
                Type.Object({
                  id: Type.String(),
                  label: Type.String(),
                  description: Type.Optional(Type.String()),
                }),
              ),
            ),
          }),
        ),
      }),
      idempotencyKey: Type.Optional(Type.String({ maxLength: 255 })),
      title: Type.Optional(Type.String({ maxLength: 240 })),
      summary: Type.Optional(Type.String({ maxLength: 1000 })),
      continuationPolicy: Type.Optional(
        Type.String({ description: "none|wake_assignee|wake_assignee_on_accept (default: wake_assignee)" }),
      ),
    }),
    async (_id, p) => {
      const { issueId, ...body } = p;
      return ok(
        await request("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          kind: "ask_user_questions",
          ...body,
          continuationPolicy: body.continuationPolicy ?? "wake_assignee",
        }),
      );
    },
  );

  reg(
    "paperclip_request_confirmation",
    "Request Confirmation",
    "Create a request_confirmation interaction — asks for explicit human approval before proceeding.",
    Type.Object({
      issueId: IssueId,
      payload: Type.Object({
        version: Type.Literal(1),
        prompt: Type.String({ description: "What needs confirming" }),
        target: Type.Optional(Type.String({ description: "Target audience" })),
        acceptLabel: Type.Optional(Type.String({ description: "Accept button label" })),
        rejectLabel: Type.Optional(Type.String({ description: "Reject button label" })),
      }),
      idempotencyKey: Type.Optional(Type.String({ maxLength: 255 })),
      title: Type.Optional(Type.String({ maxLength: 240 })),
      summary: Type.Optional(Type.String({ maxLength: 1000 })),
      continuationPolicy: Type.Optional(
        Type.String({ description: "none|wake_assignee|wake_assignee_on_accept (default: none)" }),
      ),
    }),
    async (_id, p) => {
      const { issueId, ...body } = p;
      return ok(
        await request("POST", `/issues/${encodeURIComponent(issueId)}/interactions`, {
          kind: "request_confirmation",
          ...body,
          continuationPolicy: body.continuationPolicy ?? "none",
        }),
      );
    },
  );

  // ── Approvals ─────────────────────────────────────────────────────

  reg(
    "paperclip_list_approvals",
    "List Approvals",
    "List board approvals in the company.",
    Type.Object({
      companyId: Type.Optional(Type.String({ description: "Company UUID" })),
      status: Type.Optional(Type.String({ description: "Filter by status" })),
    }),
    async (_id, p) => {
      const q = p.status ? `?status=${encodeURIComponent(p.status)}` : "";
      return ok(await request("GET", `/companies/${resolveCompanyId(p.companyId)}/approvals${q}`));
    },
  );

  reg(
    "paperclip_create_approval",
    "Create Approval",
    "Create a board approval request, optionally linked to issues.",
    Type.Object({
      companyId: Type.Optional(Type.String({ description: "Company UUID" })),
      type: Type.String({ description: "hire_agent|approve_ceo_strategy|budget_override_required|request_board_approval" }),
      payload: Type.Unknown({ description: "Approval-type-specific payload object" }),
      requestedByAgentId: Type.Optional(Type.String({ description: "Requesting agent UUID" })),
      issueIds: Type.Optional(Type.Array(Type.String(), { description: "Issue UUIDs to link" })),
    }),
    async (_id, p) => {
      const cid = resolveCompanyId(p.companyId);
      const { companyId: _, ...body } = p;
      return ok(await request("POST", `/companies/${cid}/approvals`, body));
    },
  );

  reg(
    "paperclip_get_approval",
    "Get Approval",
    "Get an approval by ID.",
    Type.Object({
      approvalId: Type.String({ format: "uuid", description: "Approval UUID" }),
    }),
    async (_id, p) =>
      ok(await request("GET", `/approvals/${encodeURIComponent(p.approvalId)}`)),
  );

  reg(
    "paperclip_get_approval_issues",
    "Get Approval Issues",
    "List issues linked to an approval.",
    Type.Object({
      approvalId: Type.String({ format: "uuid", description: "Approval UUID" }),
    }),
    async (_id, p) =>
      ok(await request("GET", `/approvals/${encodeURIComponent(p.approvalId)}/issues`)),
  );

  reg(
    "paperclip_list_approval_comments",
    "List Approval Comments",
    "List comments on an approval.",
    Type.Object({
      approvalId: Type.String({ format: "uuid", description: "Approval UUID" }),
    }),
    async (_id, p) =>
      ok(await request("GET", `/approvals/${encodeURIComponent(p.approvalId)}/comments`)),
  );

  reg(
    "paperclip_add_approval_comment",
    "Add Approval Comment",
    "Add a comment to an approval.",
    Type.Object({
      approvalId: Type.String({ format: "uuid", description: "Approval UUID" }),
      body: Type.String({ description: "Comment body" }),
    }),
    async (_id, p) =>
      ok(await request("POST", `/approvals/${encodeURIComponent(p.approvalId)}/comments`, { body: p.body })),
  );

  reg(
    "paperclip_approval_decision",
    "Approval Decision",
    "Approve, reject, request revision, or resubmit an approval.",
    Type.Object({
      approvalId: Type.String({ format: "uuid", description: "Approval UUID" }),
      action: Type.String({ description: "approve|reject|requestRevision|resubmit" }),
      decisionNote: Type.Optional(Type.String({ description: "Note explaining the decision" })),
      payloadJson: Type.Optional(Type.String({ description: "JSON payload for resubmit action" })),
    }),
    async (_id, p) => {
      const pathMap: Record<string, string> = {
        approve: "approve",
        reject: "reject",
        requestRevision: "request-revision",
        resubmit: "resubmit",
      };
      const segment = pathMap[p.action];
      if (!segment) throw new Error(`Invalid action: ${p.action}`);

      let body: unknown;
      if (p.action === "resubmit") {
        const payload = p.payloadJson ? JSON.parse(p.payloadJson) : {};
        body = { payload };
      } else {
        body = { decisionNote: p.decisionNote };
      }

      return ok(
        await request("POST", `/approvals/${encodeURIComponent(p.approvalId)}/${segment}`, body),
      );
    },
  );

  reg(
    "paperclip_list_issue_approvals",
    "List Issue Approvals",
    "List approvals linked to an issue.",
    Type.Object({ issueId: IssueId }),
    async (_id, p) =>
      ok(await request("GET", `/issues/${encodeURIComponent(p.issueId)}/approvals`)),
  );

  reg(
    "paperclip_link_issue_approval",
    "Link Issue Approval",
    "Link an approval to an issue.",
    Type.Object({
      issueId: IssueId,
      approvalId: Type.String({ format: "uuid", description: "Approval UUID to link" }),
    }),
    async (_id, p) =>
      ok(
        await request("POST", `/issues/${encodeURIComponent(p.issueId)}/approvals`, {
          approvalId: p.approvalId,
        }),
      ),
  );

  reg(
    "paperclip_unlink_issue_approval",
    "Unlink Issue Approval",
    "Unlink an approval from an issue.",
    Type.Object({
      issueId: IssueId,
      approvalId: Type.String({ format: "uuid", description: "Approval UUID to unlink" }),
    }),
    async (_id, p) =>
      ok(
        await request(
          "DELETE",
          `/issues/${encodeURIComponent(p.issueId)}/approvals/${encodeURIComponent(p.approvalId)}`,
        ),
      ),
  );

  // ── Workspace Runtime ─────────────────────────────────────────────

  reg(
    "paperclip_get_workspace_runtime",
    "Get Workspace Runtime",
    "Get execution workspace and runtime services for an issue.",
    Type.Object({ issueId: IssueId }),
    async (_id, p) => {
      const context: any = await request(
        "GET",
        `/issues/${encodeURIComponent(p.issueId)}/heartbeat-context`,
      );
      const workspace = context?.currentExecutionWorkspace ?? null;
      const services = Array.isArray(workspace?.runtimeServices)
        ? workspace.runtimeServices
        : [];
      return ok({ workspace, runtimeServices: services });
    },
  );

  reg(
    "paperclip_control_workspace_services",
    "Control Workspace Services",
    "Start, stop, or restart runtime services in an issue's execution workspace.",
    Type.Object({
      issueId: IssueId,
      action: Type.String({ description: "start|stop|restart" }),
      runtimeServiceId: Type.Optional(Type.String({ format: "uuid", description: "Specific service UUID" })),
      serviceIndex: Type.Optional(Type.Number({ description: "Service index" })),
    }),
    async (_id, p) => {
      const context: any = await request(
        "GET",
        `/issues/${encodeURIComponent(p.issueId)}/heartbeat-context`,
      );
      const workspaceId = context?.currentExecutionWorkspace?.id;
      if (!workspaceId) throw new Error("Issue has no current execution workspace");
      const body: Record<string, unknown> = {};
      if (p.runtimeServiceId) body.runtimeServiceId = p.runtimeServiceId;
      if (p.serviceIndex != null) body.serviceIndex = p.serviceIndex;
      return ok(
        await request(
          "POST",
          `/execution-workspaces/${encodeURIComponent(workspaceId)}/runtime-services/${p.action}`,
          body,
        ),
      );
    },
  );

  reg(
    "paperclip_wait_for_workspace_service",
    "Wait For Workspace Service",
    "Poll until a workspace runtime service is running (max 300s).",
    Type.Object({
      issueId: IssueId,
      runtimeServiceId: Type.Optional(Type.String({ format: "uuid" })),
      serviceName: Type.Optional(Type.String({ description: "Service name to match" })),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 1, maximum: 300, description: "Timeout (default 60)" })),
    }),
    async (_id, p) => {
      const deadline = Date.now() + (p.timeoutSeconds ?? 60) * 1000;
      let latest: any = null;
      while (Date.now() <= deadline) {
        const ctx: any = await request(
          "GET",
          `/issues/${encodeURIComponent(p.issueId)}/heartbeat-context`,
        );
        const ws = ctx?.currentExecutionWorkspace;
        const services = Array.isArray(ws?.runtimeServices) ? ws.runtimeServices : [];

        let svc = null;
        if (p.runtimeServiceId) {
          svc = services.find((s: any) => s.id === p.runtimeServiceId);
        } else if (p.serviceName) {
          svc = services.find((s: any) => s.serviceName === p.serviceName);
        } else {
          svc =
            services.find((s: any) => s.status === "running" || s.status === "starting") ??
            services[0];
        }

        if (svc?.status === "running" && svc?.healthStatus !== "unhealthy") {
          return ok({ workspace: ws, service: svc });
        }
        latest = { workspace: ws, runtimeServices: services };
        await new Promise((r) => setTimeout(r, 1000));
      }

      return ok({ timedOut: true, ...latest });
    },
  );

  // ── Agent Invocation ───────────────────────────────────────────────

  reg(
    "paperclip_invoke_agent",
    "Invoke Agent",
    "Manually trigger a heartbeat invocation for an agent. Use after creating/assigning issues to ensure the agent wakes immediately instead of waiting for the next heartbeat cycle.",
    Type.Object({
      agentId: Type.String({ minLength: 1, description: "Agent UUID to invoke" }),
    }),
    async (_id, p) =>
      ok(await request("POST", `/agents/${encodeURIComponent(p.agentId)}/heartbeat/invoke`, {})),
  );

  // ── Escape Hatch ──────────────────────────────────────────────────

  reg(
    "paperclip_api_request",
    "Paperclip API Request",
    "Make a raw JSON request to any Paperclip /api endpoint. Use for operations not covered by other tools.",
    Type.Object({
      method: Type.String({ description: "GET|POST|PUT|PATCH|DELETE" }),
      path: Type.String({ description: "API path starting with / (relative to /api)" }),
      jsonBody: Type.Optional(Type.String({ description: "JSON string body for POST/PUT/PATCH" })),
    }),
    async (_id, p) => {
      if (!p.path.startsWith("/") || p.path.includes("..")) {
        throw new Error("path must start with / and must not contain '..'");
      }
      const body = p.jsonBody ? JSON.parse(p.jsonBody) : undefined;
      return ok(await request(p.method, p.path, body));
    },
  );
}
