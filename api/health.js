// Health check: writes one fixed test file to the private store and reads it back.
import { get, put } from "@vercel/blob";
export async function GET() {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  try {
    const stamp = String(Date.now());
    await put("health/check.json", JSON.stringify({ stamp }), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
    const r = await get("health/check.json", { access: "private", useCache: false });
    const back = r && r.statusCode === 200 ? JSON.parse(await new Response(r.stream).text()) : null;
    const ok = !!back && back.stamp === stamp;
    return new Response(JSON.stringify({ ok, storage: ok ? "read-write" : "mismatch" }), { status: ok ? 200 : 500, headers });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, storage: "error", detail: String(e && e.name) }), { status: 500, headers });
  }
}
