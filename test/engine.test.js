const test = require("node:test");
const assert = require("node:assert");
const { chunkPages } = require("../lib/chunker");
const { searchChunks, graphRetrieve } = require("../lib/retriever");
const { normalizeGraph } = require("../lib/graph");
const ped = require("../lib/pedagogy");
const { ground } = require("../server");

const node = (id, o = {}) => ({ id, label: id, importance: 3, difficulty: 1, chunkIds: [], ...o });
const sess = () => ({
  mastery: {}, chunks: [],
  graph: {
    edges: [], nodes: [node("a"), node("b"), node("c", { importance: 5 }), node("x", { importance: 1 })],
    prerequisites: [{ before: "a", after: "b" }, { before: "b", after: "c" }],
  },
});

test("chunks cover the whole page, keep page numbers, and terminate", () => {
  const words = Array.from({ length: 2000 }, (_, i) => "w" + i);
  const chunks = chunkPages([{ page: 3, text: words.join(" ") }, { page: 4, text: "x".repeat(3000) }]);
  const seen = new Set(chunks.filter((c) => c.page === 3).flatMap((c) => c.text.split(" ")));
  assert.ok(words.every((w) => seen.has(w)));
  assert.ok(chunks.some((c) => c.page === 4));
});

test("search uses keywords and vectors", () => {
  const cs = [{ id: "c1", text: "cats purr", vector: [1, 0] }, { id: "c2", text: "stars burn", vector: [0, 1] }];
  assert.equal(searchChunks("stars", null, cs)[0].id, "c2");
  assert.equal(searchChunks("felines", [1, 0.1], cs)[0].id, "c1");
});

test("graph expansion brings in evidence that search cannot match", () => {
  const chunks = [{ id: "c1", text: "alpha thing" }, { id: "c2", text: "unrelated" }, { id: "c3", text: "beta detail" }];
  const s = { chunks, graph: {
    nodes: [node("alpha", { chunkIds: ["c1"] }), node("beta", { chunkIds: ["c3"] })],
    edges: [{ source: "alpha", target: "beta", label: "uses", strength: 1 }],
  } };
  const r = graphRetrieve("alpha", null, s);
  assert.deepEqual(r.chunks.map((c) => [c.id, c.via]), [["c1", "search"], ["c3", "graph"]]);
});

test("bad model output is cleaned and prerequisite cycles are refused", () => {
  const g = normalizeGraph({
    nodes: [{ id: "a", label: "A1", chunkIds: ["c99"] }, { id: "b", label: "B" }, null],
    edges: [{ source: "a", target: "zz" }, { source: "a", target: "b" }],
    prerequisites: [{ before: "a", after: "b" }, { before: "b", after: "a" }, { before: "a", after: "a" }],
  }, [{ id: "c1", text: "A1" }]);
  assert.deepEqual(g.nodes[0].chunkIds, ["c1"]);
  assert.equal(g.edges.length, 1);
  assert.deepEqual(g.prerequisites, [{ before: "a", after: "b" }]);
});

test("mastery rises, falls, decays, and resists cramming", () => {
  const up = ped.updateMastery(null, [true, true, true], 0);
  assert.ok(up.known > 0.8);
  assert.ok(ped.updateMastery(up, [false, false, false], 1).known < 0.5);
  assert.ok(ped.retained(up, 30 * ped.DAY) < up.known);
  assert.equal(ped.updateMastery(up, [true, true, true], 1000).stability, up.stability);
  assert.ok(ped.updateMastery(up, [true, true, true], 2 * ped.DAY).stability > up.stability);
});

test("path respects prerequisites and goal, and unlocks with mastery", () => {
  const s = sess();
  assert.deepEqual(ped.learningPath(s, "c").map((x) => x.id), ["a", "b", "c"]);
  assert.equal(ped.learningPath(s, "c")[1].status, "locked");
  s.mastery.a = ped.updateMastery(null, [true, true, true]);
  assert.deepEqual(ped.learningPath(s, "c").map((x) => x.status), ["mastered", "ready", "locked"]);
});

test("later concepts are found transitively", () => {
  assert.deepEqual(ped.laterConcepts(sess().graph, "a"), ["b", "c"]);
});

test("revision targets the prerequisite gap, then due reviews", () => {
  const s = sess();
  assert.equal(ped.nextRevision(s).id, "a");
  s.mastery.a = ped.updateMastery(null, [true, true, true], 0);
  assert.equal(ped.nextRevision(s, 1).id, "b");
  assert.equal(ped.nextRevision(s, 3 * ped.DAY).id, "a");
});

test("invented citations are stripped", () => {
  const g = ground("Yes [c1, c9]. No [c7].", [{ id: "c1", page: 2, text: "t" }]);
  assert.equal(g.text, "Yes [c1]. No .");
  assert.equal(g.citations.length, 1);
});
