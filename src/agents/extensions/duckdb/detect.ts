import * as path from "node:path";

const FORMAT_MAP: Record<string, string> = {
  csv: "csv",
  tsv: "csv",
  json: "json",
  jsonl: "json",
  ndjson: "json",
  parquet: "parquet",
  pq: "parquet",
  xlsx: "excel",
  xls: "excel",
  sqlite: "sqlite",
  sqlite3: "sqlite",
  db: "sqlite",
  duckdb: "duckdb",
  avro: "avro",
  shp: "spatial",
  gpkg: "spatial",
  geojson: "spatial",
  ipynb: "json",
};

const SUPPORTED_EXTENSIONS = Object.keys(FORMAT_MAP);

export function detectFormat(filePath: string): string | null {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  return FORMAT_MAP[ext] || null;
}

export function getSupportedFormats(): string[] {
  return SUPPORTED_EXTENSIONS;
}

export function isRemoteUrl(p: string): boolean {
  return /^(https?|s3|r2|gs):\/\//i.test(p);
}

export function readFunction(format: string, filePath: string): string {
  switch (format) {
    case "csv":
      return `read_csv('${filePath}', auto_detect=true)`;
    case "json":
      return `read_json('${filePath}', auto_detect=true)`;
    case "parquet":
      return `read_parquet('${filePath}')`;
    case "excel":
      return `read_xlsx('${filePath}')`;
    case "sqlite":
      return `sqlite_scan('${filePath}', (SELECT name FROM sqlite_master WHERE type='table' LIMIT 1))`;
    case "avro":
      return `read_avro('${filePath}')`;
    case "spatial":
      return `ST_Read('${filePath}')`;
    default:
      return `read_csv('${filePath}', auto_detect=true)`;
  }
}

export function requiredExtension(format: string): string | null {
  switch (format) {
    case "excel": return "excel";
    case "spatial": return "spatial";
    case "sqlite": return "sqlite";
    case "avro": return "avro";
    default: return null;
  }
}

export function outputCopyFormat(filePath: string): string | null {
  const ext = path.extname(filePath).replace(/^\./, "").toLowerCase();
  const map: Record<string, string> = {
    parquet: "PARQUET",
    pq: "PARQUET",
    csv: "CSV",
    tsv: "CSV",
    json: "JSON",
    jsonl: "JSON",
    ndjson: "JSON",
    xlsx: "EXCEL",
  };
  return map[ext] || null;
}
