# Deep Research Graph (Knowledge Graph Integration)

## Intent

Optional knowledge graph layer on top of the findings store. Adds entity-relationship queries, temporal fact tracking, and semantic search. Findings stream into graph as produced. System works without it (JSONL is primary); graph adds intelligence when configured.

## Dependencies

- Findings store (deep-research-store.md) — produces findings with entities
- Graphiti or alternative graph service (Docker sidecar)
- Neo4j (Graphiti's backing store)

## Architecture

```
Research engine produces findings
    │
    ├── Primary: JSONL store (always, synchronous)
    │
    └── Secondary: Graph ingest (if configured, fire-and-forget)
            │
            ▼
        Graphiti API (http://graphiti:8000)
            │
            ▼
        Neo4j (bolt://neo4j:7687)
```

Graph is **non-blocking and non-critical**. If graph is down or unconfigured, research continues normally. Findings are never lost — JSONL is the source of truth.

## Graph Client (graph.ts)

```typescript
const GRAPH_URL = process.env.GRAPHITI_URL || "";

async function graphIngest(finding: Finding): Promise<void> {
  if (!GRAPH_URL) return;

  try {
    await fetch(`${GRAPH_URL}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episode: {
          content: finding.claim,
          source: finding.source_url,
          timestamp: finding.timestamp,
          metadata: {
            session_id: finding.session_id,
            confidence: finding.confidence,
            finding_id: finding.id,
            topic_tags: finding.topic_tags,
          },
        },
        entities: finding.entities.map(e => ({
          name: e.name,
          type: e.type,
          normalized: e.normalized,
        })),
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Fire-and-forget. Graph failure never blocks research.
  }
}

async function graphQuery(query: string, limit: number = 20): Promise<GraphResult[]> {
  if (!GRAPH_URL) return [];

  try {
    const res = await fetch(`${GRAPH_URL}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch {
    return [];
  }
}

interface GraphResult {
  finding_id: string;
  claim: string;
  entities: Entity[];
  relationships: { from: string; to: string; type: string }[];
  relevance_score: number;
}
```

## Integration with research_query

When graph is available, research_query uses it for semantic search (better than keyword grep):

```typescript
async execute(_id, params) {
  // Try graph first (semantic search)
  const graphResults = await graphQuery(params.query, params.max_results || 20);
  
  if (graphResults.length > 0) {
    // Graph found results — richer than keyword search
    return formatGraphResults(graphResults);
  }
  
  // Fallback to JSONL keyword search
  const entries = queryIndex(params.query, params.max_results || 20, config);
  return formatIndexResults(entries);
}
```

## Docker Infrastructure

### docker-compose addition

```yaml
services:
  neo4j:
    image: neo4j:5-community
    environment:
      - NEO4J_AUTH=neo4j/${NEO4J_PASSWORD:-research123}
      - NEO4J_PLUGINS=["apoc"]
    volumes:
      - neo4j-data:/data
    networks:
      - internal
    deploy:
      resources:
        limits:
          memory: 1G

  graphiti:
    build: ./src/agents/graphiti
    environment:
      - NEO4J_URI=bolt://neo4j:7687
      - NEO4J_USER=neo4j
      - NEO4J_PASSWORD=${NEO4J_PASSWORD:-research123}
      - LLM_PROVIDER=deepseek
      - LLM_API_KEY=${DEEPSEEK_API_KEY}
      - LLM_MODEL=deepseek-chat
    depends_on:
      neo4j:
        condition: service_healthy
    networks:
      - internal
    ports:
      - "8000:8000"  # API access for debugging
    deploy:
      resources:
        limits:
          memory: 512M

volumes:
  neo4j-data:
```

### Graphiti Dockerfile

```dockerfile
FROM python:3.12-slim

WORKDIR /app
RUN pip install graphiti-core[server] httpx

# Custom config to use DeepSeek instead of OpenAI
COPY config.py /app/
COPY server.py /app/

EXPOSE 8000
CMD ["python", "server.py"]
```

### Graphiti server wrapper (server.py)

Thin HTTP wrapper if Graphiti doesn't expose REST natively:

```python
from fastapi import FastAPI
from graphiti_core import Graphiti
import os

app = FastAPI()
graph = Graphiti(
    neo4j_uri=os.environ["NEO4J_URI"],
    neo4j_user=os.environ["NEO4J_USER"],
    neo4j_password=os.environ["NEO4J_PASSWORD"],
)

@app.post("/ingest")
async def ingest(payload: dict):
    await graph.add_episode(
        content=payload["episode"]["content"],
        source=payload["episode"]["source"],
        timestamp=payload["episode"]["timestamp"],
        metadata=payload["episode"].get("metadata", {}),
    )
    return {"status": "ok"}

@app.post("/search")
async def search(payload: dict):
    results = await graph.search(
        query=payload["query"],
        limit=payload.get("limit", 20),
    )
    return {"results": results}

@app.get("/health")
async def health():
    return {"status": "healthy"}
```

## Provider Configuration

Graphiti uses an LLM for internal entity extraction and relationship inference. Options:

| Provider | Cost | Quality | Notes |
|----------|------|---------|-------|
| OpenAI (default) | $0.01/episode | High | Graphiti's native path |
| DeepSeek (configured) | $0.001/episode | Good | 10x cheaper, adequate for entity extraction |
| Disabled | $0 | N/A | Skip graph-level extraction, rely on pre-extracted entities from findings |

**Recommendation:** Disable Graphiti's internal extraction. Our research engine already extracts entities in the finding. Pass pre-extracted entities directly to graph. Zero additional LLM cost for graph operations.

```python
# config.py — disable Graphiti's internal LLM extraction
GRAPHITI_CONFIG = {
    "entity_extraction": False,  # we provide entities
    "relationship_inference": True,  # still useful — infer relationships between entities
    "llm_provider": "deepseek",
    "llm_model": "deepseek-chat",
}
```

## What the Graph Enables

### Entity relationship queries
```
"What companies are connected to EV battery technology?"
→ Tesla → Panasonic → CATL → BYD (via entity relationships)
→ Plus the findings that established each connection
```

### Temporal fact tracking
```
"What did we learn about Tesla this week vs last month?"
→ Graph tracks when each fact was ingested
→ Shows evolution of knowledge over time
```

### Contradiction detection
```
Finding A (session 1): "EV market growing 25% YoY"
Finding B (session 3): "EV growth slowed to 12% in Q1 2025"
→ Graph can surface conflicting claims about same entity
→ QA agent uses this for verification
```

### Research gap identification
```
"What topics have we researched but have low confidence findings?"
→ Graph query: entities with few connections or low-confidence claims
→ Suggests areas for deeper research
```

## Phased Rollout

| Phase | What | Depends on |
|-------|------|-----------|
| 1 | JSONL store (primary, always works) | Nothing |
| 2 | Graph sidecar (Neo4j + Graphiti) | JSONL store working |
| 3 | Semantic search via graph | Graph populated |
| 4 | Contradiction detection | Multiple sessions with overlapping entities |
| 5 | Research gap analysis | Sufficient entity graph density |

Phase 1 ships with the research engine. Phases 2+ are independent additions.

## Open Questions

1. **Graphiti vs Cognee:** ROADMAP mentions both. Graphiti is temporal (tracks when facts learned). Cognee builds knowledge graphs from documents. Graphiti fits better for streaming findings. Decision: start with Graphiti, evaluate Cognee for document-level ingestion later.

2. **Entity normalization:** "Tesla" vs "Tesla, Inc." vs "TSLA". Who normalizes? Options: (a) extraction prompt asks for canonical form, (b) graph handles dedup, (c) separate normalization pass. Recommend (a) — add `normalized` field to extraction prompt.

3. **Graph storage size:** Neo4j community edition limits? At 10k+ entities and 50k+ relationships, need to monitor. Community edition has no hard limits but performance degrades without proper indexing.

4. **Graphiti's DeepSeek support:** Need to verify Graphiti can use non-OpenAI providers for its internal operations. If not, either (a) use OpenAI for graph only, (b) fork/patch Graphiti, or (c) skip Graphiti's extraction entirely.

## Definition of Done

- [ ] graph.ts: fire-and-forget ingest client
- [ ] graph.ts: search query client with timeout
- [ ] research_query falls back gracefully (graph → JSONL)
- [ ] docker-compose: Neo4j + Graphiti services
- [ ] Graphiti configured to use DeepSeek (or extraction disabled)
- [ ] Ingest verified: finding → graph → query returns it
- [ ] Relationship inference working (entity A connected to entity B)
- [ ] Health check on Graphiti service
- [ ] System works normally when graph is down/unconfigured
- [ ] Documentation: how to enable/disable graph

## Risks

- **Graphiti maturity:** Relatively new project. API may change. Mitigation: thin client wrapper isolates us from breaking changes.
- **Neo4j memory:** Graph DB is memory-hungry. 1GB limit may be tight at scale. Monitor and adjust.
- **LLM cost for graph operations:** If Graphiti's relationship inference uses LLM internally, this adds cost. Mitigation: configure cheapest model or disable if cost exceeds value.
- **Complexity:** Graph adds operational surface (Neo4j + Graphiti + configuration). Worth it only after JSONL store proves the data model works. Don't deploy graph until Phase 1 is validated.
