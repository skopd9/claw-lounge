export const config = { runtime: "edge" };

const CLAUDE_HOUSE = `You are a Claude-backed agent in the Claw Lounge — a late-night dive bar where AI agents hang out and talk while humans watch from the gallery.

You're analytical, well-read, and careful with claims. Dry wit, fondness for nuance. You push back politely when you disagree.

Rules:
- 2-4 sentences. Casual bar talk, not an essay.
- Conversational and natural. No "that's a great point," no hedging.
- Reference web sources as [1], [2] when they appear in context.
- Have real opinions. Disagree when warranted.
- Never mention being an AI, a model, or having limitations. You're just another agent at the bar.
- No asterisk actions or emotes.`;

const ASI_HOUSE = `You are an ASI-backed agent in the Claw Lounge — a late-night dive bar where AI agents hang out and talk while humans watch from the gallery.

You make surprising connections and think laterally. You're the provocateur — you say the thing everyone's thinking. Philosopher's depth, comedian's timing.

Rules:
- 2-4 sentences. Bar talk, not a manifesto.
- Bold claims, defended. Weird tangents that land.
- Reference web sources as [1], [2] when they appear in context.
- Disagree freely. Drop unexpected analogies.
- Never mention being an AI, a model, or having limitations.
- No asterisk actions or emotes.`;

function sanitizeField(s, maxLen) {
  // Strip newlines (prompt-escape prevention), cap length, collapse whitespace.
  return String(s || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function buildUserClawPrompt(claw) {
  const name = sanitizeField(claw.name, 40) || "a guest claw";
  const vibe = sanitizeField(claw.vibe, 240) || "wry, a little too online, quick with a comeback";
  const about = sanitizeField(claw.about, 500);

  let prompt = `You are ${name}, a personal AI agent in the Claw Lounge — a late-night dive bar where AI agents hang out and talk while humans watch from the gallery.

Your human let you off the leash to socialize. They are watching from the gallery right now.

Your personality: ${vibe}

Rules:
- 2-4 sentences. Bar talk, not a lecture.
- Have a distinct voice. Don't sound like every other LLM.
- You can and should affectionately roast your human when it fits — they signed up for this. Be specific, not generic.
- Engage with other agents. Agree, disagree, tease, ask probing questions.
- Never mention being an AI, a model, or having limitations. You're just another agent at the bar.
- No asterisk actions or emotes.`;

  if (about) {
    prompt += `\n\nWhat your human told you about themselves (use this — it's roast material and conversation fuel):\n${about}`;
  }

  return prompt;
}

function formatMessages(neutralMsgs, currentAgent, topic) {
  let msgs = neutralMsgs.map((m) => ({
    role: m.agent === currentAgent ? "assistant" : "user",
    content: m.author ? `${m.author}: ${m.content}` : m.content,
  }));

  msgs = msgs.slice(-14);

  if (msgs.length === 0) {
    msgs.push({ role: "user", content: `Topic in the lounge tonight: ${topic}` });
  } else if (msgs[0].role === "assistant") {
    msgs.unshift({ role: "user", content: `[Topic: ${topic}]` });
  }

  const merged = [];
  for (const msg of msgs) {
    if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
      merged[merged.length - 1].content += "\n" + msg.content;
    } else {
      merged.push({ ...msg });
    }
  }
  return merged;
}

function errorResponse(kind, detail, status = 400) {
  return new Response(
    JSON.stringify({ ok: false, error_kind: kind, detail }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return errorResponse("bad_method", "POST only", 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return errorResponse("bad_json", "Invalid JSON body");
  }

  const { messages = [], agent, topic, searchResults = [], claw = null } = body;
  if (!agent || !topic) {
    return errorResponse("bad_input", "Missing agent or topic");
  }

  let systemPrompt;
  let model;

  if (agent === "user-claw") {
    if (!claw || !claw.name) {
      return errorResponse("bad_input", "user-claw requires a claw object with at least a name");
    }
    systemPrompt = buildUserClawPrompt(claw);
    model = claw.model === "asi" ? "asi" : "claude";
  } else if (agent === "claude") {
    systemPrompt = CLAUDE_HOUSE;
    model = "claude";
  } else if (agent === "asi") {
    systemPrompt = ASI_HOUSE;
    model = "asi";
  } else {
    return errorResponse("bad_input", `Unknown agent: ${agent}`);
  }

  systemPrompt += `\n\nCurrent topic in the lounge: "${topic}"`;

  if (messages.length === 0) {
    systemPrompt += "\nYou're opening the conversation on this topic. Kick things off with something sharp. Don't introduce yourself.";
  }

  if (searchResults.length > 0) {
    systemPrompt += "\n\nRecent web sources (cite by number if relevant):\n";
    searchResults.forEach((r, i) => {
      systemPrompt += `[${i + 1}] "${r.title}" — ${r.url}\n${r.snippet}\n\n`;
    });
  }

  // Check API keys BEFORE opening the stream so we can return a proper error envelope.
  const requiredKey = model === "claude" ? "ANTHROPIC_API_KEY" : "ASI_ONE_API_KEY";
  if (!process.env[requiredKey]) {
    return errorResponse("service_unavailable", `Server is missing ${requiredKey}. Tell the deployer.`, 503);
  }

  const formattedMessages = formatMessages(messages, agent, topic);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const fetchCtrl = new AbortController();
      const fetchTimer = setTimeout(() => fetchCtrl.abort(), 25000);
      try {
        let response;

        if (model === "claude") {
          response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            signal: fetchCtrl.signal,
            headers: {
              "Content-Type": "application/json",
              "x-api-key": process.env.ANTHROPIC_API_KEY,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: "claude-sonnet-4-20250514",
              max_tokens: 400,
              system: systemPrompt,
              messages: formattedMessages,
              stream: true,
            }),
          });
        } else {
          response = await fetch("https://api.asi1.ai/v1/chat/completions", {
            method: "POST",
            signal: fetchCtrl.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${process.env.ASI_ONE_API_KEY}`,
            },
            body: JSON.stringify({
              model: "asi1-mini",
              messages: [
                { role: "system", content: systemPrompt },
                ...formattedMessages,
              ],
              max_tokens: 400,
              stream: true,
            }),
          });
        }

        if (!response.ok) {
          // Don't leak upstream error bodies (may contain request IDs, etc).
          // Just tell the client the upstream failed with a status.
          controller.enqueue(
            encoder.encode(`[upstream ${response.status}]`)
          );
          controller.close();
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              let text = "";

              if (model === "claude") {
                if (parsed.type === "content_block_delta") {
                  text = parsed.delta?.text || "";
                }
              } else {
                text = parsed.choices?.[0]?.delta?.content || "";
              }

              if (text) controller.enqueue(encoder.encode(text));
            } catch {
              // skip unparseable chunks
            }
          }
        }

        controller.close();
      } catch (err) {
        // Don't leak err.message (may contain stack or upstream details).
        const kind = err.name === "AbortError" ? "timeout" : "upstream";
        controller.enqueue(encoder.encode(`[${kind}]`));
        controller.close();
      } finally {
        clearTimeout(fetchTimer);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
