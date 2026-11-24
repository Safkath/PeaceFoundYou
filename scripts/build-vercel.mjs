import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "dist");
const videoDirectory = path.join(root, "video");
const maxVideoNumber = 500;
const extensions = new Set(["mp4", "webm", "mov"]);
const assets = ["background.jpg", "bg.jpg", "bg.png", "bg.webp", "bg1.jpg", "bg2.jpg", "bg3.jpg", "bg.mp3", "peacefoundyou-icon.png"];

function contentHash(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filename);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").slice(0, 16)));
  });
}

await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "video"), { recursive: true });
await cp(path.join(root, "index.html"), path.join(output, "index.html"));

for (const asset of assets) {
  const source = path.join(root, asset);
  try {
    if ((await stat(source)).isFile()) await cp(source, path.join(output, asset));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const videosByNumber = new Map();
for (const entry of await readdir(videoDirectory, { withFileTypes: true })) {
  const match = entry.name.match(/^video([1-9][0-9]{0,2})\.(mp4|webm|mov)$/i);
  if (!match || !entry.isFile()) continue;
  const number = Number(match[1]);
  const extension = match[2].toLowerCase();
  if (number > maxVideoNumber || !extensions.has(extension)) continue;
  const previous = videosByNumber.get(number);
  const priority = { mp4: 0, webm: 1, mov: 2 };
  if (previous && priority[previous.extension] <= priority[extension]) continue;
  videosByNumber.set(number, { number, file: entry.name, extension });
}

const videos = await Promise.all([...videosByNumber.values()]
  .sort((a, b) => b.number - a.number)
  .map(async ({ number, file }) => ({
    number,
    src: `video/${encodeURIComponent(file)}?v=${await contentHash(path.join(videoDirectory, file))}`,
    duration: 0
  })));

for (const video of videos) {
  const filename = decodeURIComponent(video.src.slice("video/".length).split("?", 1)[0]);
  await cp(path.join(videoDirectory, filename), path.join(output, "video", filename));
}

await writeFile(path.join(output, "videos.json"), JSON.stringify({ videos }), "utf8");
console.log(`Prepared Vercel static output with ${videos.length} video(s).`);
