// Turns untrusted model output into a graph the rest of the app can rely on.
const { searchChunks } = require("./retriever");

function clamp(v, lo, hi, dflt) {
  return v !== null && v !== "" && Number.isFinite(+v) ? Math.min(hi, Math.max(lo, +v)) : dflt;
}

function normalizeGraph(raw, chunks) {
  if (!raw || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) {
    throw new Error("AI returned incomplete graph data. Please try again.");
  }
  const valid = new Set(chunks.map((c) => c.id));
  const nodes = [];
  const ids = new Set();
  for (const n of raw.nodes) {
    if (!n || !n.id || !n.label || ids.has(String(n.id))) continue;
    const id = String(n.id), label = String(n.label);
    let chunkIds = [...new Set((Array.isArray(n.chunkIds) ? n.chunkIds : []).map(String))].filter((c) => valid.has(c));
    if (!chunkIds.length) chunkIds = searchChunks(label, null, chunks, 2).map((c) => c.id);
    ids.add(id);
    nodes.push({
      id, label, category: String(n.category || "concept").toLowerCase(),
      importance: clamp(n.importance, 1, 5, 3), difficulty: Math.round(clamp(n.difficulty, 1, 3, 2)),
      description: String(n.description || ""), chunkIds,
    });
  }
  if (!nodes.length) throw new Error("AI returned an empty graph. Please try a broader query.");
  const ok = (a, b) => ids.has(a) && ids.has(b) && a !== b;
  const edges = raw.edges.filter(Boolean)
    .map((e) => ({ source: String(e.source), target: String(e.target), label: String(e.label || ""), strength: clamp(e.strength, 0, 1, 0.5) }))
    .filter((e) => ok(e.source, e.target));

  // Accept a prerequisite only if it keeps the relation acyclic.
  const prerequisites = [];
  const reaches = (from, to, seen = new Set()) => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return prerequisites.some((p) => p.before === from && reaches(p.after, to, seen));
  };
  for (const p of Array.isArray(raw.prerequisites) ? raw.prerequisites : []) {
    if (!p) continue;
    const before = String(p.before), after = String(p.after);
    if (!ok(before, after) || prerequisites.some((x) => x.before === before && x.after === after) || reaches(after, before)) continue;
    prerequisites.push({ before, after });
  }
  return { title: String(raw.title || "Knowledge Graph"), nodes, edges, prerequisites };
}

module.exports = { normalizeGraph };
