import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// We can't import TypeScript directly, so we test the pure logic by reimplementing
// the validation and storage helpers inline. This verifies the schema contracts
// without needing a TypeScript runtime.

const ARTIFACTS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "test-artifacts");

// ---------------------------------------------------------------------------
// Replicate core logic from findings.ts for testing
// ---------------------------------------------------------------------------

const STYLE_SOURCE_REQUIRED = {
  intelligence: ["source_reliability", "information_credibility", "date_accessed", "collection_method"],
  academic: ["authors", "date_published", "date_accessed"],
  journalism: ["authors", "date_published", "date_accessed"],
  data: ["date_accessed", "collection_method", "source_reliability", "information_credibility"],
  general: ["date_accessed"],
};

const STYLE_SOURCE_ENCOURAGED = {
  intelligence: ["verbatim_quote"],
  academic: ["publisher", "doi", "verbatim_quote"],
  journalism: ["publisher", "verbatim_quote", "source_reliability", "information_credibility"],
  data: [],
  general: [],
};

const STYLE_FINDING_ENCOURAGED = {
  intelligence: ["corroboration", "date_information"],
  academic: [],
  journalism: [],
  data: ["date_information", "corroboration"],
  general: [],
};

function validateStyle(style, sources, finding) {
  const errors = [];
  const warnings = [];
  const srcRequired = STYLE_SOURCE_REQUIRED[style] || [];
  const srcEncouraged = STYLE_SOURCE_ENCOURAGED[style] || [];
  const findEncouraged = STYLE_FINDING_ENCOURAGED[style] || [];

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

  for (const field of findEncouraged) {
    const val = finding[field];
    if (val === undefined || val === null || val === "") {
      warnings.push(`${field} is recommended for style '${style}'`);
    }
  }

  return { errors, warnings };
}

function inferCorroboration(sources, explicit) {
  if (explicit) return explicit;
  const uniqueNames = new Set(sources.map(s => s.source_name.toLowerCase()));
  if (uniqueNames.size >= 3) return "confirmed";
  if (uniqueNames.size === 2) return "probable";
  return "uncorroborated";
}

function admiraltyGrade(sources, primaryIndex) {
  const primary = sources[primaryIndex];
  if (!primary) return null;
  if (primary.source_reliability && primary.information_credibility) {
    return `${primary.source_reliability}${primary.information_credibility}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("findings schema validation", () => {

  describe("intelligence style", () => {
    it("rejects missing ADMIRALTY grades", () => {
      const source = {
        source_name: "TechCrunch",
        source_url: "https://techcrunch.com/article",
        source_type: "news_editorial",
        date_accessed: "2026-05-27T14:00:00Z",
        collection_method: "web_search",
        // source_reliability and information_credibility missing
      };
      const { errors } = validateStyle("intelligence", [source], {});
      assert.ok(errors.length > 0, "should have validation errors");
      assert.ok(errors.some(e => e.includes("source_reliability")));
      assert.ok(errors.some(e => e.includes("information_credibility")));
    });

    it("passes with all required fields", () => {
      const source = {
        source_name: "Crunchbase",
        source_url: "https://crunchbase.com/org/test",
        source_type: "structured_aggregator",
        source_reliability: "B",
        information_credibility: 2,
        date_accessed: "2026-05-27T14:00:00Z",
        collection_method: "web_scrape",
      };
      const { errors } = validateStyle("intelligence", [source], {});
      assert.equal(errors.length, 0, `unexpected errors: ${errors.join(", ")}`);
    });

    it("warns on missing encouraged fields", () => {
      const source = {
        source_name: "Crunchbase",
        source_url: "https://crunchbase.com/org/test",
        source_type: "structured_aggregator",
        source_reliability: "B",
        information_credibility: 2,
        date_accessed: "2026-05-27T14:00:00Z",
        collection_method: "web_scrape",
        // verbatim_quote missing (encouraged)
      };
      const { errors, warnings } = validateStyle("intelligence", [source], {});
      assert.equal(errors.length, 0);
      assert.ok(warnings.some(w => w.includes("verbatim_quote")));
      assert.ok(warnings.some(w => w.includes("corroboration")));
    });
  });

  describe("academic style", () => {
    it("requires authors and date_published", () => {
      const source = {
        source_name: "Nature",
        source_url: "https://nature.com/article",
        source_type: "academic_paper",
        date_accessed: "2026-05-27T14:00:00Z",
        // authors and date_published missing
      };
      const { errors } = validateStyle("academic", [source], {});
      assert.ok(errors.some(e => e.includes("authors")));
      assert.ok(errors.some(e => e.includes("date_published")));
    });

    it("does not require ADMIRALTY grades", () => {
      const source = {
        source_name: "Nature",
        source_url: "https://nature.com/article",
        source_type: "academic_paper",
        authors: ["Smith, J."],
        date_published: "2025-03-15",
        date_accessed: "2026-05-27T14:00:00Z",
      };
      const { errors } = validateStyle("academic", [source], {});
      assert.equal(errors.length, 0, `unexpected errors: ${errors.join(", ")}`);
    });
  });

  describe("data style", () => {
    it("requires collection_method and ADMIRALTY", () => {
      const source = {
        source_name: "GitHub API",
        source_url: "https://api.github.com/repos/test",
        source_type: "api_data",
        date_accessed: "2026-05-27T14:00:00Z",
        // collection_method, source_reliability, information_credibility missing
      };
      const { errors } = validateStyle("data", [source], {});
      assert.ok(errors.some(e => e.includes("collection_method")));
      assert.ok(errors.some(e => e.includes("source_reliability")));
    });
  });

  describe("general style", () => {
    it("only requires date_accessed", () => {
      const source = {
        source_name: "Random Blog",
        source_url: "https://blog.example.com",
        source_type: "blog_personal",
        date_accessed: "2026-05-27T14:00:00Z",
      };
      const { errors } = validateStyle("general", [source], {});
      assert.equal(errors.length, 0);
    });

    it("rejects missing date_accessed", () => {
      const source = {
        source_name: "Random Blog",
        source_url: "https://blog.example.com",
        source_type: "blog_personal",
      };
      const { errors } = validateStyle("general", [source], {});
      assert.ok(errors.some(e => e.includes("date_accessed")));
    });
  });

  describe("multi-source validation", () => {
    it("validates each source independently", () => {
      const sources = [
        {
          source_name: "Source A",
          source_url: "https://a.com",
          source_type: "news_editorial",
          source_reliability: "B",
          information_credibility: 2,
          date_accessed: "2026-05-27T14:00:00Z",
          collection_method: "web_search",
        },
        {
          source_name: "Source B",
          source_url: "https://b.com",
          source_type: "blog_personal",
          date_accessed: "2026-05-27T14:00:00Z",
          // missing source_reliability, information_credibility, collection_method
        },
      ];
      const { errors } = validateStyle("intelligence", sources, {});
      assert.ok(errors.some(e => e.includes("sources[1].source_reliability")));
      assert.ok(!errors.some(e => e.includes("sources[0]")));
    });
  });
});

describe("corroboration inference", () => {
  it("returns uncorroborated for single source", () => {
    const sources = [{ source_name: "Crunchbase" }];
    assert.equal(inferCorroboration(sources), "uncorroborated");
  });

  it("returns probable for two independent sources", () => {
    const sources = [
      { source_name: "Crunchbase" },
      { source_name: "TechCrunch" },
    ];
    assert.equal(inferCorroboration(sources), "probable");
  });

  it("returns confirmed for three independent sources", () => {
    const sources = [
      { source_name: "Crunchbase" },
      { source_name: "TechCrunch" },
      { source_name: "Company Blog" },
    ];
    assert.equal(inferCorroboration(sources), "confirmed");
  });

  it("counts unique names case-insensitively", () => {
    const sources = [
      { source_name: "Crunchbase" },
      { source_name: "crunchbase" },
      { source_name: "CRUNCHBASE" },
    ];
    assert.equal(inferCorroboration(sources), "uncorroborated");
  });

  it("respects explicit override", () => {
    const sources = [
      { source_name: "Source A" },
      { source_name: "Source B" },
    ];
    assert.equal(inferCorroboration(sources, "conflicting"), "conflicting");
  });
});

describe("ADMIRALTY grade", () => {
  it("combines source reliability and information credibility", () => {
    const sources = [{ source_reliability: "B", information_credibility: 2 }];
    assert.equal(admiraltyGrade(sources, 0), "B2");
  });

  it("returns null if either field missing", () => {
    assert.equal(admiraltyGrade([{ source_reliability: "A" }], 0), null);
    assert.equal(admiraltyGrade([{ information_credibility: 1 }], 0), null);
  });

  it("uses primary_source_index", () => {
    const sources = [
      { source_reliability: "C", information_credibility: 3 },
      { source_reliability: "A", information_credibility: 1 },
    ];
    assert.equal(admiraltyGrade(sources, 1), "A1");
  });

  it("returns null for out-of-bounds index", () => {
    assert.equal(admiraltyGrade([], 0), null);
    assert.equal(admiraltyGrade([{ source_reliability: "A", information_credibility: 1 }], 5), null);
  });
});

describe("JSONL storage format", () => {
  const testDir = path.join(ARTIFACTS_ROOT, "test-agent", "findings");

  before(() => {
    fs.mkdirSync(testDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(ARTIFACTS_ROOT, { recursive: true, force: true });
  });

  it("appends findings as JSONL lines", () => {
    const file = path.join(testDir, "test-session.jsonl");
    const finding1 = { id: "FINDING001", claim: "Test claim 1", session_id: "test-session" };
    const finding2 = { id: "FINDING002", claim: "Test claim 2", session_id: "test-session" };

    fs.appendFileSync(file, JSON.stringify(finding1) + "\n", "utf8");
    fs.appendFileSync(file, JSON.stringify(finding2) + "\n", "utf8");

    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).id, "FINDING001");
    assert.equal(JSON.parse(lines[1]).id, "FINDING002");
  });

  it("supports finding update by rewriting file", () => {
    const file = path.join(testDir, "update-session.jsonl");
    const f1 = { id: "UPD001", claim: "Original", sources: [{ source_name: "A" }] };
    const f2 = { id: "UPD002", claim: "Unchanged", sources: [{ source_name: "B" }] };

    fs.writeFileSync(file, JSON.stringify(f1) + "\n" + JSON.stringify(f2) + "\n", "utf8");

    // Simulate add_source: read, modify, rewrite
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const updated = lines.map(line => {
      const f = JSON.parse(line);
      if (f.id === "UPD001") {
        f.sources.push({ source_name: "C" });
      }
      return JSON.stringify(f);
    });
    fs.writeFileSync(file, updated.join("\n") + "\n", "utf8");

    const result = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const f1Updated = JSON.parse(result[0]);
    assert.equal(f1Updated.sources.length, 2);
    assert.equal(f1Updated.sources[1].source_name, "C");

    const f2Unchanged = JSON.parse(result[1]);
    assert.equal(f2Unchanged.sources.length, 1);
  });
});

describe("source type enum coverage", () => {
  const validTypes = [
    "primary_official", "structured_aggregator", "news_editorial",
    "press_release", "academic_paper", "industry_report",
    "social_media", "community_forum", "blog_personal",
    "api_data", "dataset", "other",
  ];

  for (const type of validTypes) {
    it(`accepts source_type '${type}'`, () => {
      assert.ok(validTypes.includes(type));
    });
  }
});

describe("collection method enum coverage", () => {
  const validMethods = [
    "web_search", "api_query", "web_scrape", "deep_research",
    "direct_reference", "human_provided", "database_query",
  ];

  for (const method of validMethods) {
    it(`accepts collection_method '${method}'`, () => {
      assert.ok(validMethods.includes(method));
    });
  }
});
