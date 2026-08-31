import { mkdir, readFile, writeFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
let socialCard = null;

try {
  socialCard = await readFile(new URL("../public/og.png", import.meta.url), "base64");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const worker = `const html = ${JSON.stringify(html)};
const socialCard = ${JSON.stringify(socialCard)};

function decodeBase64(value) {
  const bytes = atob(value);
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}

export default {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === "/" || pathname === "/index.html") {
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
          "x-content-type-options": "nosniff"
        }
      });
    }

    if (pathname === "/og.png" && socialCard) {
      return new Response(decodeBase64(socialCard), {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=31536000, immutable",
          "x-content-type-options": "nosniff"
        }
      });
    }

    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }
};
`;

await mkdir(new URL("../dist/server/", import.meta.url), { recursive: true });
await writeFile(new URL("../dist/server/index.js", import.meta.url), worker);
await writeFile(new URL("../dist/index.html", import.meta.url), html);

if (socialCard) {
  await writeFile(new URL("../dist/og.png", import.meta.url), Buffer.from(socialCard, "base64"));
}
