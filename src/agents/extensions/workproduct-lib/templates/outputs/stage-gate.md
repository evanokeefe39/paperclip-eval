# Stage Gate: {{from_stage}} → {{to_stage}}

## Verdict: {{pass | block | conditional_pass}}

## Inputs

<!-- Artifact IDs entering this gate. -->

- {{input_artifact_id_1}} — {{kind, producing agent}}
- {{input_artifact_id_2}}

## Gate Criteria

<!-- Each named criterion → pass/fail. -->

- [ ] {{criterion 1}}
- [ ] {{criterion 2}}
- [ ] {{criterion 3}}

## Blocking Issues (if any)

### {{Issue title}}

- **Severity:** critical | major | minor
- **Owner agent:** {{which agent must resolve}}
- **Detail:** {{what is wrong}}

## Conditions (if conditional_pass)

<!-- What must be true for full pass. -->

## Prior Gate

- **Prior gate ref:** {{artifact_id of previous stage_gate in this pipeline, if any}}
