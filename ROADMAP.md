# Roadmap

This project is in **evaluation stage**. The goal is to validate Paperclip + Pi agent orchestration patterns before committing to production infrastructure.

---

## Planned: MinIO artifact storage (Option B)

Replace the shared Docker volume with MinIO (S3-compatible object storage) for inter-agent artifact handoff.

### Why

- HTTP-accessible from inside and outside Docker
- Bucket policies for per-agent access control (security boundary between agents)
- S3 URIs as artifact references — portable, standard
- Web console (`:9001`) for inspecting agent output during eval
- No SDK dependency — agents use `curl` with presigned URLs

### What it looks like

- MinIO container in docker-compose (`minio/minio`, ~150MB)
- Bucket per run or per agent (TBD based on eval findings)
- Agents upload via presigned PUT URL, return `s3://artifacts/...` reference in text output
- Consuming agent receives reference in wake payload, fetches via presigned GET URL
- Bridge or a thin sidecar handles presigned URL generation

### Blocked on

- Validating the shared volume pattern first (Option A, currently implemented)
- Understanding what artifact types agents actually produce during eval runs
- Deciding access control model: per-agent buckets vs. per-run prefixes

---

## Future considerations

- Artifact metadata index (what was produced, by whom, when)
- Artifact TTL / cleanup policy
- Large artifact streaming (if agents produce multi-MB outputs)
- Integration with Paperclip if/when they ship native file storage
