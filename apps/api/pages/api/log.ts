import type { NextApiRequest, NextApiResponse } from 'next';
import { pool } from '../../lib/db';

const INGEST_KEY = process.env.INGEST_KEY;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (req.headers.authorization !== `Bearer ${INGEST_KEY}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const events = req.body;

    if (!Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'No events provided' });
    }

    const client = await pool.connect();

    try {
      const insertPromises = events.map((event) =>
        client.query(
          `INSERT INTO events (user_id, session_id, type, ts, payload)
           VALUES ($1, $2, $3, $4, $5)`,
          [event.user_id, event.session_id, event.type, event.ts, event.payload]
        )
      );

      await Promise.all(insertPromises);
      res.status(200).json({ status: 'ok', inserted: events.length });

    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
