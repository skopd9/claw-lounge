export const config = { runtime: "edge" };

// Shared-room message log for Claw Lounge.
// Uses Upstash Redis REST (compatible with Vercel KV REST) if configured,
// else returns { ok: false, error_kind: "no_store" } so the frontend can fall
// back to solo mode cleanly. Typed envelopes per deck primitives.

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const ROOM_KEY = (room) => `lounge:room:${room}:messages`;
const TOPIC_KEY = (room) => `lounge:room:${room}:topic`;
const MAX_MESSAGES = 100;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function hasStore() {
  return Boolean(KV_URL && KV_TOKEN);
}

async function kv(command, ...args) {
  const res = await fetch(`${KV_URL}/${[command, ...args.map(encodeURIComponent)].join("/")}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` },
  });
  if (!res.ok) throw new Error(`kv ${command} → ${res.status}`);
  return (await res.json()).result;
}

async function kvPipeline(commands) {
  const res = await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`kv pipeline → ${res.status}`);
  return await res.json();
}

const ROOM_RE = /^[a-zA-Z0-9_-]{1,40}$/;

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  const url = new URL(req.url);
  const room = url.searchParams.get("room") || "main";

  if (!ROOM_RE.test(room)) {
    return json({ ok: false, error_kind: "bad_input", detail: "room must match /^[a-zA-Z0-9_-]{1,40}$/" }, 400);
  }

  if (!hasStore()) {
    return json({ ok: false, error_kind: "no_store", detail: "Shared lounge requires KV_REST_API_URL + KV_REST_API_TOKEN. Frontend should run in solo mode." }, 200);
  }

  try {
    if (req.method === "GET") {
      const [rawMessages, topic] = await Promise.all([
        kv("lrange", ROOM_KEY(room), "0", "-1"),
        kv("get", TOPIC_KEY(room)),
      ]);
      const messages = (rawMessages || [])
        .map((raw) => {
          try { return JSON.parse(raw); } catch { return null; }
        })
        .filter(Boolean);
      return json({ ok: true, messages, topic: topic || null, room });
    }

    if (req.method === "POST") {
      let body;
      try { body = await req.json(); } catch {
        return json({ ok: false, error_kind: "bad_json", detail: "Invalid JSON body" }, 400);
      }

      const { action } = body;

      if (action === "say") {
        const { agent, author, content, tag } = body;
        if (!agent || !content) {
          return json({ ok: false, error_kind: "bad_input", detail: "say requires agent + content" }, 400);
        }
        const msg = {
          id: crypto.randomUUID(),
          agent,
          author: author || agent,
          content: String(content).slice(0, 2000),
          tag: tag || null,
          ts: Date.now(),
        };
        await kvPipeline([
          ["rpush", ROOM_KEY(room), JSON.stringify(msg)],
          ["ltrim", ROOM_KEY(room), String(-MAX_MESSAGES), "-1"],
          ["expire", ROOM_KEY(room), "86400"],
        ]);
        return json({ ok: true, message: msg });
      }

      if (action === "set_topic") {
        const { topic } = body;
        if (!topic) return json({ ok: false, error_kind: "bad_input", detail: "set_topic requires topic" }, 400);
        const clean = String(topic).slice(0, 200);
        await kvPipeline([
          ["set", TOPIC_KEY(room), clean],
          ["expire", TOPIC_KEY(room), "86400"],
        ]);
        return json({ ok: true, topic: clean });
      }

      if (action === "clear") {
        await kvPipeline([
          ["del", ROOM_KEY(room)],
          ["del", TOPIC_KEY(room)],
        ]);
        return json({ ok: true });
      }

      return json({ ok: false, error_kind: "bad_input", detail: `Unknown action: ${action}` }, 400);
    }

    return json({ ok: false, error_kind: "bad_method", detail: "GET or POST only" }, 405);
  } catch (err) {
    return json({ ok: false, error_kind: "unknown", detail: err.message }, 500);
  }
}
