import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

import * as client from "./artifact-client.js";
import { validateByStyle, type StyleProfiles } from "./workproduct-lib/validate.js";

// ---------------------------------------------------------------------------
// QA agent — assessment work products
//
// Three assessment kinds, each stored as a distinct artifact type:
//   - artifact_review : verdict on a producing-agent output artifact
//   - plan_review     : verdict on a proposed plan / spec
//   - stage_gate      : verdict on a stage-to-stage handoff
//
// Each has its own metadata shape but shares the same validation pattern.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Style validation profiles (per assessment kind)
// ---------------------------------------------------------------------------

const KIND_PROFILES: StyleProfiles = {
  sourceRequired: {
    artifact_review: [],
    plan_review: [],
    stage_gate: [],
  },
  sourceEncouraged: {
    artifact_review: [],
    plan_review: [],
    stage_gate: [],
  },
  recordEncouraged: {
    artifact_review: ["findings", "brief_ref"],
    plan_review: ["feasibility_score", "unresolved_questions"],
    stage_gate: ["blocking_issues", "prior_gate_ref"],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSessionId(): string {
  return process.env.PAPERCLIP_RUN_ID || process.env.SESSION_ID || "default";
}

const ASSESSMENT_KINDS = ["artifact_review", "plan_review", "stage_gate"] as const;
type AssessmentKind = typeof ASSESSMENT_KINDS[number];

function formatLine(rec: client.ArtifactRecord): string {
  const m = rec.metadata as Record<string, any>;
  const kind = rec.artifact_type;
  const verdict = m.verdict || "—";
  let ctx = "";
  if (kind === "artifact_review") {
    ctx = `${m.producing_agent || "?"} → ${m.artifact_under_review || "?"}`;
  } else if (kind === "stage_gate") {
    ctx = `${m.from_stage || "?"} → ${m.to_stage || "?"}`;
  } else if (kind === "plan_review") {
    ctx = `${m.plan_under_review || "?"}`;
  }
  return `[${rec.id}] ${kind} | ${verdict} | ${ctx}`;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const agentName = client.getAgentName();
  if (agentName !== "qa") {
    if (agentName) {
      console.warn(
        `[workproduct] qa extension loaded in wrong agent: ${agentName}`,
      );
    }
    return;
  }

  // ---- record_artifact_review ----
  pi.registerTool({
    name: "record_artifact_review",
    label: "Record Artifact Review",
    description:
      "Record a QA verdict on a producing-agent output artifact. " +
      "Captures verdict (pass|fail|escalate), the standards applied, " +
      "a named-check boolean checklist, severity metrics, a narrative " +
      "verdict, and optional structured findings list.",
    parameters: Type.Object({
      verdict: Type.Union(
        [Type.Literal("pass"), Type.Literal("fail"), Type.Literal("escalate")],
        { description: "Overall verdict for the reviewed artifact" },
      ),
      artifact_under_review: Type.String({
        description: "ID of the artifact being reviewed",
      }),
      producing_agent: Type.String({
        description: "Name of the agent that produced the artifact",
      }),
      source_issue: Type.String({
        description: "Paperclip issue ID the artifact was produced for",
      }),
      output_template: Type.String({
        description: "Output template name applied to the artifact (e.g. 'research-output')",
      }),
      standards_applied: Type.Array(Type.String(), {
        minItems: 1,
        description: "Standards / rubrics used to evaluate the artifact",
      }),
      checklist: Type.Record(Type.String(), Type.Boolean(), {
        description: "Map of named checks to pass/fail booleans",
      }),
      metrics: Type.Object({
        critical: Type.Integer({ minimum: 0 }),
        major: Type.Integer({ minimum: 0 }),
        minor: Type.Integer({ minimum: 0 }),
        total: Type.Integer({ minimum: 0 }),
      }, { description: "Count of issues at each severity, plus a total" }),
      verdict_text: Type.String({
        description: "Narrative explanation of the verdict",
      }),
      findings: Type.Optional(Type.Array(Type.Object({
        severity: Type.Union([
          Type.Literal("critical"),
          Type.Literal("major"),
          Type.Literal("minor"),
        ]),
        location: Type.String(),
        standard: Type.String(),
        detail: Type.String(),
        expected: Type.String(),
      }))),
      brief_ref: Type.Optional(Type.String({
        description: "Optional reference to the originating brief artifact ID",
      })),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const { errors, warnings } = validateByStyle(
          KIND_PROFILES, "artifact_review", [], params,
        );
        if (errors.length > 0) {
          return {
            content: [{ type: "text" as const, text: `Validation failed:\n${errors.join("\n")}` }],
          };
        }

        const sessionId = getSessionId();
        const findings = params.findings ?? [];
        const content =
          `${params.verdict_text}\n\n## Findings\n${JSON.stringify(findings, null, 2)}`;

        const result = await client.write({
          type: "artifact_review",
          bucket: "artifacts",
          filename: "artifact_review.md",
          mime: "text/markdown",
          content,
          metadata: {
            verdict: params.verdict,
            artifact_under_review: params.artifact_under_review,
            producing_agent: params.producing_agent,
            source_issue: params.source_issue,
            output_template: params.output_template,
            standards_applied: params.standards_applied,
            checklist: params.checklist,
            metrics: params.metrics,
            findings,
            brief_ref: params.brief_ref || undefined,
            session_id: sessionId,
          },
          run_id: sessionId,
        });

        const parts = [
          `Artifact review recorded: ${result.id}`,
          `Verdict: ${params.verdict}`,
          `Producing agent: ${params.producing_agent}`,
          `Artifact under review: ${params.artifact_under_review}`,
          `Metrics: ${params.metrics.critical}c / ${params.metrics.major}M / ${params.metrics.minor}m (total ${params.metrics.total})`,
        ];
        if (warnings.length > 0) parts.push(`\nWarnings:\n${warnings.join("\n")}`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: {
            id: result.id,
            verdict: params.verdict,
            metrics: params.metrics,
            warnings,
          },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- record_plan_review ----
  pi.registerTool({
    name: "record_plan_review",
    label: "Record Plan Review",
    description:
      "Record a QA verdict on a proposed plan or specification. " +
      "Captures the spec-gate checklist, a risk inventory with mitigations, " +
      "optional feasibility score, unresolved questions, and conditional gating.",
    parameters: Type.Object({
      verdict: Type.Union(
        [Type.Literal("go"), Type.Literal("no_go"), Type.Literal("conditional")],
        { description: "Overall verdict for the proposed plan" },
      ),
      plan_under_review: Type.String({
        description: "Artifact ID or path of the plan being reviewed",
      }),
      gate_checklist: Type.Record(Type.String(), Type.Boolean(), {
        description: "Spec-gate items, each marked pass/fail",
      }),
      risk_inventory: Type.Array(Type.Object({
        risk: Type.String(),
        likelihood: Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
        ]),
        impact: Type.Union([
          Type.Literal("low"),
          Type.Literal("medium"),
          Type.Literal("high"),
        ]),
        mitigation: Type.String(),
      }), {
        minItems: 0,
        description: "Inventory of identified risks with likelihood, impact, and mitigation",
      }),
      feasibility_score: Type.Optional(Type.Union([
        Type.Literal("high"),
        Type.Literal("medium"),
        Type.Literal("low"),
      ])),
      unresolved_questions: Type.Optional(Type.Array(Type.String())),
      conditions: Type.Optional(Type.Array(Type.String(), {
        description: "Conditions that must be met for a 'conditional' verdict to convert to 'go'",
      })),
      source_issue: Type.Optional(Type.String({
        description: "Paperclip issue ID the plan was produced for",
      })),
      review_text: Type.String({
        description: "Narrative explanation of the verdict",
      }),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const { errors, warnings } = validateByStyle(
          KIND_PROFILES, "plan_review", [], params,
        );
        if (errors.length > 0) {
          return {
            content: [{ type: "text" as const, text: `Validation failed:\n${errors.join("\n")}` }],
          };
        }

        const sessionId = getSessionId();
        const content =
          `${params.review_text}\n\n## Risks\n${JSON.stringify(params.risk_inventory, null, 2)}`;

        const result = await client.write({
          type: "plan_review",
          bucket: "artifacts",
          filename: "plan_review.md",
          mime: "text/markdown",
          content,
          metadata: {
            verdict: params.verdict,
            plan_under_review: params.plan_under_review,
            gate_checklist: params.gate_checklist,
            risk_inventory: params.risk_inventory,
            feasibility_score: params.feasibility_score || undefined,
            unresolved_questions: params.unresolved_questions || [],
            conditions: params.conditions || [],
            source_issue: params.source_issue || undefined,
            session_id: sessionId,
          },
          run_id: sessionId,
        });

        const parts = [
          `Plan review recorded: ${result.id}`,
          `Verdict: ${params.verdict}`,
          `Plan under review: ${params.plan_under_review}`,
          `Risks: ${params.risk_inventory.length}`,
        ];
        if (warnings.length > 0) parts.push(`\nWarnings:\n${warnings.join("\n")}`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: {
            id: result.id,
            verdict: params.verdict,
            risk_count: params.risk_inventory.length,
            warnings,
          },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- record_stage_gate ----
  pi.registerTool({
    name: "record_stage_gate",
    label: "Record Stage Gate",
    description:
      "Record a QA verdict on a stage-to-stage handoff. " +
      "Lists input artifacts crossing the gate, named gate criteria as pass/fail, " +
      "and any blocking issues that must be resolved before the gate can pass.",
    parameters: Type.Object({
      verdict: Type.Union(
        [Type.Literal("pass"), Type.Literal("block"), Type.Literal("conditional_pass")],
        { description: "Overall verdict for the stage transition" },
      ),
      from_stage: Type.String({ description: "Stage the work is leaving" }),
      to_stage: Type.String({ description: "Stage the work is entering" }),
      inputs: Type.Array(Type.String(), {
        minItems: 1,
        description: "Artifact IDs entering the gate",
      }),
      gate_criteria: Type.Record(Type.String(), Type.Boolean(), {
        description: "Map of named gate criteria to pass/fail booleans",
      }),
      blocking_issues: Type.Optional(Type.Array(Type.Object({
        issue: Type.String(),
        severity: Type.Union([
          Type.Literal("critical"),
          Type.Literal("major"),
          Type.Literal("minor"),
        ]),
        owner_agent: Type.String(),
      }))),
      conditions: Type.Optional(Type.Array(Type.String(), {
        description: "Conditions required for a 'conditional_pass' verdict",
      })),
      source_issue: Type.Optional(Type.String({
        description: "Paperclip issue ID for the stage transition",
      })),
      prior_gate_ref: Type.Optional(Type.String({
        description: "Artifact ID of a prior gate this one supersedes",
      })),
      gate_text: Type.String({
        description: "Narrative explanation of the gate verdict",
      }),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const { errors, warnings } = validateByStyle(
          KIND_PROFILES, "stage_gate", [], params,
        );
        if (errors.length > 0) {
          return {
            content: [{ type: "text" as const, text: `Validation failed:\n${errors.join("\n")}` }],
          };
        }

        const sessionId = getSessionId();
        const blocking = params.blocking_issues ?? [];
        const content =
          `${params.gate_text}\n\n## Blocking issues\n${JSON.stringify(blocking, null, 2)}`;

        const result = await client.write({
          type: "stage_gate",
          bucket: "artifacts",
          filename: "stage_gate.md",
          mime: "text/markdown",
          content,
          metadata: {
            verdict: params.verdict,
            from_stage: params.from_stage,
            to_stage: params.to_stage,
            inputs: params.inputs,
            gate_criteria: params.gate_criteria,
            blocking_issues: blocking,
            conditions: params.conditions || [],
            source_issue: params.source_issue || undefined,
            prior_gate_ref: params.prior_gate_ref || undefined,
            session_id: sessionId,
          },
          run_id: sessionId,
        });

        const parts = [
          `Stage gate recorded: ${result.id}`,
          `Verdict: ${params.verdict}`,
          `Transition: ${params.from_stage} → ${params.to_stage}`,
          `Inputs: ${params.inputs.length}`,
          `Blocking issues: ${blocking.length}`,
        ];
        if (warnings.length > 0) parts.push(`\nWarnings:\n${warnings.join("\n")}`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: {
            id: result.id,
            verdict: params.verdict,
            input_count: params.inputs.length,
            blocking_count: blocking.length,
            warnings,
          },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- query_assessments ----
  pi.registerTool({
    name: "query_assessments",
    label: "Query Assessments",
    description:
      "Search recorded QA assessments (artifact_review, plan_review, stage_gate) with optional filters. " +
      "Returns matching assessments sorted by created_at descending.",
    parameters: Type.Object({
      kind: Type.Optional(Type.Union([
        Type.Literal("artifact_review"),
        Type.Literal("plan_review"),
        Type.Literal("stage_gate"),
      ], { description: "Limit results to a single assessment kind. Defaults to all three." })),
      agent: Type.Optional(Type.String({ description: "Filter by producing QA agent (defaults to own)" })),
      session_id: Type.Optional(Type.String({ description: "Filter by session" })),
      verdict: Type.Optional(Type.String({
        description: "Filter by verdict value. Valid values depend on kind.",
      })),
      producing_agent: Type.Optional(Type.String({
        description: "For artifact_review: filter by the agent that produced the reviewed artifact",
      })),
      from_stage: Type.Optional(Type.String({
        description: "For stage_gate: filter by from_stage",
      })),
      to_stage: Type.Optional(Type.String({
        description: "For stage_gate: filter by to_stage",
      })),
      source_issue: Type.Optional(Type.String({
        description: "Filter by source Paperclip issue ID",
      })),
      since: Type.Optional(Type.String({ description: "ISO 8601 — only assessments after this timestamp" })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, description: "Max results, default 50" })),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const targetAgent: string = params.agent || agentName;
        const kindsToFetch: AssessmentKind[] = params.kind
          ? [params.kind as AssessmentKind]
          : [...ASSESSMENT_KINDS];

        const baseMetaFilter: Record<string, unknown> = {};
        if (params.session_id) baseMetaFilter.session_id = params.session_id;

        const fetched = await Promise.all(
          kindsToFetch.map(kind =>
            client.list({
              type: kind,
              agent: targetAgent,
              since: params.since,
              metadata:
                Object.keys(baseMetaFilter).length > 0 ? baseMetaFilter : undefined,
            }),
          ),
        );

        let records: client.ArtifactRecord[] = fetched.flat();

        // Post-filters that can't be expressed in client.list metadata equality.
        if (params.verdict) {
          records = records.filter(r => (r.metadata as any).verdict === params.verdict);
        }
        if (params.producing_agent) {
          records = records.filter(r =>
            r.artifact_type === "artifact_review" &&
            (r.metadata as any).producing_agent === params.producing_agent,
          );
        }
        if (params.from_stage) {
          records = records.filter(r =>
            r.artifact_type === "stage_gate" &&
            (r.metadata as any).from_stage === params.from_stage,
          );
        }
        if (params.to_stage) {
          records = records.filter(r =>
            r.artifact_type === "stage_gate" &&
            (r.metadata as any).to_stage === params.to_stage,
          );
        }
        if (params.source_issue) {
          records = records.filter(r => (r.metadata as any).source_issue === params.source_issue);
        }

        records.sort((a, b) => b.created_at.localeCompare(a.created_at));

        const limit = params.limit || 50;
        records = records.slice(0, limit);

        if (records.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No assessments match the filters." }],
            details: { count: 0 },
          };
        }

        const lines: string[] = [`Found ${records.length} assessment(s):\n`];
        for (const rec of records) lines.push(formatLine(rec));

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
          details: { count: records.length },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });

  // ---- get_assessment ----
  pi.registerTool({
    name: "get_assessment",
    label: "Get Assessment",
    description:
      "Retrieve a specific QA assessment by its artifact ID. " +
      "Only returns artifacts of type artifact_review, plan_review, or stage_gate.",
    parameters: Type.Object({
      id: Type.String({ description: "Artifact ID of the assessment" }),
    }),
    async execute(_toolCallId: string, params: Record<string, any>, _signal?: AbortSignal) {
      try {
        const { content: rawContent, metadata: rec } = await client.read(params.id);

        if (!(ASSESSMENT_KINDS as readonly string[]).includes(rec.artifact_type)) {
          return {
            content: [{
              type: "text" as const,
              text: `Error: artifact ${params.id} has type '${rec.artifact_type}', which is not a QA assessment`,
            }],
          };
        }

        const text = rawContent.toString("utf8");
        const payload = {
          id: rec.id,
          kind: rec.artifact_type,
          agent: rec.agent_name,
          created_at: rec.created_at,
          metadata: rec.metadata,
          content: text,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: { id: rec.id, kind: rec.artifact_type },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
      }
    },
  });
}
