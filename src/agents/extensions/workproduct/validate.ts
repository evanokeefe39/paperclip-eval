export interface StyleProfiles {
  sourceRequired: Record<string, string[]>;
  sourceEncouraged: Record<string, string[]>;
  recordEncouraged: Record<string, string[]>;
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateByStyle(
  profiles: StyleProfiles,
  style: string,
  sources: Record<string, unknown>[],
  record: Record<string, unknown>,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
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
