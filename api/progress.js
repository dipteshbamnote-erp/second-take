// Second Take progress backup.
// One private JSON file per student in a private Vercel Blob store.
// The student holds a random recovery code; the file name is a SHA-256 hash of it,
// so the code itself is never stored and nobody can list or guess another student's file.
import { get, put, del, BlobPreconditionFailedError } from "@vercel/blob";
import { createHash } from "node:crypto";

const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_RE = new RegExp("^[" + ALPHA + "]{20}$");
const MAX_BODY = 1_500_000;
const MAX_TAKES = 5000;

const headers = { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers });

function codeFrom(request) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const c = m[1].toUpperCase().replace(/[^A-Z0-9]/g, "");
  return CODE_RE.test(c) ? c : null;
}
const pathFor = (code) => "progress/" + createHash("sha256").update("secondtake:v1:" + code).digest("hex") + ".json";

const str = (v, n) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function cleanProfile(p) {
  if (!p || typeof p !== "object") return null;
  const out = { name: str(p.name, 120), email: str(p.email, 160), college: str(p.college, 160), batch: str(p.batch, 80), since: num(p.since), u: num(p.u) };
  return out.name && out.email ? out : null;
}
function cleanPlan(p) {
  if (!p || typeof p !== "object" || !/^\d{4}-\d{2}-\d{2}$/.test(p.date || "")) return null;
  const perDay = Math.min(4, Math.max(1, Math.round(num(p.perDay)) || 2));
  const time = /^\d{2}:\d{2}$/.test(p.time || "") ? p.time : "20:00";
  return { date: p.date, perDay, time, u: num(p.u) };
}
function cleanTake(t) {
  if (!t || typeof t !== "object") return null;
  const ts = num(t.ts), s = Math.round(num(t.s)), n = Math.round(num(t.n));
  const ty = str(t.ty, 40);
  if (!ts || n < 1 || n > 30 || s < 0 || s > n || !/^[A-Za-z0-9_]+$/.test(ty)) return null;
  const miss = Array.isArray(t.miss) ? t.miss.filter((k) => typeof k === "string" && /^[A-Za-z0-9_]{1,40}$/.test(k)).slice(0, 30) : [];
  return { f: str(t.f, 60), ty, p: str(t.p, 600), s, n, miss, ts, v: t.v ? 1 : 0 };
}
function clean(d) {
  const takes = Array.isArray(d && d.takes) ? d.takes.map(cleanTake).filter(Boolean) : [];
  return { profile: cleanProfile(d && d.profile), plan: cleanPlan(d && d.plan), clearedAt: num(d && d.clearedAt), takes };
}
// Union of both sides: nothing one device saved is dropped by another.
function merge(a, b) {
  const clearedAt = Math.max(a.clearedAt || 0, b.clearedAt || 0);
  const seen = new Set(), takes = [];
  for (const t of [...(a.takes || []), ...(b.takes || [])]) {
    const k = t.ts; // one take per timestamp
    if (t.ts > clearedAt && !seen.has(k)) { seen.add(k); takes.push(t); }
  }
  takes.sort((x, y) => x.ts - y.ts);
  const newer = (x, y) => (!x ? y : !y ? x : (y.u || 0) > (x.u || 0) ? y : x);
  return { v: 1, profile: newer(a.profile, b.profile), plan: newer(a.plan, b.plan), clearedAt, takes: takes.slice(-MAX_TAKES) };
}

async function read(path) {
  const r = await get(path, { access: "private", useCache: false });
  if (!r || r.statusCode !== 200) return { data: null, etag: null };
  const text = await new Response(r.stream).text();
  try { return { data: clean(JSON.parse(text)), etag: r.blob.etag }; } catch { return { data: null, etag: r.blob.etag }; }
}

export async function GET(request) {
  const code = codeFrom(request);
  if (!code) return reply(400, { error: "bad_code" });
  try {
    const { data } = await read(pathFor(code));
    return data ? reply(200, { data }) : reply(404, { error: "not_found" });
  } catch (e) {
    console.error("progress GET", e && e.message);
    return reply(503, { error: "unavailable" });
  }
}

export async function PUT(request) {
  const code = codeFrom(request);
  if (!code) return reply(400, { error: "bad_code" });
  const raw = await request.text();
  if (raw.length > MAX_BODY) return reply(413, { error: "too_large" });
  let incoming;
  try { incoming = clean(JSON.parse(raw)); } catch { return reply(400, { error: "bad_json" }); }
  const path = pathFor(code);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const { data, etag } = await read(path);
      const merged = merge(data || { takes: [] }, incoming);
      merged.updated = Date.now();
      await put(path, JSON.stringify(merged), {
        access: "private", addRandomSuffix: false, allowOverwrite: true,
        contentType: "application/json", ...(etag ? { ifMatch: etag } : {}),
      });
      return reply(200, { data: merged });
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError) continue; // another device saved first: merge again
      console.error("progress PUT", e && e.message);
      return reply(503, { error: "unavailable" });
    }
  }
  return reply(409, { error: "busy" });
}

export async function DELETE(request) {
  const code = codeFrom(request);
  if (!code) return reply(400, { error: "bad_code" });
  try { await del(pathFor(code)); return reply(200, { deleted: true }); }
  catch (e) { console.error("progress DELETE", e && e.message); return reply(503, { error: "unavailable" }); }
}
