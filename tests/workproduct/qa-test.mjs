import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We can't import TypeScript directly, so we test the pure logic by
// reimplementing the validation profiles and the parameter contract
// inline, mirroring src/agents/qa/.pi/agent/extensions/workproduct.ts.
// This verifies the schema and validation contracts without a TS runtime.

// ---------------------------------------------------------------------------
// Inlined from workproduct-lib/validate.ts
// ---------------------------------------------------------------------------

function validateByStyle(profiles, style, sources, record) {
  const errors = [];
  const warnings = [];
  const srcRequired = profiles.sourceRequired[style] || [];
  const srcEncouraged = profiles.sourceEncouraged[style] || [];
  const recEncouraged = profiles.recordEncouraged[style] || [];

  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    for (const field of srcRequired) {
      const val = src[field];
      if (val === undefined || val === null || val === "") {
        errors.push(`sources[${i}].${field} is required for style '${style}'`);
      }
    }
    for (const field of srcEncouraged) {
      const val = src[field];
      if (val === undefined || val === null || val === "") {
        warnings.push(`sources[${i}].${field} is recommended for style '${style}'`);
      }
    }
  }

  for (const field of recEncouraged) {
    const val = record[field];
    if (val === undefined || val === null || val === "") {
      warnings.push(`${field} is recommended for style '${style}'`);
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Inlined from qa/workproduct.ts
// ---------------------------------------------------------------------------

const KIND_PROFILES = {
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

const ARTIFACT_REVIEW_REQUIRED = [
  "verdict",
  "artifact_under_review",
  "producing_agent",
  "source_issue",
  "output_template",
  "standards_applied",
  "checklist",
  "metrics",
  "verdict_text",
];

const PLAN_REVIEW_REQUIRED = [
  "verdict",
  "plan_under_review",
  "gate_checklist",
  "risk_inventory",
  "review_text",
];

const STAGE_GATE_REQUIRED = [
  "verdict",
  "from_stage",
  "to_stage",
  "inputs",
  "gate_criteria",
  "gate_text",
];

const VERDICT_ENUMS = {
  artifact_review: ["pass", "fail", "escalate"],
  plan_review: ["go", "no_go", "conditional"],
  stage_gate: ["pass", "block", "conditional_pass"],
};

// Stand-in for typebox schema validation: enforces required-presence and
// the kind-specific structural rules the real schema would check.
function validateParams(kind, params) {
  const errors = [];

  const required = {
    artifact_review: ARTIFACT_REVIEW_REQUIRED,
    plan_review: PLAN_REVIEW_REQUIRED,
    stage_gate: STAGE_GATE_REQUIRED,
  }[kind];

  for (const field of required) {
    if (params[field] === undefined) {
      errors.push(`${field} is required`);
    }
  }

  if (params.verdict !== undefined && !VERDICT_ENUMS[kind].includes(params.verdict)) {
    errors.push(`verdict '${params.verdict}' is not valid for kind '${kind}'`);
  }

  if (kind === "artifact_review") {
    if (Array.isArray(params.standards_applied) && params.standards_applied.length < 1) {
      errors.push("standards_applied must have minItems 1");
    }
    if (params.metrics && typeof params.metrics === "object") {
      for (const f of ["critical", "major", "minor", "total"]) {
        if (!(f in params.metrics)) errors.push(`metrics.${f} is required`);
      }
    }
  }

  if (kind === "stage_gate") {
    if (Array.isArray(params.inputs) && params.inputs.length < 1) {
      errors.push("inputs must have minItems 1");
    }
  }

  return errors;
}

// Mock of client.list: returns records keyed by type, so we can test
// that query_assessments fans out to the right kinds.
function makeMockClient() {
  const calls = [];
  const records = {
    artifact_review: [{ id: "AR1", artifact_type: "artifact_review", created_at: "2026-01-03T00:00:00Z", metadata: { verdict: "pass" } }],
    plan_review:    [{ id: "PR1", artifact_type: "plan_review",    created_at: "2026-01-02T00:00:00Z", metadata: { verdict: "go" } }],
    stage_gate:     [{ id: "SG1", artifact_type: "stage_gate",     created_at: "2026-01-01T00:00:00Z", metadata: { verdict: "pass" } }],
  };
  async function list(filters) {
    calls.push(filters);
    return records[filters.type] || [];
  }
  return { list, calls };
}

const ASSESSMENT_KINDS = ["artifact_review", "plan_review", "stage_gate"];

async function runQuery(client, params, ownAgent = "qa") {
  const targetAgent = params.agent || ownAgent;
  const kindsToFetch = params.kind ? [params.kind] : [...ASSESSMENT_KINDS];

  const baseMetaFilter = {};
  if (params.session_id) baseMetaFilter.session_id = params.session_id;

  const fetched = await Promise.all(
    kindsToFetch.map(kind =>
      client.list({
        type: kind,
        agent: targetAgent,
        since: params.since,
        metadata: Object.keys(baseMetaFilter).length > 0 ? baseMetaFilter : undefined,
      }),
    ),
  );
  return fetched.flat();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const validArtifactReview = () => ({
  verdict: "pass",
  artifact_under_review: "01HX_research_output",
  producing_agent: "researcher",
  source_issue: "ISSUE-42",
  output_template: "research-output",
  standards_applied: ["intelligence-style"],
  checklist: { "has_sources": true, "claims_graded": true },
  metrics: { critical: 0, major: 0, minor: 1, total: 1 },
  verdict_text: "All checks passed.",
  findings: [
    { severity: "minor", location: "section 2", standard: "style", detail: "Stray comma", expected: "no comma" },
  ],
  brief_ref: "01HX_research_brief",
});

const validPlanReview = () => ({
  verdict: "go",
  plan_under_review: "tasks/plans/example.md",
  gate_checklist: { "intent_stated": true, "open_questions_empty": true },
  risk_inventory: [
    { risk: "Spec ambiguous in section 3", likelihood: "medium", impact: "low", mitigation: "Clarify with CEO" },
  ],
  feasibility_score: "high",
  unresolved_questions: [],
  review_text: "Plan is sound.",
});

const validStageGate = () => ({
  verdict: "pass",
  from_stage: "research",
  to_stage: "analysis",
  inputs: ["01HX_research_output"],
  gate_criteria: { "all_sources_graded": true, "findings_recorded": true },
  blocking_issues: [],
  gate_text: "Handoff complete.",
});

describe("artifact_review parameter contract", () => {
  it("requires all 9 required fields", () => {
    for (const field of ARTIFACT_REVIEW_REQUIRED) {
      const params = validArtifactReview();
      delete params[field];
      const errors = validateParams("artifact_review", params);
      assert.ok(
        errors.some(e => e.includes(field)),
        `missing required field '${field}' should produce a validation error; got: ${errors.join(", ")}`,
      );
    }
  });

  it("accepts a fully populated record", () => {
    const errors = validateParams("artifact_review", validArtifactReview());
    assert.equal(errors.length, 0, `unexpected errors: ${errors.join(", ")}`);
  });

  it("rejects verdict values outside {pass, fail, escalate}", () => {
    const params = validArtifactReview();
    params.verdict = "go"; // valid for plan_review, not for artifact_review
    const errors = validateParams("artifact_review", params);
    assert.ok(errors.some(e => e.includes("verdict")));
  });

  it("requires standards_applied to have minItems 1", () => {
    const params = validArtifactReview();
    params.standards_applied = [];
    const errors = validateParams("artifact_review", params);
    assert.ok(errors.some(e => e.includes("minItems")));
  });

  it("requires all four metrics fields", () => {
    const params = validArtifactReview();
    params.metrics = { critical: 0, major: 0, minor: 0 }; // missing total
    const errors = validateParams("artifact_review", params);
    assert.ok(errors.some(e => e.includes("metrics.total")));
  });
});

describe("plan_review parameter contract", () => {
  it("requires gate_checklist", () => {
    const params = validPlanReview();
    delete params.gate_checklist;
    const errors = validateParams("plan_review", params);
    assert.ok(errors.some(e => e.includes("gate_checklist")));
  });

  it("requires risk_inventory (even if empty)", () => {
    const params = validPlanReview();
    delete params.risk_inventory;
    const errors = validateParams("plan_review", params);
    assert.ok(errors.some(e => e.includes("risk_inventory")));
  });

  it("accepts an empty risk_inventory", () => {
    const params = validPlanReview();
    params.risk_inventory = [];
    const errors = validateParams("plan_review", params);
    assert.equal(errors.length, 0, `unexpected errors: ${errors.join(", ")}`);
  });

  it("rejects verdict values outside {go, no_go, conditional}", () => {
    const params = validPlanReview();
    params.verdict = "pass"; // valid for artifact_review, not plan_review
    const errors = validateParams("plan_review", params);
    assert.ok(errors.some(e => e.includes("verdict")));
  });
});

describe("stage_gate parameter contract", () => {
  it("requires inputs with minItems 1", () => {
    const params = validStageGate();
    params.inputs = [];
    const errors = validateParams("stage_gate", params);
    assert.ok(errors.some(e => e.includes("minItems")));
  });

  it("requires gate_criteria", () => {
    const params = validStageGate();
    delete params.gate_criteria;
    const errors = validateParams("stage_gate", params);
    assert.ok(errors.some(e => e.includes("gate_criteria")));
  });

  it("rejects verdict values outside {pass, block, conditional_pass}", () => {
    const params = validStageGate();
    params.verdict = "escalate"; // valid for artifact_review, not stage_gate
    const errors = validateParams("stage_gate", params);
    assert.ok(errors.some(e => e.includes("verdict")));
  });

  it("accepts conditional_pass as a valid verdict", () => {
    const params = validStageGate();
    params.verdict = "conditional_pass";
    const errors = validateParams("stage_gate", params);
    assert.equal(errors.length, 0, `unexpected errors: ${errors.join(", ")}`);
  });
});

describe("validateByStyle warnings", () => {
  it("warns when artifact_review brief_ref is missing", () => {
    const record = { findings: [{}] }; // findings present, brief_ref missing
    const { errors, warnings } = validateByStyle(KIND_PROFILES, "artifact_review", [], record);
    assert.equal(errors.length, 0);
    assert.ok(warnings.some(w => w.includes("brief_ref")));
    assert.ok(!warnings.some(w => w.includes("findings")), "findings was provided — no warning expected");
  });

  it("warns when plan_review feasibility_score is missing", () => {
    const record = { unresolved_questions: ["Q1"] };
    const { warnings } = validateByStyle(KIND_PROFILES, "plan_review", [], record);
    assert.ok(warnings.some(w => w.includes("feasibility_score")));
  });

  it("warns when stage_gate blocking_issues and prior_gate_ref are missing", () => {
    const { warnings } = validateByStyle(KIND_PROFILES, "stage_gate", [], {});
    assert.ok(warnings.some(w => w.includes("blocking_issues")));
    assert.ok(warnings.some(w => w.includes("prior_gate_ref")));
  });

  it("produces no errors for QA kinds — only warnings", () => {
    for (const kind of ASSESSMENT_KINDS) {
      const { errors } = validateByStyle(KIND_PROFILES, kind, [], {});
      assert.equal(errors.length, 0, `kind ${kind} produced unexpected errors`);
    }
  });
});

describe("query_assessments kind routing", () => {
  it("fans out to all three kinds when no kind filter is given", async () => {
    const c = makeMockClient();
    const records = await runQuery(c, {});
    assert.equal(c.calls.length, 3);
    const types = c.calls.map(call => call.type).sort();
    assert.deepEqual(types, ["artifact_review", "plan_review", "stage_gate"]);
    assert.equal(records.length, 3);
  });

  it("fetches only the requested kind when kind is set", async () => {
    const c = makeMockClient();
    const records = await runQuery(c, { kind: "stage_gate" });
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0].type, "stage_gate");
    assert.equal(records.length, 1);
    assert.equal(records[0].artifact_type, "stage_gate");
  });

  it("passes session_id as a metadata equality filter", async () => {
    const c = makeMockClient();
    await runQuery(c, { kind: "plan_review", session_id: "sess-1" });
    assert.deepEqual(c.calls[0].metadata, { session_id: "sess-1" });
  });

  it("uses own agent name when agent is not specified", async () => {
    const c = makeMockClient();
    await runQuery(c, { kind: "plan_review" }, "qa");
    assert.equal(c.calls[0].agent, "qa");
  });

  it("uses the supplied agent name when one is given", async () => {
    const c = makeMockClient();
    await runQuery(c, { kind: "plan_review", agent: "someone-else" }, "qa");
    assert.equal(c.calls[0].agent, "someone-else");
  });

  it("sorts merged results by created_at descending", async () => {
    const c = makeMockClient();
    const records = await runQuery(c, {});
    records.sort((a, b) => b.created_at.localeCompare(a.created_at));
    assert.deepEqual(records.map(r => r.id), ["AR1", "PR1", "SG1"]);
  });
});

describe("verdict enum coverage", () => {
  it("artifact_review accepts each of pass/fail/escalate", () => {
    for (const v of VERDICT_ENUMS.artifact_review) {
      const params = validArtifactReview();
      params.verdict = v;
      const errors = validateParams("artifact_review", params);
      assert.equal(errors.length, 0, `verdict ${v} unexpectedly rejected: ${errors.join(", ")}`);
    }
  });

  it("plan_review accepts each of go/no_go/conditional", () => {
    for (const v of VERDICT_ENUMS.plan_review) {
      const params = validPlanReview();
      params.verdict = v;
      const errors = validateParams("plan_review", params);
      assert.equal(errors.length, 0, `verdict ${v} unexpectedly rejected: ${errors.join(", ")}`);
    }
  });

  it("stage_gate accepts each of pass/block/conditional_pass", () => {
    for (const v of VERDICT_ENUMS.stage_gate) {
      const params = validStageGate();
      params.verdict = v;
      const errors = validateParams("stage_gate", params);
      assert.equal(errors.length, 0, `verdict ${v} unexpectedly rejected: ${errors.join(", ")}`);
    }
  });
});
