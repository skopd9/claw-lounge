export const config = { runtime: "edge" };

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get("q");

  if (!query) {
    return new Response(JSON.stringify({ results: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = process.env.YOU_COM_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ results: [], error: "YOU_COM_API_KEY not set" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const res = await fetch(
      `https://api.ydc-index.io/search?query=${encodeURIComponent(query)}&count=5`,
      { headers: { "X-API-Key": apiKey } }
    );

    if (!res.ok) {
      return new Response(
        JSON.stringify({ results: [], error: `You.com returned ${res.status}` }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const data = await res.json();
    const results = (data.hits || []).slice(0, 5).map((hit) => ({
      title: hit.title || "",
      url: hit.url || "",
      snippet: (hit.snippets || [hit.description])[0] || "",
    }));

    return new Response(JSON.stringify({ results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ results: [], error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
