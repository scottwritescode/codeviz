# LadybugDB Migration Plan

Replace the SQLite storage layer in `src/db/` with a LadybugDB-backed property graph, and rewrite all traversal/search code to use Cypher and Ladybug's native indexes instead of SQL recursive CTEs and FTS5.

This plan complements `design.md` Phase 1 — it is the implementation-level breakdown for that phase.

---

## 1. Goals and Non-Goals

**Goals**
- Single embedded DB file under `.codeviz/` (preserve current UX).
- Cypher-native query layer — no recursive CTEs, no manual BFS/DFS in TypeScript.
- Native FTS via Ladybug's FTS extension — drop SQLite FTS5 entirely.
- Optional vector index slot ready for semantic search (no embedding pipeline in v1).
- Cross-platform: native Node bindings on CLI, WASM in browser/Electron renderer.
- Re-index from scratch on upgrade. No SQLite ↔ Ladybug data migration.

**Non-Goals (this phase)**
- Embedding generation or semantic search (slot the table; populate later).
- Community detection / process detection (gitnexus features — Phase 2 work).
- Multi-repo registry (Phase 3+).
- Removing tree-sitter or changing the extraction model.

---

## 2. Schema Design

### 2.1 Resolution of every gap from prior analysis

| Current `NodeKind` | New representation | Notes |
|---|---|---|
| `file` | `File` node table | id == filePath |
| `module` | `Module` node table | |
| `class` | `Class` node table | |
| `struct` | `Struct` node table | |
| `interface` | `Interface` node table | |
| `trait` | `Trait` node table | |
| `protocol` | `Protocol` node table | **gap fixed** — own table (Swift/ObjC) |
| `function` | `Function` node table | |
| `method` | `Method` node table | |
| `property` | `Property` node table | |
| `field` | `Field` node table | **gap fixed** — kept distinct from Property |
| `variable` | `Variable` node table | |
| `constant` | `Constant` node table | |
| `enum` | `Enum` node table | |
| `enum_member` | `EnumMember` node table | **gap fixed** — own table |
| `type_alias` | `TypeAlias` node table | |
| `namespace` | `Namespace` node table | |
| `parameter` | `Parameter` node table | **gap fixed** — own table; emitter already produces these |
| `import` | **dropped as node** — represented as `IMPORTS` edge from `File` → `File`/`Symbol`/`ExternalModule` | **gap fixed** by leaning into the graph |
| `export` | **dropped as node** — replaced by `isExported: BOOLEAN` property + `EXPORTS` edge from `File` → symbol | **gap fixed** |
| `route` | `Route` node table | |
| `component` | `Component` node table | **gap fixed** — own table (React/Svelte) |
| (new) | `ExternalModule` node table | placeholder for unresolved imports (e.g. `react`, `lodash`) |
| (new) | `UnresolvedSymbol` node table | optional v2 — replaces `unresolved_refs` side table |

| Current `EdgeKind` | New `type` value on `CodeRelation` rel table | Notes |
|---|---|---|
| `contains` | `CONTAINS` | |
| `calls` | `CALLS` | |
| `imports` | `IMPORTS` | promoted from the dropped `import` node-kind |
| `exports` | `EXPORTS` | redundant with `isExported`; keep for one-hop "what does file X export" |
| `extends` | `EXTENDS` | |
| `implements` | `IMPLEMENTS` | |
| `references` | `REFERENCES` | **gap fixed** — kept as distinct edge type |
| `type_of` | `TYPE_OF` | **gap fixed** |
| `returns` | `RETURNS` | **gap fixed** |
| `instantiates` | `INSTANTIATES` | **gap fixed** |
| `overrides` | `OVERRIDES` | |
| `decorates` | `DECORATES` | **gap fixed** |
| (new) | `HAS_PARAMETER` | new edge — Function/Method → Parameter |

### 2.2 DDL sketch (final form lives in `src/lbug/schema.ts`)

Common columns shared by all symbol-bearing tables (everything except `File`, `ExternalModule`):

```cypher
id STRING,
name STRING,
qualifiedName STRING,
filePath STRING,
language STRING,
startLine INT64, endLine INT64,
startColumn INT32, endColumn INT32,
docstring STRING,
signature STRING,
visibility STRING,             -- 'public' | 'private' | 'protected' | NULL
isExported BOOLEAN,
isAsync BOOLEAN,
isStatic BOOLEAN,
isAbstract BOOLEAN,
decorators STRING[],            -- Ladybug native list type — replaces JSON blob
typeParameters STRING[],        -- ditto
updatedAt INT64,
PRIMARY KEY (id)
```

`File` table:

```cypher
CREATE NODE TABLE File (
  id STRING,                    -- == path, makes lookups one-hop
  path STRING,
  contentHash STRING,
  language STRING,
  size INT64,
  modifiedAt INT64,
  indexedAt INT64,
  nodeCount INT32,
  errors STRING[],
  PRIMARY KEY (id)
);
```

`ExternalModule` table (placeholder for unresolved imports):

```cypher
CREATE NODE TABLE ExternalModule (
  id STRING,                    -- e.g. 'npm:react@18'
  name STRING,                  -- e.g. 'react'
  packageManager STRING,        -- 'npm' | 'pip' | 'cargo' | ...
  PRIMARY KEY (id)
);
```

`CodeRelation` (single rel table for **all** edge kinds):

```cypher
CREATE REL TABLE CodeRelation (
  FROM File   TO File,    FROM File   TO Module,  FROM File   TO Class,  ...
  FROM Module TO Module,  FROM Module TO Class,   FROM Module TO Function, ...
  FROM Class  TO Method,  FROM Class  TO Property, ...
  -- Generated programmatically from emitter output (see §2.3).
  type        STRING,           -- one of the EdgeKind values above
  line        INT64,
  col         INT32,
  provenance  STRING,           -- 'extraction' | 'resolution' | 'framework:react' ...
  metadata    STRING,           -- JSON blob — keep for compat; promote hot fields later
  confidence  DOUBLE            -- v2 — gitnexus parity
);
```

`UnresolvedRef` table (kept as side table, not part of the graph):

```cypher
CREATE NODE TABLE UnresolvedRef (
  id STRING,                    -- composite or uuid
  fromNodeId STRING,
  referenceName STRING,
  referenceKind STRING,
  filePath STRING,
  language STRING,
  line INT64, col INT32,
  candidates STRING[],
  PRIMARY KEY (id)
);
```

`CodeEmbedding` table (for Phase 5 — declared now to lock the layout):

```cypher
CREATE NODE TABLE CodeEmbedding (
  id STRING,
  nodeId STRING,
  chunkIndex INT32,
  startLine INT64, endLine INT64,
  embedding FLOAT[384],         -- configurable via env
  contentHash STRING,
  PRIMARY KEY (id)
);
```

### 2.3 FROM/TO matrix generation

Hand-curating ~20×20 = 400+ pair declarations is brittle. Instead, generate the matrix programmatically:

```ts
// src/lbug/schema.ts
const NODE_TABLES = [...] as const;          // all 22 kinds
const EMITTED_PAIRS = new Set<string>([      // populated by extractor + framework code
  'File:Function', 'File:Class', ...
  'Class:Method', 'Class:Property', ...
  'Function:Function',                       // calls within a file
  'Method:Function',                         // method calls function
  'Function:Parameter',                      // HAS_PARAMETER
  // ... 60-100 actual pairs
]);

export const RELATION_SCHEMA = `
CREATE REL TABLE CodeRelation (
  ${[...EMITTED_PAIRS].map(p => {
    const [from, to] = p.split(':');
    return `FROM ${escape(from)} TO ${escape(to)}`;
  }).join(',\n  ')},
  type STRING, line INT64, col INT32,
  provenance STRING, metadata STRING, confidence DOUBLE
)`;
```

`EMITTED_PAIRS` is the single source of truth. When an extractor adds a new pair (e.g. `Component:Route`), schema regenerates next index. Schema validation in CI: scan extractor output, fail if any emitted edge's (FROM,TO) is not in `EMITTED_PAIRS`.

### 2.4 Indexes

- **Primary keys** — automatic on every node table's `id`.
- **Property indexes** — Ladybug auto-indexes the primary key. For lookups on `name`, `qualifiedName`, `filePath`: rely on Cypher property-equality on the typed table label (Ladybug's planner uses table-scoped indexes once Ladybug supports per-property secondary indexes; until then, enumerate matches on label and let the columnar storage handle it).
- **FTS index** — created at first index over Function/Method/Class/Interface/etc. `name`, `qualifiedName`, `docstring`, `signature` (see §3.4).
- **Vector index** — declared but not created until Phase 5.

---

## 3. Query Layer Redesign (Cypher-native)

Goal: replace every recursive CTE in `src/db/queries.ts` and every TypeScript-side BFS/DFS in `src/graph/traversal.ts` with a single Cypher query. The TypeScript layer becomes a thin parameter binder + result mapper.

### 3.1 Single-symbol lookups

```ts
// getNodeById(id: string): Node | null
const cypher = `
  MATCH (n {id: $id})
  RETURN n, label(n) AS kind
  LIMIT 1
`;
```

`label(n)` returns the table name, which we map back to `NodeKind`. (The current SQL `kind` column is replaced by the table label.)

### 3.2 Callers / Callees / Call graph

Replaces `getCallersRecursive`, `getCalleesRecursive`, `getCallGraph`:

```cypher
-- Callers, depth N
MATCH path = (caller)-[r:CodeRelation* 1..$depth]->(target {id: $id})
WHERE ALL(rel IN r WHERE rel.type IN ['CALLS', 'REFERENCES', 'IMPORTS'])
RETURN nodes(path) AS chain, relationships(path) AS edges

-- Callees, depth N
MATCH path = (source {id: $id})-[r:CodeRelation* 1..$depth]->(callee)
WHERE ALL(rel IN r WHERE rel.type IN ['CALLS', 'REFERENCES', 'IMPORTS'])
RETURN nodes(path) AS chain, relationships(path) AS edges
```

Variable-length pattern with type filter via `WHERE ALL(...)` collapses three nested TypeScript recursions into one query that the Ladybug planner can pipeline.

### 3.3 Impact radius

Replaces `getImpactRecursive` (current code is 50+ lines including the container-children expansion):

```cypher
MATCH (focal {id: $id})
OPTIONAL MATCH path = (dependent)-[r:CodeRelation* 1..$depth]->(focal)
WITH focal, COLLECT(DISTINCT path) AS paths
UNWIND paths AS p
WITH focal, nodes(p) AS chain, relationships(p) AS rels
// Container expansion — pull in CONTAINS children of containers in chain
OPTIONAL MATCH (container)-[c:CodeRelation {type:'CONTAINS'}]->(child)
WHERE container IN chain
  AND label(container) IN ['Class', 'Interface', 'Struct', 'Trait', 'Protocol', 'Module', 'Enum']
RETURN chain, rels, COLLECT(child) AS containerChildren
```

Container expansion that current code does in TypeScript becomes an `OPTIONAL MATCH` clause.

### 3.4 Search (FTS)

Drop FTS5, drop the bespoke SQL+LIKE+co-location ranker in `searchNodes` (currently ~100 lines). Replace with Ladybug FTS:

```ts
// One-time, at index creation:
await conn.query(`
  CALL CREATE_FTS_INDEX('Function', 'function_fts', ['name','qualifiedName','docstring','signature'], stemmer := 'porter')
`);
// Repeat per searchable table.

// Search:
const cypher = `
  CALL QUERY_FTS_INDEX($table, $index, $query, conjunctive := false)
  RETURN node, score
  ORDER BY score DESC
  LIMIT $limit
`;
```

For multi-table search, run FTS per searchable table in parallel and merge by score (Ladybug FTS is per-table). Wrap in a small `searchAll(query, options)` helper.

**Decision: drop the 5x-overfetch + multi-signal post-rescoring** (`kindBonus`, `nameMatchBonus`, `scorePathRelevance`) in v1. Ladybug FTS with column weighting (replicate the BM25 weights via `top_k_per_table`) should be enough. If recall regresses, port the rescorer in v1.1 — but treat it as a regression to fix, not a v1 requirement.

### 3.5 Type hierarchy

Replaces `getTypeAncestors` + `getTypeDescendants`:

```cypher
-- Ancestors and descendants in one query
MATCH (focal {id: $id})
OPTIONAL MATCH ancestorPath = (focal)-[:CodeRelation* 1..10 {type: 'EXTENDS' OR 'IMPLEMENTS'}]->(ancestor)
OPTIONAL MATCH descendantPath = (descendant)-[:CodeRelation* 1..10 {type: 'EXTENDS' OR 'IMPLEMENTS'}]->(focal)
RETURN focal,
       COLLECT(DISTINCT ancestor) AS ancestors,
       COLLECT(DISTINCT descendant) AS descendants
```

(Note: filtering rel `type` on a variable-length pattern uses a `WHERE` clause in real Cypher; the inline-property filter shown is sketched — verify exact Ladybug syntax in spike.)

### 3.6 Path finding

Replaces `findPath` BFS. Ladybug supports shortest-path natively:

```cypher
MATCH (from {id: $fromId}), (to {id: $toId})
MATCH p = shortestPath((from)-[r:CodeRelation*]->(to))
WHERE ALL(rel IN relationships(p) WHERE rel.type IN $allowedTypes)
RETURN nodes(p) AS chain, relationships(p) AS edges
LIMIT 1
```

### 3.7 File dependencies / dependents

Replaces `getFileDependencies` + `getFileDependents`:

```cypher
-- Dependencies (files this file imports from)
MATCH (f:File {path: $path})-[:CodeRelation {type: 'IMPORTS'}]->(other)
RETURN DISTINCT
  CASE label(other) WHEN 'File' THEN other.path ELSE other.filePath END AS depPath

-- Dependents (files that import from this file or its exports)
MATCH (importer:File)-[:CodeRelation {type: 'IMPORTS'}]->(target)
WHERE target.id = $fileId OR (target.filePath = $path AND target.isExported = true)
RETURN DISTINCT importer.path AS depPath
```

### 3.8 Circular dependencies

Replaces hand-rolled DFS in `findCircularDependencies`:

```cypher
MATCH cycle = (f:File)-[:CodeRelation* {type: 'IMPORTS'}]->(f)
RETURN nodes(cycle) AS files
LIMIT 100
```

Single line. Pure win.

### 3.9 Dead code

```cypher
MATCH (n)
WHERE label(n) IN ['Function','Method','Class']
  AND n.isExported = false
  AND NOT EXISTS {
    MATCH (caller)-[r:CodeRelation]->(n)
    WHERE r.type <> 'CONTAINS'
  }
RETURN n
```

### 3.10 Stats

Replaces `getStats` (currently 4 SQL queries):

```cypher
MATCH (n)
WITH label(n) AS kind, COUNT(*) AS c
RETURN COLLECT({kind: kind, count: c}) AS nodesByKind,
       SUM(c) AS totalNodes
// + a similar query per rel.type for edgesByKind
```

---

## 4. Adapter Architecture

Mirror gitnexus's split between writer (single connection, session-locked) and reader (connection pool):

```
src/lbug/
├── adapter.ts          # init/open/close, schema bootstrap, transactional writer ops
├── pool.ts             # read-only Connection pool (size 8) for MCP/CLI queries
├── schema.ts           # DDL constants + EMITTED_PAIRS matrix generator
├── extension-loader.ts # FTS extension + (later) VECTOR extension loading
├── csv-loader.ts       # bulk COPY for full re-index — split rel CSV by (from,to) pair
├── cypher.ts           # query string constants — every query in §3 lives here
└── index.ts            # GraphStore facade matching the existing CodeViz API
```

### 4.1 `GraphStore` interface (replaces `QueryBuilder`)

Keep the public surface of `QueryBuilder` so callers don't need rewrites — only the implementation changes:

```ts
export interface GraphStore {
  // Lifecycle
  close(): Promise<void>;

  // Node ops
  insertNode(node: Node): Promise<void>;
  insertNodes(nodes: Node[]): Promise<void>;          // batched MERGE under the hood
  getNodeById(id: string): Promise<Node | null>;
  getNodesByFile(filePath: string): Promise<Node[]>;
  getNodesByKind(kind: NodeKind): Promise<Node[]>;
  searchNodes(q: string, opts?: SearchOptions): Promise<SearchResult[]>;
  // ... etc, mirroring current queries.ts

  // Edge ops
  insertEdge(edge: Edge): Promise<void>;
  insertEdges(edges: Edge[]): Promise<void>;
  getOutgoingEdges(id: string, kinds?: EdgeKind[]): Promise<Edge[]>;
  getIncomingEdges(id: string, kinds?: EdgeKind[]): Promise<Edge[]>;

  // File ops
  upsertFile(f: FileRecord): Promise<void>;
  deleteFile(path: string): Promise<void>;            // DETACH DELETE in Cypher

  // Graph queries (NEW — currently in src/graph/)
  getCallers(id: string, depth: number): Promise<Subgraph>;
  getCallees(id: string, depth: number): Promise<Subgraph>;
  getImpact(id: string, depth: number): Promise<Subgraph>;
  findPath(from: string, to: string, kinds?: EdgeKind[]): Promise<Path | null>;
  // ... rest of GraphTraverser/GraphQueryManager
}
```

The whole `src/graph/traversal.ts` file (~640 lines) collapses into ~50 lines of result-mapping over the queries in §3. `src/graph/queries.ts` shrinks similarly.

**Crucial: the traversal/query logic moves into the database layer, not just the wrapper.** Today the TS code does N+1 queries (recursive `getNodeById` per visited node) — moving to Cypher means one round-trip per traversal.

### 4.2 Async API (breaking change)

SQLite via `better-sqlite3` is sync; Ladybug is async. Every public method becomes `Promise<T>`. This propagates through:
- `src/index.ts` (CodeViz class)
- `src/extraction/index.ts` (~10 call sites)
- `src/resolution/index.ts`
- `src/context/index.ts`
- `src/mcp/tools.ts`
- `src/bin/codeviz.ts` (CLI commands)
- All tests

This is a one-time mechanical change but must happen atomically — half-async is worse than fully sync. Plan to do it in a single PR after the adapter is functionally complete.

### 4.3 Connection pool

Per gitnexus: one `lbug.Database` (the file mmap), N `lbug.Connection`s (each individually thread-unsafe; check out / return). Pool size 8 is reasonable for CodeViz's MCP server workload. Indexing path uses the singleton writable connection with a session lock.

### 4.4 Bulk-load path

For full re-index (`codeviz index`), CSV COPY beats per-row MERGE by 100×+. Borrow gitnexus's two-phase pattern:

1. Extractor writes node CSVs per table to `.codeviz/csv/<Table>.csv`.
2. Single rel CSV → split by (fromLabel, toLabel) into `rel_<from>_<to>.csv` (Ladybug requires it).
3. `COPY <Table> FROM '<csvPath>' (HEADER=true, ESCAPE='"', DELIM=',', QUOTE='"', PARALLEL=false, auto_detect=false)`.
4. Cleanup CSV directory.

For incremental sync (`codeviz sync`), per-row `MERGE (n:Type {id:$id}) SET n.name=$name, ...` via `executeWithReusedStatement` (sub-batch 4) is the gitnexus pattern.

### 4.5 Per-file delete (incremental sync)

Replaces `deleteFile` + `deleteNodesByFile` + cascading FK on edges. In Cypher, one query per node table:

```cypher
UNWIND $nodeTables AS table
CALL { WITH table
  MATCH (n) WHERE label(n) = table AND n.filePath = $path
  DETACH DELETE n           -- removes node + all incident relationships
}
MATCH (f:File {path: $path}) DETACH DELETE f
```

(`UNWIND`-`CALL` shape verified against Ladybug syntax in spike.)

---

## 5. Migration Phases

### Phase 1.0 — Spike (1 week, throwaway code)

Goal: prove the three hottest queries are fast and correct on a real `.codeviz/` dataset. Build only what's needed to answer "should we commit?"

- Add `@ladybugdb/core` as devDependency.
- Hand-write minimal schema (just `Function`, `Method`, `Class`, `File`, `CodeRelation`).
- One-shot CSV loader from current SQLite DB (read SQLite → write Ladybug — throwaway script, not the migration tool).
- Implement and benchmark:
  - `getCallGraph` (depth 2) — Cypher vs current TS recursion
  - `getImpactRadius` (depth 3) — same
  - `searchNodes` ("auth") — Ladybug FTS vs SQLite FTS5
- Compare cold-start time, query latency, result-set parity.

**Gate**: query latency within 2× of current SQLite, result-set diff < 5%, cold-start < 5 s. If any gate fails, stop and reassess.

### Phase 1.1 — Adapter scaffold (1 week)

- Create `src/lbug/` directory tree.
- Generate full schema from `EMITTED_PAIRS` (start with permissive 22×22 matrix; prune later).
- Implement `GraphStore` interface, **wrap existing `QueryBuilder` first** so the rest of the codebase still calls SQLite. This isolates async migration from data-layer rewrite.
- Implement Ladybug-backed `LbugGraphStore` in parallel (no callers yet).
- Adapter selection via env var: `CODEVIZ_STORE=sqlite` (default) or `lbug`.

**Gate**: `npm test` passes against `CODEVIZ_STORE=sqlite` (no regressions); `LbugGraphStore` passes a smoke test (insert 100 nodes, query them back).

### Phase 1.2 — Async migration (1 week)

- Convert all internal call sites to `await`.
- Update CLI, MCP, extraction orchestrator.
- Update tests to use `await`.
- Both stores still work; no behavior change with `CODEVIZ_STORE=sqlite`.

**Gate**: full test suite green on both backends.

### Phase 1.3 — Cypher query layer (2 weeks)

- Implement every query in §3 against `LbugGraphStore`.
- Move `GraphTraverser` + `GraphQueryManager` logic into Cypher constants in `src/lbug/cypher.ts`.
- Delete TypeScript-side BFS/DFS recursion.
- Port test fixtures: golden index from a small repo (e.g. CodeViz itself), assert query results bytewise-equal between backends for the union of canonical queries.

**Gate**: parity tests pass for callers/callees/impact/search/type-hierarchy/path-find/file-deps/cycles/dead-code/stats. Performance tests show Cypher path ≥ current SQLite path on the canonical repo.

### Phase 1.4 — FTS + bulk loader (1 week)

- Implement FTS index creation per searchable table.
- Implement `searchNodes` against `QUERY_FTS_INDEX`.
- Implement CSV-COPY full-index path.
- Run `codeviz index` against 5 reference repos of varying sizes, compare against SQLite path.

**Gate**: full-index runtime within 2× of SQLite path on each reference repo (Ladybug should win on large repos due to columnar; SQLite may win on tiny ones — that's acceptable).

### Phase 1.5 — Cutover (1 week)

- Default `CODEVIZ_STORE=lbug`.
- New `.codeviz/` layout: `.codeviz/codeviz.lbug` (single file).
- Detect old SQLite `.codeviz/codeviz.db` on `open()`; emit a clear error: *"This `.codeviz/` was built with the SQLite backend. Run `codeviz index` to rebuild on the new graph store."*
- Update README, CLAUDE.md (project), docs.

**Gate**: dogfood for one week; address any issues found; tag release.

### Phase 1.6 — Deprecate SQLite (next minor release)

- Remove `src/db/`.
- Remove `better-sqlite3` and `node-sqlite3-wasm` dependencies.
- Remove `CODEVIZ_STORE` env var.

---

## 6. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Ladybug Node binding immature post-Kuzu rebrand | M | H | Spike (Phase 1.0) tests bindings on real data; pin version; have escape hatch to use Kuzu directly if @ladybugdb/core lags |
| Cypher variable-length traversals slow on huge graphs | M | M | Spike benchmarks; if slow, fall back to seeded BFS via `CALL` in Cypher with explicit hop counts |
| FTS extension unavailable on some platforms (Windows ARM, etc.) | L | M | Ladybug ships extension binaries; gitnexus has platform capability check (`isVectorExtensionSupportedByPlatform`); copy the pattern |
| WASM build for Electron renderer not at parity | M | M | Phase 1 ships Node-only; WASM is Phase 4 (Web Product) per design.md |
| Async migration leaks unawaited promises | H (mechanical) | M | Enable `@typescript-eslint/no-floating-promises`; full test suite; manual MCP + CLI smoke tests |
| Re-index time regression on small projects | M | L | Document; SQLite was unusually fast on small data due to in-process sync calls — Ladybug's IPC + columnar overhead is fixed cost |
| Existing user `.codeviz/` dirs become unreadable | H (intentional) | L | Clear error message + `codeviz index` rebuilds in seconds for typical repos |

---

## 7. What changes in user-facing behavior

**Breaking**:
- `.codeviz/codeviz.db` → `.codeviz/codeviz.lbug` (different file format, must re-index).
- `CodeViz` class methods become async (TypeScript SDK consumers must `await`).

**Backward-compatible**:
- CLI flags and subcommands unchanged.
- MCP tool names and shapes unchanged.
- Config file (`config.json`) format unchanged.

---

## 8. Estimate

- **Calendar**: 6–7 weeks single-developer.
- **Code delta**: roughly +1500 lines (lbug adapter), -2000 lines (SQLite layer + TS traversal). Net negative.
- **Test delta**: existing SQLite-specific tests retire; ~20 new tests for Cypher query parity and FTS behavior.

---

## 9. Open Questions for Decision

1. **Drop `unresolved_refs` table** in favor of `UnresolvedSymbol` graph nodes? (Cleaner — resolution becomes a Cypher MERGE that deletes the unresolved node when it finds a match. Costs more storage. **Recommend: keep as side table in v1; revisit.**)
2. **Per-edge-type rel tables** instead of single `CodeRelation` with `type` property? (Cypher pattern matching gets simpler — `[r:CALLS]` vs `[r:CodeRelation {type:'CALLS'}]`. But CSV COPY needs per-rel-table files instead of per-pair files. **Recommend: stay with single rel table — gitnexus has battle-tested it.**)
3. **Drop the multi-signal search rescorer** (`kindBonus`, `nameMatchBonus`, `scorePathRelevance`) and rely on FTS column weights only? (Big simplification. Risk of search-quality regression. **Recommend: drop in v1, port back if recall benchmarks regress.**)
4. **WASM target in Phase 1 or defer?** (gitnexus has both. Adds 1–2 weeks. **Recommend: defer to Phase 4 per design.md.**)

---

## 10. First Tactical Step

Before any of this lands: **run the spike (Phase 1.0) on the CodeViz repo's own `.codeviz/codeviz.db`**. The data exists, the questions are concrete, and one week tells us whether the rest of the plan is sound.
