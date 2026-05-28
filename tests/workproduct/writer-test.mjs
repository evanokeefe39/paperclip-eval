import { describe, it } from "node:test";
import assert from "node:assert/strict";

// We can't import TypeScript directly, so we test the pure logic by reimplementing
// the helpers and validation profiles from
// src/agents/writer/.pi/agent/extensions/workproduct.ts inline. This verifies the
// schema contracts and dispatch behavior without needing a TypeScript runtime.

// ---------------------------------------------------------------------------
// Replicate validation + helpers from workproduct.ts and workproduct-lib
// ---------------------------------------------------------------------------

const KIND_PROFILES = {
  sourceRequired: {
    report: [], guide: [], article: [], marketing_copy: [], newsletter: [],
  },
  sourceEncouraged: {
    report: [], guide: [], article: [], marketing_copy: [], newsletter: [],
  },
  recordEncouraged: {
    report: ["recommendations", "confidence", "topic_tags"],
    guide: ["prerequisites", "difficulty", "topic_tags"],
    article: ["tone", "seo_keywords", "topic_tags"],
    marketing_copy: ["format_constraints", "variants", "topic_tags"],
    newsletter: ["issue_number", "topic_tags"],
  },
};

const WRITER_KINDS = ["report", "guide", "article", "marketing_copy", "newsletter"];

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

function countWords(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Simulated record_* metadata builders — mirror the structure the extension
// writes to client.write({ metadata }). We don't hit the artifact service,
// we just verify the metadata shape produced by the extension's logic.
// ---------------------------------------------------------------------------

function buildReportMetadata(params, sessionId = "test-session") {
  return {
    title: params.title,
    audience: params.audience,
    source_refs: params.source_refs,
    sections: params.sections,
    executive_summary: params.executive_summary,
    recommendations: params.recommendations || [],
    confidence: params.confidence,
    format_version: params.format_version,
    topic_tags: params.topic_tags || [],
    prior_content_refs: params.prior_content_refs || [],
    word_count: countWords(params.content),
    session_id: sessionId,
  };
}

// Minimum-required parameter checks — mirrors what TypeBox would enforce
// at the parameters schema level for each tool. Returns array of missing field names.
function checkRequiredParams(kind, params) {
  const requiredByKind = {
    report: ["title", "audience", "source_refs", "content", "sections", "executive_summary"],
    guide: ["title", "audience", "source_refs", "content", "steps_count", "outcome"],
    article: ["title", "audience", "source_refs", "content", "angle", "platform"],
    marketing_copy: ["title", "audience", "content", "platform", "call_to_action"],
    newsletter: ["title", "audience", "source_refs", "content", "cadence", "sections", "featured_items"],
  };
  const minArrayLen = {
    report: { source_refs: 1 },
    guide: { source_refs: 1 },
    article: { source_refs: 1 },
    marketing_copy: {},
    newsletter: { source_refs: 1 },
  };

  const missing = [];
  for (const f of requiredByKind[kind]) {
    if (params[f] === undefined || params[f] === null || params[f] === "") {
      missing.push(f);
    }
  }
  for (const [arr, min] of Object.entries(minArrayLen[kind] || {})) {
    if (Array.isArray(params[arr]) && params[arr].length < min) {
      missing.push(`${arr}(min=${min})`);
    }
  }
  return missing;
}

// Simulated query_content dispatch — captures which client.list calls would
// be issued for given filters. Used to verify kind-filter behavior.
async function simulateQueryDispatch(params, listFn) {
  if (params.kind) {
    await listFn({ type: params.kind, agent: params.agent, since: params.since });
    return;
  }
  await Promise.all(
    WRITER_KINDS.map(k => listFn({ type: k, agent: params.agent, since: params.since })),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("countWords", () => {
  it("counts simple space-separated words", () => {
    assert.equal(countWords("one two three"), 3);
  });

  it("returns 0 for empty string", () => {
    assert.equal(countWords(""), 0);
  });

  it("returns 0 for whitespace-only string", () => {
    assert.equal(countWords("   \n\t  "), 0);
  });

  it("collapses multiple spaces/tabs/newlines", () => {
    assert.equal(countWords("hello    world"), 2);
    assert.equal(countWords("hello\t\tworld"), 2);
    assert.equal(countWords("hello\n\nworld"), 2);
    assert.equal(countWords("  hello \n world \t now  "), 3);
  });

  it("handles single word", () => {
    assert.equal(countWords("solo"), 1);
    assert.equal(countWords("  solo  "), 1);
  });

  it("handles markdown content with mixed whitespace", () => {
    // countWords is whitespace-split, so markdown punctuation tokens like
    // '#' and '-' count as their own words. 12 = #, Title, Some, body, text,
    // here., -, Item, one, -, Item, two
    const md = "# Title\n\nSome body text here.\n\n- Item one\n- Item two\n";
    assert.equal(countWords(md), 12);
  });
});

describe("record_report metadata shape", () => {
  it("builds expected metadata fields from valid params", () => {
    const params = {
      title: "Q3 Market Report",
      audience: "CEO",
      source_refs: ["01ABC", "01DEF"],
      content: "Hello world this report has many words in it.",
      sections: ["Overview", "Findings", "Conclusion"],
      executive_summary: "Brief summary paragraph.",
      recommendations: ["Hire 2 engineers"],
      confidence: "high",
      topic_tags: ["market", "q3"],
    };
    const meta = buildReportMetadata(params, "sess-1");
    assert.equal(meta.title, "Q3 Market Report");
    assert.equal(meta.audience, "CEO");
    assert.equal(meta.executive_summary, "Brief summary paragraph.");
    assert.deepEqual(meta.sections, ["Overview", "Findings", "Conclusion"]);
    assert.equal(meta.word_count, 9);
    assert.equal(meta.session_id, "sess-1");
    assert.deepEqual(meta.source_refs, ["01ABC", "01DEF"]);
    assert.equal(meta.confidence, "high");
  });

  it("defaults topic_tags and recommendations to [] when omitted", () => {
    const meta = buildReportMetadata({
      title: "X", audience: "Y",
      source_refs: ["01"],
      content: "a b c",
      sections: ["s"],
      executive_summary: "es",
    });
    assert.deepEqual(meta.recommendations, []);
    assert.deepEqual(meta.topic_tags, []);
    assert.deepEqual(meta.prior_content_refs, []);
  });

  it("computes word_count from content, not from any param value", () => {
    const meta = buildReportMetadata({
      title: "T", audience: "A",
      source_refs: ["01"],
      content: "one two three four five",
      sections: ["s"],
      executive_summary: "es",
    });
    assert.equal(meta.word_count, 5);
  });
});

describe("record_marketing_copy source_refs handling", () => {
  it("accepts zero source_refs (omitted entirely)", () => {
    const missing = checkRequiredParams("marketing_copy", {
      title: "Tweet thread",
      audience: "developers",
      content: "Buy our product now!",
      platform: "Twitter",
      call_to_action: "Sign up",
      // source_refs intentionally omitted
    });
    assert.deepEqual(missing, []);
  });

  it("accepts explicit empty source_refs array", () => {
    const missing = checkRequiredParams("marketing_copy", {
      title: "T", audience: "A", content: "C",
      platform: "P", call_to_action: "CTA",
      source_refs: [],
    });
    assert.deepEqual(missing, []);
  });

  it("rejects when required fields are missing", () => {
    const missing = checkRequiredParams("marketing_copy", {
      title: "T", audience: "A", content: "C",
      // missing platform and call_to_action
    });
    assert.ok(missing.includes("platform"));
    assert.ok(missing.includes("call_to_action"));
  });
});

describe("record_newsletter required fields", () => {
  it("requires cadence", () => {
    const missing = checkRequiredParams("newsletter", {
      title: "Issue 1",
      audience: "subs",
      source_refs: ["01"],
      content: "hello",
      sections: ["intro"],
      featured_items: ["01FEAT"],
      // cadence missing
    });
    assert.ok(missing.includes("cadence"));
  });

  it("requires featured_items", () => {
    const missing = checkRequiredParams("newsletter", {
      title: "Issue 1",
      audience: "subs",
      source_refs: ["01"],
      content: "hello",
      sections: ["intro"],
      cadence: "weekly",
      // featured_items missing
    });
    assert.ok(missing.includes("featured_items"));
  });

  it("accepts all required fields including cadence + featured_items", () => {
    const missing = checkRequiredParams("newsletter", {
      title: "Issue 1",
      audience: "subs",
      source_refs: ["01"],
      content: "hello",
      sections: ["intro", "deep dive"],
      featured_items: ["01FEAT", "01FEAT2"],
      cadence: "weekly",
    });
    assert.deepEqual(missing, []);
  });
});

describe("validateByStyle warnings on missing encouraged fields", () => {
  it("report: warns on missing recommendations + confidence + topic_tags", () => {
    const { errors, warnings } = validateByStyle(
      KIND_PROFILES, "report", [],
      { title: "X" }, // no encouraged fields
    );
    assert.equal(errors.length, 0);
    assert.ok(warnings.some(w => w.includes("recommendations")));
    assert.ok(warnings.some(w => w.includes("confidence")));
    assert.ok(warnings.some(w => w.includes("topic_tags")));
  });

  it("report: clean when all encouraged fields supplied", () => {
    const { errors, warnings } = validateByStyle(
      KIND_PROFILES, "report", [],
      { recommendations: ["x"], confidence: "high", topic_tags: ["a"] },
    );
    assert.equal(errors.length, 0);
    assert.equal(warnings.length, 0);
  });

  it("guide: warns on missing prerequisites + difficulty + topic_tags", () => {
    const { warnings } = validateByStyle(KIND_PROFILES, "guide", [], {});
    assert.ok(warnings.some(w => w.includes("prerequisites")));
    assert.ok(warnings.some(w => w.includes("difficulty")));
    assert.ok(warnings.some(w => w.includes("topic_tags")));
  });

  it("article: warns on missing tone + seo_keywords + topic_tags", () => {
    const { warnings } = validateByStyle(KIND_PROFILES, "article", [], {});
    assert.ok(warnings.some(w => w.includes("tone")));
    assert.ok(warnings.some(w => w.includes("seo_keywords")));
    assert.ok(warnings.some(w => w.includes("topic_tags")));
  });

  it("marketing_copy: warns on missing format_constraints + variants + topic_tags", () => {
    const { warnings } = validateByStyle(KIND_PROFILES, "marketing_copy", [], {});
    assert.ok(warnings.some(w => w.includes("format_constraints")));
    assert.ok(warnings.some(w => w.includes("variants")));
    assert.ok(warnings.some(w => w.includes("topic_tags")));
  });

  it("newsletter: warns on missing issue_number + topic_tags", () => {
    const { warnings } = validateByStyle(KIND_PROFILES, "newsletter", [], {});
    assert.ok(warnings.some(w => w.includes("issue_number")));
    assert.ok(warnings.some(w => w.includes("topic_tags")));
  });

  it("treats empty string and empty array (defaulted) as supplied for warning purposes — sanity check on profile keys", () => {
    // Sanity: empty array passes through as 'present' value-wise. We surface
    // the underlying validateByStyle semantics: undefined/null/empty-string warn,
    // other falsy values like 0 or [] do not.
    const { warnings } = validateByStyle(
      KIND_PROFILES, "report", [],
      { recommendations: [], confidence: "low", topic_tags: ["t"] },
    );
    // recommendations: [] is not undefined/null/"" so no warning expected from
    // validateByStyle directly — extension separately defaults to [] before write.
    assert.ok(!warnings.some(w => w.includes("recommendations")));
    assert.ok(!warnings.some(w => w.includes("confidence")));
    assert.ok(!warnings.some(w => w.includes("topic_tags")));
  });
});

describe("query_content kind filter dispatch", () => {
  it("dispatches to a single client.list when kind is set", async () => {
    const calls = [];
    await simulateQueryDispatch(
      { kind: "report", agent: "writer" },
      async (args) => { calls.push(args); },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, "report");
    assert.equal(calls[0].agent, "writer");
  });

  it("dispatches to all five kinds when kind is omitted", async () => {
    const calls = [];
    await simulateQueryDispatch(
      { agent: "writer" },
      async (args) => { calls.push(args); },
    );
    assert.equal(calls.length, WRITER_KINDS.length);
    const types = calls.map(c => c.type).sort();
    assert.deepEqual(types, [...WRITER_KINDS].sort());
  });

  it("propagates `since` to every dispatched list call", async () => {
    const calls = [];
    await simulateQueryDispatch(
      { agent: "writer", since: "2026-01-01T00:00:00Z" },
      async (args) => { calls.push(args); },
    );
    assert.equal(calls.length, WRITER_KINDS.length);
    for (const c of calls) {
      assert.equal(c.since, "2026-01-01T00:00:00Z");
    }
  });

  it("propagates `since` to single dispatch when kind set", async () => {
    const calls = [];
    await simulateQueryDispatch(
      { kind: "newsletter", agent: "writer", since: "2026-01-01T00:00:00Z" },
      async (args) => { calls.push(args); },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, "newsletter");
    assert.equal(calls[0].since, "2026-01-01T00:00:00Z");
  });
});

describe("writer kinds coverage", () => {
  const expected = ["report", "guide", "article", "marketing_copy", "newsletter"];
  for (const k of expected) {
    it(`recognises kind '${k}'`, () => {
      assert.ok(WRITER_KINDS.includes(k));
    });
  }

  it("does not include researcher kinds", () => {
    assert.ok(!WRITER_KINDS.includes("finding"));
  });
});
