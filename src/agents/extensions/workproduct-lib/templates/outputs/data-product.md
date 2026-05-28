# Data Product: {{name}}

## Kind

dataset_ref | query_result | metric | chart

## Source

- **Source system:** postgres | duckdb | parquet | csv | tinybird | s3 | api | other
- **Table or path:** {{table or file URI}}
- **As of:** {{ISO date — data freshness}}

## Manifest

<!-- For dataset_ref: filters, columns, row_count_estimate, schema_hash.
     For query_result: full SQL, engine, row_count, materialized_at, columns metadata.
     For metric: name, value, unit, dimensions, window.
     For chart: chart_type, data_ref, spec body. -->

## Provenance

- **Source artifacts:** {{source_dataset_refs or source_query_ref}}
- **Produced by query:** {{query_result id, if applicable}}
- **Rendered output:** {{rendered_artifact_ref, if any}}

## Caveats

<!-- Known issues, partial backfills, sampling notes, NULL semantics. -->

## Topic tags

<!-- comma-separated discovery tags -->
