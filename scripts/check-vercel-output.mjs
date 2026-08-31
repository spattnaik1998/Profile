import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const outputFile = new URL("../dist/index.html", import.meta.url);

const server = createServer(async (request, response) => {
  if (request.url !== "/") {
    response.writeHead(404).end("Not found");
    return;
  }

  try {
    const html = await readFile(outputFile);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    response.writeHead(404).end("Not found");
  }
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  const body = await response.text();

  if (response.status !== 200 || !body.includes("<title>Sarthak Pattnaik</title>")) {
    throw new Error(`Expected the Vercel root page to return the portfolio, received ${response.status}`);
  }

  console.log("Vercel root output: 200 OK");
} finally {
  server.close();
}
