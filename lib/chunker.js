// PDF -> per-page text -> overlapping chunks that remember their page number.
async function extractPages(buffer) {
  const pdfParse = require("pdf-parse"); // lazy: its index can run a self-test on load
  const pages = [];
  await pdfParse(buffer, {
    pagerender: async (page) => {
      const { items } = await page.getTextContent();
      let text = "", lastY;
      for (const item of items) {
        const y = item.transform[5];
        text += lastY === undefined || lastY === y ? item.str : "\n" + item.str;
        lastY = y;
      }
      pages.push({ page: page.pageNumber, text });
      return text;
    },
  });
  return pages.sort((a, b) => a.page - b.page);
}

function chunkPages(pages, size = 900, overlap = 150) {
  const chunks = [];
  for (const { page, text } of pages) {
    const clean = text.replace(/\s+/g, " ").trim();
    let start = 0;
    while (start < clean.length) {
      let end = Math.min(start + size, clean.length);
      if (end < clean.length) {
        // Prefer a sentence end, then a space, in the second half of the window.
        const min = start + Math.floor(size / 2);
        const dot = clean.lastIndexOf(". ", end - 2);
        const space = clean.lastIndexOf(" ", end);
        if (dot > min) end = dot + 1;
        else if (space > min) end = space;
      }
      const piece = clean.slice(start, end).trim();
      if (piece) chunks.push({ id: `c${chunks.length + 1}`, page, text: piece });
      if (end >= clean.length) break;
      let next = end - overlap;
      const space = clean.indexOf(" ", next);
      if (space !== -1 && space < end) next = space + 1;
      start = next;
    }
  }
  return chunks;
}

module.exports = { extractPages, chunkPages };
