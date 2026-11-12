import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const html = await readFile(new URL("index.html", root), "utf8");
const coversDirectory = new URL("public/covers/", root);
const manifestUrl = new URL("public/book-covers.json", root);

let previousManifest = [];
try {
  previousManifest = JSON.parse(await readFile(manifestUrl, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") console.warn(`Could not reuse the existing cover manifest: ${error.message}`);
}

const decodeEntities = (value) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");

const books = [...html.matchAll(/<li class="book"><span class="book-title">([\s\S]*?)<\/span><span class="book-author">([\s\S]*?)<\/span><\/li>/g)].map(
  ([, title, author]) => ({ title: decodeEntities(title), author: decodeEntities(author) }),
);

const normalize = (value) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const scoreCandidate = (candidateTitle, candidateAuthors, book) => {
  const targetTitle = normalize(book.title);
  const resultTitle = normalize(candidateTitle || "");
  const targetWords = new Set(targetTitle.split(" "));
  const resultWords = new Set(resultTitle.split(" "));
  const overlap = [...targetWords].filter((word) => resultWords.has(word)).length / Math.max(targetWords.size, 1);
  const authorText = normalize((candidateAuthors || []).join(" "));
  const authorNames = normalize(book.author).split(" ");
  const authorMatch = authorNames.filter((name) => name.length > 2 && authorText.includes(name)).length;

  let score = overlap * 55 + authorMatch * 8;
  if (resultTitle === targetTitle) score += 100;
  else if (resultTitle.includes(targetTitle) || targetTitle.includes(resultTitle)) score += 45;
  return score;
};

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function appleBooksCover(book) {
  const url = new URL("https://itunes.apple.com/search");
  url.searchParams.set("term", `${book.title} ${book.author}`);
  url.searchParams.set("entity", "ebook");
  url.searchParams.set("country", "us");
  url.searchParams.set("limit", "25");
  const response = await fetch(url);
  if (!response.ok) return null;
  const payload = await response.json();
  const candidates = (payload.results || [])
    .filter((item) => {
      const title = normalize(item.trackName || "");
      return item.artworkUrl100 && !/(summary|analysis|workbook|study guide)\b/.test(title);
    })
    .map((item) => ({
      score: scoreCandidate(item.trackName, [item.artistName], book),
      title: item.trackName,
      authors: [item.artistName],
      url: item.artworkUrl100.replace("100x100bb", "600x900bb"),
      source: "Apple Books",
    }))
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.score >= 60 ? candidates[0] : null;
}

async function googleCover(book) {
  const queries = [`intitle:"${book.title}" inauthor:"${book.author}"`, `${book.title} ${book.author}`];

  for (const query of queries) {
    const url = new URL("https://www.googleapis.com/books/v1/volumes");
    url.searchParams.set("q", query);
    url.searchParams.set("maxResults", "10");
    url.searchParams.set("printType", "books");
    const response = await fetch(url);
    if (!response.ok) continue;
    const payload = await response.json();
    const candidates = (payload.items || [])
      .filter((item) => item.volumeInfo?.imageLinks)
      .map((item) => ({
        score: scoreCandidate(item.volumeInfo.title, item.volumeInfo.authors, book),
        title: item.volumeInfo.title,
        authors: item.volumeInfo.authors || [],
        url:
          item.volumeInfo.imageLinks.large ||
          item.volumeInfo.imageLinks.medium ||
          item.volumeInfo.imageLinks.small ||
          item.volumeInfo.imageLinks.thumbnail ||
          item.volumeInfo.imageLinks.smallThumbnail,
      }))
      .sort((a, b) => b.score - a.score);

    if (candidates[0]?.score >= 45) {
      return {
        ...candidates[0],
        url: candidates[0].url.replace(/^http:/, "https:").replace("&edge=curl", ""),
        source: "Google Books",
      };
    }
  }
  return null;
}

async function openLibraryCover(book) {
  const searches = [
    { title: book.title, author: book.author },
    { q: `${book.title} ${book.author}` },
  ];

  for (const parameters of searches) {
    const url = new URL("https://openlibrary.org/search.json");
    Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, value));
    url.searchParams.set("limit", "10");
    url.searchParams.set("fields", "title,author_name,cover_i");
    const response = await fetch(url, { headers: { "User-Agent": "SarthakPattnaikPortfolio/1.0" } });
    if (!response.ok) continue;
    const payload = await response.json();
    const candidates = (payload.docs || [])
      .filter((document) => {
        const title = normalize(document.title || "");
        return document.cover_i && !/^(summary|analysis|workbook|study guide)\b/.test(title);
      })
      .map((document) => ({
        score: scoreCandidate(document.title, document.author_name, book),
        title: document.title,
        authors: document.author_name || [],
        url: `https://covers.openlibrary.org/b/id/${document.cover_i}-L.jpg`,
        source: "Open Library",
      }))
      .sort((a, b) => b.score - a.score);
    if (candidates[0]?.score >= 45) return candidates[0];
  }
  return null;
}

async function downloadCover(candidate, baseName) {
  if (!candidate) return null;
  const response = await fetch(candidate.url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const contentType = response.headers.get("content-type") || "";
  if (!response.ok || !contentType.startsWith("image/")) return null;
  const extension = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
  const fileName = `${baseName}.${extension}`;
  await writeFile(new URL(fileName, coversDirectory), Buffer.from(await response.arrayBuffer()));
  return fileName;
}

const xmlEscape = (value) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function wrapTitle(title, maxCharacters = 20) {
  const lines = [];
  let current = "";
  for (const word of title.split(" ")) {
    if (`${current} ${word}`.trim().length > maxCharacters && current) {
      lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, 6);
}

async function createFallbackCover(book, baseName, index) {
  const palettes = [
    ["#244f43", "#f2e8cf"],
    ["#8f4934", "#faedd7"],
    ["#344f70", "#f0e9d9"],
    ["#72563a", "#f4e8cc"],
    ["#603c4b", "#f1e5d3"],
  ];
  const [background, foreground] = palettes[index % palettes.length];
  const lines = wrapTitle(book.title);
  const titleTspans = lines
    .map((line, lineIndex) => `<tspan x="150" dy="${lineIndex === 0 ? 0 : 31}">${xmlEscape(line)}</tspan>`)
    .join("");
  const titleY = 205 - (lines.length - 1) * 15;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
  <rect width="300" height="450" fill="${background}"/>
  <rect x="17" y="17" width="266" height="416" fill="none" stroke="${foreground}" stroke-opacity=".55"/>
  <path d="M55 72h190M55 85h190" stroke="${foreground}" stroke-opacity=".7"/>
  <text x="150" y="${titleY}" fill="${foreground}" font-family="Georgia,serif" font-size="25" text-anchor="middle">${titleTspans}</text>
  <text x="150" y="365" fill="${foreground}" font-family="Arial,sans-serif" font-size="13" letter-spacing="1.2" text-anchor="middle">${xmlEscape(book.author.toUpperCase())}</text>
  <path d="M95 392h110" stroke="${foreground}" stroke-opacity=".7"/>
</svg>`;
  const fileName = `${baseName}.svg`;
  await writeFile(new URL(fileName, coversDirectory), svg);
  return fileName;
}

await mkdir(coversDirectory, { recursive: true });
const manifest = [];

for (const [index, book] of books.entries()) {
  const baseName = String(index + 1).padStart(3, "0");
  const previous = previousManifest[index];
  if (previous?.title === book.title && previous?.author === book.author && previous?.source !== "Designed fallback") {
    manifest.push(previous);
    console.log(`${baseName} ${book.title} → retained ${previous.source}`);
    continue;
  }

  let candidate = null;
  let fileName = null;

  for (const lookup of [appleBooksCover, googleCover, openLibraryCover]) {
    try {
      candidate = await lookup(book);
      fileName = await downloadCover(candidate, baseName);
      if (fileName) break;
    } catch (error) {
      console.warn(`${baseName} ${lookup.name} failed: ${error.message}`);
    }
  }

  if (!fileName) {
    fileName = await createFallbackCover(book, baseName, index);
    candidate = { source: "Designed fallback", title: book.title, authors: [book.author], score: null };
  }

  manifest.push({
    title: book.title,
    author: book.author,
    cover: `/covers/${fileName}`,
    source: candidate.source,
    matchedTitle: candidate.title,
    matchedAuthors: candidate.authors,
    matchScore: candidate.score,
  });
  console.log(`${baseName} ${book.title} → ${candidate.source}${candidate.title ? ` (${candidate.title})` : ""}`);
  await delay(120);
}

const referencedFiles = new Set(manifest.map((record) => record.cover.split("/").pop()));
for (const fileName of await readdir(coversDirectory)) {
  if (/^\d{3}\.(jpg|png|webp|svg)$/.test(fileName) && !referencedFiles.has(fileName)) {
    await unlink(new URL(fileName, coversDirectory));
  }
}

await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Saved ${manifest.length} cover records.`);
