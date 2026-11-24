import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "@neondatabase/serverless";

const sourcePath = process.argv[2];
const videoPattern = /^video([1-9][0-9]{0,2})$/;
const commentPattern = /^[a-f0-9]{24}$/;

if (!sourcePath) {
  throw new Error("Usage: node --env-file=.env scripts/import-comments.mjs <path-to-comments.json>");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");

const legacy = JSON.parse(await readFile(sourcePath, "utf8"));
const commentsByVideo = legacy && typeof legacy.comments === "object" && legacy.comments
  ? legacy.comments
  : {};
const votesByVideo = legacy && typeof legacy.votes === "object" && legacy.votes
  ? legacy.votes
  : {};
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const client = await pool.connect();
let commentsImported = 0;
let votesImported = 0;

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS pfy_comments (
      id text PRIMARY KEY,
      video_id text NOT NULL,
      name varchar(32) NOT NULL,
      body varchar(500) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS pfy_comment_votes (
      video_id text NOT NULL,
      comment_id text NOT NULL REFERENCES pfy_comments(id) ON DELETE CASCADE,
      visitor_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (comment_id, visitor_hash)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS pfy_rate_limits (
      rate_key text NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query("CREATE INDEX IF NOT EXISTS pfy_comments_video_created_idx ON pfy_comments (video_id, created_at, id)");
  await client.query("CREATE INDEX IF NOT EXISTS pfy_votes_video_comment_idx ON pfy_comment_votes (video_id, comment_id)");
  await client.query("CREATE INDEX IF NOT EXISTS pfy_rate_limits_key_time_idx ON pfy_rate_limits (rate_key, occurred_at)");

  await client.query("BEGIN");
  let totalComments = 0;
  for (const [videoId, items] of Object.entries(commentsByVideo)) {
    const videoMatch = videoId.match(videoPattern);
    if (!videoMatch || Number(videoMatch[1]) > 500 || !Array.isArray(items)) continue;
    for (const item of items) {
      if (totalComments >= 5000 || !item || !commentPattern.test(item.id || "")
          || typeof item.name !== "string" || typeof item.text !== "string") break;
      const name = item.name.trim();
      const text = item.text.trim();
      const createdAt = new Date(item.createdAt);
      if (!name || Array.from(name).length > 32 || !text || Array.from(text).length > 500
          || !Number.isFinite(createdAt.getTime())) continue;
      const inserted = await client.query(
        `INSERT INTO pfy_comments (id, video_id, name, body, created_at)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [item.id, videoId, name, text, createdAt]
      );
      if (inserted.rowCount) commentsImported++;
      totalComments++;
    }
  }

  let totalVotes = 0;
  for (const [videoId, videoVotes] of Object.entries(votesByVideo)) {
    if (!videoId.match(videoPattern) || !videoVotes || typeof videoVotes !== "object") continue;
    for (const [commentId, voters] of Object.entries(videoVotes)) {
      if (!commentPattern.test(commentId) || !voters || typeof voters !== "object") continue;
      const exists = await client.query(
        "SELECT id FROM pfy_comments WHERE id = $1 AND video_id = $2",
        [commentId, videoId]
      );
      if (!exists.rowCount) continue;
      for (const [legacyVisitor, liked] of Object.entries(voters)) {
        if (totalVotes >= 25000 || liked !== true || !/^[a-f0-9]{64}$/.test(legacyVisitor)) continue;
        const visitorHash = createHash("sha256").update(`legacy:${legacyVisitor}`).digest("hex");
        const inserted = await client.query(
          `INSERT INTO pfy_comment_votes (video_id, comment_id, visitor_hash)
           VALUES ($1, $2, $3) ON CONFLICT (comment_id, visitor_hash) DO NOTHING`,
          [videoId, commentId, visitorHash]
        );
        if (inserted.rowCount) votesImported++;
        totalVotes++;
      }
    }
  }

  await client.query("COMMIT");
  console.log(`Imported ${commentsImported} comment(s) and ${votesImported} historical like(s).`);
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
