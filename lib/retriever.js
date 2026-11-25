// Hybrid retrieval (embeddings + BM25) followed by graph expansion.
const STOP = new Set("a an and are as at be by can do does for from how in is it its of on or that the this to was what when where which who why with explain describe between".split(" "));
const tokenize = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => !STOP.has(t));

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function bm25(query, chunks, k1 = 1.5, b = 0.75) {
  const docs = chunks.map((c) => tokenize(c.text));
  const avg = docs.reduce((s, d) => s + d.length, 0) / (docs.length || 1) || 1;
  const terms = [...new Set(tokenize(query))];
  const df = new Map(terms.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  return docs.map((d) => terms.reduce((score, t) => {
    const tf = d.filter((x) => x === t).length;
    if (!tf) return score;
    const idf = Math.log(1 + (docs.length - df.get(t) + 0.5) / (df.get(t) + 0.5));
    return score + (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.length) / avg));
  }, 0));
}

// Reciprocal-rank fusion, so the two incompatible score scales never mix.
function searchChunks(query, queryVector, chunks, k = 6) {
  const fused = new Map();
  const add = (scores) => scores
    .map((s, i) => [s, i]).filter(([s]) => s > 0).sort((x, y) => y[0] - x[0])
    .forEach(([, i], rank) => fused.set(i, (fused.get(i) || 0) + 1 / (60 + rank)));
  add(bm25(query, chunks));
  if (queryVector) add(chunks.map((c) => (c.vector ? cosine(queryVector, c.vector) : 0)));
  return [...fused].sort((x, y) => y[1] - x[1]).slice(0, k).map(([i, score]) => ({ ...chunks[i], score }));
}

// Seeds = concepts named in the query or evidenced by the top chunks. Walk one hop
// along the strongest edges, then bring in the evidence of the concepts reached.
function graphRetrieve(query, queryVector, session, { k = 6, extra = 4 } = {}) {
  const { chunks, graph } = session;
  const hits = searchChunks(query, queryVector, chunks, k);
  const q = new Set(tokenize(query));
  const topIds = new Set(hits.slice(0, 3).map((c) => c.id));
  const score = (n) => {
    const label = tokenize(n.label);
    const named = label.length ? label.filter((t) => q.has(t)).length / label.length : 0;
    return named * 2 + n.chunkIds.filter((id) => topIds.has(id)).length * 0.5;
  };
  const seeds = graph.nodes.map((n) => ({ n, s: score(n) })).filter((x) => x.s >= 0.5)
    .sort((a, b) => b.s - a.s).slice(0, 5).map((x) => x.n.id);
  const nodeIds = new Set(seeds);
  const edges = graph.edges.filter((e) => nodeIds.has(e.source) || nodeIds.has(e.target))
    .sort((a, b) => b.strength - a.strength).slice(0, 10);
  for (const e of edges) { nodeIds.add(e.source); nodeIds.add(e.target); }

  const chosen = new Map(hits.map((c) => [c.id, { ...c, via: "search" }]));
  const reached = new Set(graph.nodes.filter((n) => nodeIds.has(n.id)).flatMap((n) => n.chunkIds));
  const neighbours = chunks.filter((c) => reached.has(c.id) && !chosen.has(c.id));
  // A neighbour's evidence may share no words with the query, so keep unmatched ones last.
  const ranked = searchChunks(query, queryVector, neighbours, extra);
  const rankedIds = new Set(ranked.map((c) => c.id));
  for (const c of [...ranked, ...neighbours.filter((n) => !rankedIds.has(n.id))].slice(0, extra)) {
    chosen.set(c.id, { ...c, via: "graph" });
  }
  return { chunks: [...chosen.values()], nodes: graph.nodes.filter((n) => nodeIds.has(n.id)), edges, seeds };
}

module.exports = { tokenize, cosine, bm25, searchChunks, graphRetrieve };
