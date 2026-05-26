export class ValidationError extends Error {
  public readonly details: string;
  constructor(details: string) {
    super(`ValidationError: ${details}`);
    this.name = "ValidationError";
    this.details = details;
  }
}

function assertObject(raw: unknown, label: string): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ValidationError(`${label}: expected object, got ${typeof raw}`);
  }
  return raw as Record<string, unknown>;
}

function assertArray(val: unknown, field: string): unknown[] {
  if (!Array.isArray(val)) {
    throw new ValidationError(`"${field}" must be an array`);
  }
  return val;
}

function assertString(val: unknown, field: string): string {
  if (typeof val !== "string") {
    throw new ValidationError(`"${field}" must be a string`);
  }
  return val;
}

function assertStringArray(val: unknown, field: string): string[] {
  const arr = assertArray(val, field);
  for (let i = 0; i < arr.length; i++) {
    assertString(arr[i], `${field}[${i}]`);
  }
  return arr as string[];
}

function validateSubQueryEntry(entry: unknown, index: number): { query: string; rationale: string } {
  const obj = assertObject(entry, `sub_queries[${index}]`);
  return {
    query: assertString(obj.query, `sub_queries[${index}].query`),
    rationale: assertString(obj.rationale, `sub_queries[${index}].rationale`),
  };
}

export function validatePlanResponse(raw: unknown): { sub_queries: Array<{ query: string; rationale: string }> } {
  const obj = assertObject(raw, "PlanResponse");
  const arr = assertArray(obj.sub_queries, "sub_queries");
  return { sub_queries: arr.map((e, i) => validateSubQueryEntry(e, i)) };
}

export function validateSelectResponse(raw: unknown): { selected_urls: string[] } {
  const obj = assertObject(raw, "SelectResponse");
  return { selected_urls: assertStringArray(obj.selected_urls, "selected_urls") };
}

export function validateExtractResponse(raw: unknown): {
  findings: Array<{ claim: string; confidence: number; entities: string[]; topic_tags: string[] }>;
} {
  const obj = assertObject(raw, "ExtractResponse");
  const arr = assertArray(obj.findings, "findings");
  const findings = arr.map((entry, i) => {
    const f = assertObject(entry, `findings[${i}]`);
    const claim = assertString(f.claim, `findings[${i}].claim`);
    if (typeof f.confidence !== "number") {
      throw new ValidationError(`"findings[${i}].confidence" must be a number`);
    }
    const entities = f.entities !== undefined ? assertStringArray(f.entities, `findings[${i}].entities`) : [];
    const topic_tags = f.topic_tags !== undefined ? assertStringArray(f.topic_tags, `findings[${i}].topic_tags`) : [];
    return { claim, confidence: f.confidence, entities, topic_tags };
  });
  return { findings };
}

export function validateReflectDecision(raw: unknown): {
  continue: boolean;
  new_sub_queries: Array<{ query: string; rationale: string }>;
} {
  const obj = assertObject(raw, "ReflectDecision");
  if (typeof obj.continue !== "boolean") {
    throw new ValidationError(`"continue" must be a boolean`);
  }
  const arr = assertArray(obj.new_sub_queries, "new_sub_queries");
  return {
    continue: obj.continue,
    new_sub_queries: arr.map((e, i) => {
      const sq = assertObject(e, `new_sub_queries[${i}]`);
      return {
        query: assertString(sq.query, `new_sub_queries[${i}].query`),
        rationale: assertString(sq.rationale, `new_sub_queries[${i}].rationale`),
      };
    }),
  };
}
