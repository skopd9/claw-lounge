export const config = { runtime: "edge" };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") || "").trim().slice(0, 200);

  if (!query) {
    return json({ ok: true, results: [] });
  }

  const apiKey = process.env.YOU_COM_API_KEY;
  if (!apiKey) {
    // Not an error — search is optional. Signal "disabled" cleanly.
    return json({ ok: false, error_kind: "no_search", detail: "YOU_COM_API_KEY not set", results: [] });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);

  try {
    const res = await fetch(
      `https://api.ydc-index.io/search?query=${encodeURIComponent(query)}&count=5`,
      { headers: { "X-API-Key": apiKey }, signal: ctrl.signal }
    );

    if (!res.ok) {
      return json({ ok: false, error_kind: "upstream", detail: `search returned ${res.status}`, results: [] });
    }

    const data = await res.json();
    const results = (data.hits || []).slice(0, 5).map((hit) => ({
      title: hit.title || "",
      url: hit.url || "",
      snippet: (hit.snippets || [hit.description])[0] || "",
    }));

    return json({ ok: true, results });
  } catch (err) {
    const kind = err.name === "AbortError" ? "timeout" : "network";
    return json({ ok: false, error_kind: kind, detail: "search unavailable", results: [] });
  } finally {
    clearTimeout(timer);
  }
}
