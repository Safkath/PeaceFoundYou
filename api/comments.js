import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Pool } from "@neondatabase/serverless";
import { videos } from "./video-manifest.js";

const MAX_BODY_BYTES = 4096;
const MAX_COMMENTS_PER_VIDEO = 250;
const MAX_TOTAL_COMMENTS = 5000;
const MAX_VOTES_PER_COMMENT = 500;
const MAX_TOTAL_VOTES = 25000;
const VIDEO_ID_PATTERN = /^video([1-9][0-9]{0,2})$/;
const COMMENT_ID_PATTERN = /^[a-f0-9]{24}$/;
const VALID_VIDEO_IDS = new Set(videos.map((video) => `video${video.number}`));

let pool;
let schemaPromise;

function getPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured.");
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  return pool;
}

async function ensureSchema() {
  if (!schemaPromise) {
    const database = getPool();
    schemaPromise = (async () => {
      await database.query(`
        CREATE TABLE IF NOT EXISTS pfy_comments (
          id text PRIMARY KEY,
          video_id text NOT NULL,
          name varchar(32) NOT NULL,
          body varchar(500) NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await database.query(`
        CREATE TABLE IF NOT EXISTS pfy_comment_votes (
          video_id text NOT NULL,
          comment_id text NOT NULL REFERENCES pfy_comments(id) ON DELETE CASCADE,
          visitor_hash text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (comment_id, visitor_hash)
        )
      `);
      await database.query(`
        CREATE TABLE IF NOT EXISTS pfy_rate_limits (
          rate_key text NOT NULL,
          occurred_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await database.query("CREATE INDEX IF NOT EXISTS pfy_comments_video_created_idx ON pfy_comments (video_id, created_at, id)");
      await database.query("CREATE INDEX IF NOT EXISTS pfy_votes_video_comment_idx ON pfy_comment_votes (video_id, comment_id)");
      await database.query("CREATE INDEX IF NOT EXISTS pfy_rate_limits_key_time_idx ON pfy_rate_limits (rate_key, occurred_at)");
    })();
  }
  try {
    await schemaPromise;
  } catch (error) {
    schemaPromise = null;
    throw error;
  }
}

function sendError(res, status, message, headers = {}) {
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  return res.status(status).json({ error: message });
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (/^[A-Za-z0-9_-]+$/.test(name)) cookies[name] = value;
  }
  return cookies;
}

function sign(value, secret) {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function visitorIdentity(req, res) {
  const secret = process.env.COMMENT_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("COMMENT_SESSION_SECRET must contain at least 32 characters.");

  const cookie = parseCookies(req.headers.cookie).pfy_visitor;
  const match = typeof cookie === "string" && cookie.match(/^([a-f0-9]{64})\.([a-f0-9]{64})$/);
  let token = match && match[1];
  if (match) {
    const supplied = Buffer.from(match[2], "hex");
    const expected = Buffer.from(sign(token, secret), "hex");
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) token = null;
  }
  if (!token) {
    token = randomBytes(32).toString("hex");
    const secure = process.env.VERCEL_ENV ? "; Secure" : "";
    res.setHeader("Set-Cookie", `pfy_visitor=${token}.${sign(token, secret)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`);
  }
  return createHmac("sha256", secret).update(`visitor:${token}`).digest("hex");
}

function assertSameOrigin(req) {
  if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") {
    const error = new Error("Cross-site requests are not allowed.");
    error.status = 403;
    throw error;
  }
  const origin = req.headers.origin;
  if (!origin) {
    const error = new Error("A same-origin request is required.");
    error.status = 403;
    throw error;
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    const error = new Error("Request origin is not allowed.");
    error.status = 403;
    throw error;
  }
  const host = String(req.headers.host || "").toLowerCase();
  if (parsed.host.toLowerCase() !== host || !["http:", "https:"].includes(parsed.protocol)) {
    const error = new Error("Request origin is not allowed.");
    error.status = 403;
    throw error;
  }
}

function validateVideoId(value) {
  if (typeof value !== "string") return false;
  const match = value.match(VIDEO_ID_PATTERN);
  return Boolean(match && Number(match[1]) <= 500 && VALID_VIDEO_IDS.has(value));
}

function cleanText(value, maxLength, label) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxLength * 4) {
    const error = new Error(`${label} is invalid or too long.`);
    error.status = 400;
    throw error;
  }
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  const length = Array.from(cleaned).length;
  if (!length || length > maxLength) {
    const error = new Error(`${label} is required and must be at most ${maxLength} characters.`);
    error.status = 400;
    throw error;
  }
  return cleaned;
}

function getBody(req) {
  const body = req.body;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_BODY_BYTES) {
      const error = new Error("Comment request is too large.");
      error.status = 413;
      throw error;
    }
    return body;
  }
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    const raw = Buffer.isBuffer(body) ? body.toString("utf8") : body;
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      const error = new Error("Comment request is too large.");
      error.status = 413;
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch {
      const error = new Error("Request body must contain valid JSON.");
      error.status = 400;
      throw error;
    }
  }
  const error = new Error("Request body must contain valid JSON.");
  error.status = 400;
  throw error;
}

function getIpHash(req) {
  const secret = process.env.COMMENT_SESSION_SECRET;
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const address = String(req.headers["x-real-ip"] || forwarded || "unknown").slice(0, 100);
  return createHmac("sha256", secret).update(`ip:${address}`).digest("hex");
}

async function beginTransaction() {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function lockKeys(client, keys) {
  for (const key of [...new Set(keys)].sort()) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
  }
}

async function enforceRateLimits(client, entries) {
  const now = new Date();
  await client.query("DELETE FROM pfy_rate_limits WHERE occurred_at < $1", [new Date(now.getTime() - 60 * 60 * 1000)]);
  await lockKeys(client, entries.map((entry) => `rate:${entry.key}`));
  for (const entry of entries) {
    const since = new Date(now.getTime() - entry.windowMs);
    const result = await client.query(
      "SELECT count(*)::int AS count, min(occurred_at) AS oldest FROM pfy_rate_limits WHERE rate_key = $1 AND occurred_at > $2",
      [entry.key, since]
    );
    if (result.rows[0].count >= entry.maximum) {
      const retryAfter = Math.max(1, Math.ceil((new Date(result.rows[0].oldest).getTime() + entry.windowMs - now.getTime()) / 1000));
      const error = new Error("Please wait before trying again.");
      error.status = 429;
      error.retryAfter = retryAfter;
      throw error;
    }
  }
  for (const entry of entries) {
    await client.query("INSERT INTO pfy_rate_limits (rate_key, occurred_at) VALUES ($1, $2)", [entry.key, now]);
  }
}

async function loadComments(client, videoId, visitorHash) {
  const { rows } = await client.query(
    `SELECT c.id, c.name, c.body AS text, c.created_at AS "createdAt",
      count(v.comment_id)::int AS likes,
      COALESCE(bool_or(v.visitor_hash = $2), false) AS liked
     FROM pfy_comments c
     LEFT JOIN pfy_comment_votes v ON v.comment_id = c.id
     WHERE c.video_id = $1
     GROUP BY c.id
     ORDER BY c.created_at ASC, c.id ASC`,
    [videoId, visitorHash]
  );
  return rows;
}

function checkJsonContentType(req) {
  if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "application/json") {
    const error = new Error("Content-Type must be application/json.");
    error.status = 415;
    throw error;
  }
  const length = Number(req.headers["content-length"] || 0);
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_BODY_BYTES) {
    const error = new Error("Comment request is too large.");
    error.status = 413;
    throw error;
  }
}

async function handleGet(req, res) {
  const videoId = typeof req.query?.video === "string" ? req.query.video : "";
  if (!validateVideoId(videoId)) return sendError(res, 400, "A valid video id is required.");
  const visitorHash = visitorIdentity(req, res);
  await ensureSchema();
  const client = await getPool().connect();
  try {
    const comments = await loadComments(client, videoId, visitorHash);
    return res.status(200).json({ comments });
  } finally {
    client.release();
  }
}

async function handlePost(req, res) {
  assertSameOrigin(req);
  checkJsonContentType(req);
  const input = getBody(req);
  if (!input || typeof input !== "object" || Array.isArray(input) || !validateVideoId(input.videoId)) {
    return sendError(res, 400, "A valid video id is required.");
  }

  const visitorHash = visitorIdentity(req, res);
  const ipHash = getIpHash(req);
  const action = input.action ?? "comment";
  if (!["comment", "like"].includes(action)) return sendError(res, 400, "Unsupported comment action.");
  await ensureSchema();
  const client = await beginTransaction();

  try {
    if (action === "like") {
      if (typeof input.commentId !== "string" || !COMMENT_ID_PATTERN.test(input.commentId) || typeof input.liked !== "boolean") {
        await client.query("ROLLBACK");
        return sendError(res, 400, "A valid comment and like state are required.");
      }
      const commentId = input.commentId;
      await lockKeys(client, [
        `vote:${input.videoId}:${commentId}`,
        `vote-cap:${input.videoId}:${commentId}`,
        "vote-cap:total"
      ]);
      await enforceRateLimits(client, [
        { key: `like:ip:${ipHash}`, maximum: 120, windowMs: 60_000 },
        { key: `like:visitor:${visitorHash}`, maximum: 60, windowMs: 60_000 }
      ]);
      const exists = await client.query(
        "SELECT id FROM pfy_comments WHERE id = $1 AND video_id = $2",
        [commentId, input.videoId]
      );
      if (!exists.rowCount) {
        await client.query("ROLLBACK");
        return sendError(res, 404, "Comment not found.");
      }
      if (input.liked) {
        const [perComment, total] = await Promise.all([
          client.query("SELECT count(*)::int AS count FROM pfy_comment_votes WHERE comment_id = $1", [commentId]),
          client.query("SELECT count(*)::int AS count FROM pfy_comment_votes")
        ]);
        const existing = await client.query(
          "SELECT 1 FROM pfy_comment_votes WHERE comment_id = $1 AND visitor_hash = $2",
          [commentId, visitorHash]
        );
        if (!existing.rowCount && (perComment.rows[0].count >= MAX_VOTES_PER_COMMENT || total.rows[0].count >= MAX_TOTAL_VOTES)) {
          await client.query("ROLLBACK");
          return sendError(res, 429, "This comment has reached its like limit.");
        }
        await client.query(
          "INSERT INTO pfy_comment_votes (video_id, comment_id, visitor_hash) VALUES ($1, $2, $3) ON CONFLICT (comment_id, visitor_hash) DO NOTHING",
          [input.videoId, commentId, visitorHash]
        );
      } else {
        await client.query(
          "DELETE FROM pfy_comment_votes WHERE comment_id = $1 AND visitor_hash = $2",
          [commentId, visitorHash]
        );
      }
      const result = await client.query(
        "SELECT count(*)::int AS likes, bool_or(visitor_hash = $2) AS liked FROM pfy_comment_votes WHERE comment_id = $1",
        [commentId, visitorHash]
      );
      await client.query("COMMIT");
      return res.status(200).json({
        id: commentId,
        likes: result.rows[0].likes,
        liked: Boolean(result.rows[0].liked)
      });
    }

    const name = cleanText(input.name ?? "Traveler", 32, "Name");
    const text = cleanText(input.text, 500, "Comment");
    const rateKeys = [
      `comment:ip:${ipHash}`,
      `comment:visitor:${visitorHash}`,
      `comment:cooldown:${visitorHash}`
    ];
    await lockKeys(client, ["comment-cap:total", `comment-cap:${input.videoId}`, ...rateKeys.map((key) => `rate:${key}`)]);
    await enforceRateLimits(client, [
      { key: rateKeys[0], maximum: 30, windowMs: 60 * 60 * 1000 },
      { key: rateKeys[1], maximum: 6, windowMs: 60 * 60 * 1000 },
      { key: rateKeys[2], maximum: 1, windowMs: 10_000 }
    ]);
    const [perVideo, total] = await Promise.all([
      client.query("SELECT count(*)::int AS count FROM pfy_comments WHERE video_id = $1", [input.videoId]),
      client.query("SELECT count(*)::int AS count FROM pfy_comments")
    ]);
    if (perVideo.rows[0].count >= MAX_COMMENTS_PER_VIDEO || total.rows[0].count >= MAX_TOTAL_COMMENTS) {
      await client.query("ROLLBACK");
      return sendError(res, 507, "The comment storage limit has been reached.");
    }
    const id = randomBytes(12).toString("hex");
    await client.query(
      "INSERT INTO pfy_comments (id, video_id, name, body) VALUES ($1, $2, $3, $4)",
      [id, input.videoId, name, text]
    );
    const comments = await loadComments(client, input.videoId, visitorHash);
    await client.query("COMMIT");
    return res.status(201).json({ comments });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");

  if (req.method === "GET") {
    try {
      return await handleGet(req, res);
    } catch (error) {
      console.error("PeaceFoundYou comments GET failed:", error);
      return sendError(res, 503, "Shared comments are temporarily unavailable.");
    }
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return sendError(res, 405, "Method not allowed.");
  }
  try {
    return await handlePost(req, res);
  } catch (error) {
    if (error.status) {
      const headers = error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {};
      return sendError(res, error.status, error.message, headers);
    }
    console.error("PeaceFoundYou comments POST failed:", error);
    return sendError(res, 503, "Shared comments are temporarily unavailable.");
  }
}
