// One JSON file per session so progress survives a restart.
const fs = require("fs");
const path = require("path");
const DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/; // also blocks path traversal
const cache = new Map();

function get(id) {
  if (!UUID.test(id)) return null;
  if (!cache.has(id)) {
    const file = path.join(DIR, `${id}.json`);
    if (!fs.existsSync(file)) return null;
    cache.set(id, JSON.parse(fs.readFileSync(file, "utf8")));
  }
  return cache.get(id);
}

function save(session) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `${session.id}.json`);
  fs.writeFileSync(file + ".tmp", JSON.stringify(session));
  fs.renameSync(file + ".tmp", file);
  cache.set(session.id, session);
}

module.exports = { get, save };
