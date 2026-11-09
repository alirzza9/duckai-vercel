# duckai-vercel — Duck.ai solver + chat as Vercel serverless functions

Same logic as the VM service (`~/workspace/duckai-service/`), adapted to
Vercel Node.js serverless functions. **Zero npm dependencies, Node >= 20.**
The challenge solver (`shim.js`) is byte-identical to the proven VM copy
(variants A/B/D/E as of 2026-11-09); do not edit it — replace it only with a
newer proven copy from the VM service.

## Endpoints

- `GET /api/health` → `{"ok":true,"uptime_s":N,"started_at":"..."}` (no auth)
- `POST /api/chat` → Bearer auth. Body:
  `{"messages":[{"role":"user","content":"..."}, ...],"model":"<short name or exact id>"}`
  Success: `{"reply":"<text>"}`. Failure:
  `{"error":"<short code>","detail":"<one line>"}` — no retry loop; the
  caller falls back on 403/418/rate-limit.
- Models (free, no key): `gpt-6-luna` (default), `gpt-5.4-mini`,
  `claude-haiku-5-5`, `mistral-small-2603`, `tinfoil/gpt-oss-120b`,
  `tinfoil/gemma4-31b`. Short aliases `luna/mini/haiku/mistral/oss/gemma` work.

## Env var

- `DUCKAI_SECRET` (**required**) — the Bearer token the bot must send.
  Set it in the Vercel project settings (Production + Preview). If it is
  missing, `/api/chat` returns `500 {"error":"server_error",...}`.
  There is **no `.secret` file on Vercel** and the value must never be
  committed to the repo.

## Deploy

```bash
vercel deploy --prod   # or deploy via the Vercel dashboard / MCP
```

The bot's `DUCKAI_URL` becomes `https://<project>.vercel.app/api`
(the bot appends `/chat`).

## Limits (Vercel Hobby, 2026)

- `maxDuration: 60` s on `api/chat.js` (set in `vercel.json`; Hobby cap is
  300 s with Fluid compute — the service's own 30 s chat timeout is the
  binding limit).
- Cold starts: the first request after idle pays a few hundred ms; the
  handshake + chat still fits comfortably in 60 s.
- 1M function invocations/month, 100 GB bandwidth/month on Hobby.
- Per-request: fresh duck.ai handshake (proofs expire in minutes, never
  cached); body cap 64 KB; max 40 messages.

## Caveats

- duck.ai is an undocumented private endpoint: it can break, rotate
  challenge variants, or rate-limit at any time. Intermittent HTTP 418
  `challenge_rejected` is inherent (~25–30% in VM runs); the caller should
  retry once on 418 with a fresh request, then fall back.
- No sensitive data through this service: duck.ai may retain prompts.
- Logs carry counts / latencies / error codes only — never prompt or reply
  content.
