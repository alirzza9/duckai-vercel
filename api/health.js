// duckai-vercel — api/health.js
// Vercel Node.js serverless function: GET /api/health (no auth).
'use strict';

const STARTED_AT = new Date().toISOString();

module.exports = async (req, res) => {
  const body = JSON.stringify({ ok: true, uptime_s: Math.floor(process.uptime()), started_at: STARTED_AT });
  res.status(200);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
};
