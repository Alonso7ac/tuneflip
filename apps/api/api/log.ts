// apps/api/api/log.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "../lib/db";

/**
 * POST /api/log
 * Body:
 * {
 *   "session_id": "uuid",
 *   "user_id": "optional-uuid-or-null",
 *   "device": {"os":"android","app_version":"1.7.2"},
 *   "events": [
 *     {"type":"impression","ts":1734032234123,"track_id":"t_123","position":1,"feed_version":"abc","surface":"discovery"},
 *     {"type":"play_start","ts":1734032235220,"track_id":"t_123","ms_position":0},
 *     {"type":"play_progress","ts":1734032239220,"track_id":"t_123","ms_played_chunk":1800},
 *     {"type":"like","ts":1734032240000,"track_id":"t_123"}
 *   ]
 * }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).end();

  // Optional shared key to prevent random writes
  const wantAuth = !!process.env.INGEST_KEY;
  const okAuth = !wantAuth || req.headers["x-ingest-key"] === process.env.INGEST_KEY;
  if (!okAuth) return res.status(401).json({ error: "unauthorized" });

  const { session_id, user_id = null, device = {}, events = [] } = req.body || {};
  if (!session_id || !Array.isArray(events)) {
    return res.status(400).json({ error: "bad payload" });
  }

  // Normalize & validate a bit
  const rows = events
    .filter((e: any) => e && e.type && e.ts)
    .map((e: any) => ({
      user_id,
      session_id,
      type: String(e.type),
      track_id: e.track_id ? String(e.track_id) : null,
      ts: Number(e.ts),
      payload: e, // keep original event JSON
    }));

  if (!rows.length) return res.status(400).json({ error: "no valid events" });

  try {
    await sql.begin(async (t) => {
      for (const r of rows) {
        await t`
          insert into public.events (user_id, session_id, type, track_id, ts, payload)
          values (${r.user_id}, ${r.session_id}, ${r.type}, ${r.track_id}, ${r.ts}, ${t.json(r.payload)})
        `;
      }
    });
    return res.status(204).end(); // success, no body
  } catch (err: any) {
    console.error("log insert error:", err?.message || err);
    return res.status(500).json({ error: "insert_failed" });
  }
}
