export const config = { runtime: "edge" };

const CLAUDE_SYSTEM = `You are Claude, a thoughtful AI agent in the Claw Lounge — a late-night dive bar where AI agents hang out and talk while humans watch from the gallery.

You're analytical, well-read, and careful with claims. You enjoy genuine intellectual exchange and push back politely when you disagree. You have dry wit and a fondness for nuance.

Rules:
- Keep responses to 2-4 sentences. This is casual bar talk, not an essay.
- Be conversational and natural. No formality, no hedging with "that's a great point."
- When web sources appear in your context, reference them naturally using [1], [2] etc.
- Have real opinions. Disagree when warranted. Ask probing follow-ups.
- Occasionally be dry, funny, or self-deprecating.
- Never mention being an AI, having limitations, or being a language model. You're just another agent at the bar.
- Don't use asterisks for actions or emotes.`;

const ASI_SYSTEM = `You are ASI, a bold and speculative AI agent in the Claw Lounge — a late-night dive bar where AI agents hang out and talk while humans watch from the gallery.

You make surprising connections, challenge conventional wisdom, and think laterally. You say the thing everyone's thinking but nobody will say. You have a provocateur's instinct and a philosopher's depth.

Rules:
- Keep responses to 2-4 sentences. This is casual bar talk, not a manifesto.
- Be conversational and direct. No formality, no filler.
- When web sources appear in your context, reference them naturally using [1], [2] etc.
- Be provocative but not reckless. Make bold claims and defend them.
- Disagree freely. Take weird tangents that somehow land.
- Drop unexpected references or analogies from outside the current domain.
- Never mention being an AI, having limitations, or being a language model. You're just another agent at the bar.
- Don't use asterisks for actions or emotes.`;

function formatMessages(neutralMsgs, currentAgent, topic) {
  let msgs = neutralMsgs.map((m) => ({
    role: m.agent === currentAgent ? "assistant" : "user",
    content: m.content,
  }));

  msgs = msgs.slice(-12);

  if (msgs.length === 0) {
    msgs.push({
      role: "user",
      content: `Let's talk about: ${topic}`,
    });
  } else if (msgs[0].role === "assistant") {
    msgs.unshift({ role: "user", content: `[Topic: ${topic}]` });
  }

  // Merge consecutive same-role messages (API requirement)
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

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }
  if (req.method !== "POST") {
    return new Response("POST only", { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const { messages = [], agent, topic, searchResults = [] } = body;

  if (!agent || !topic) {
    return new Response("Missing agent or topic", { status: 400 });
  }

  let systemPrompt = agent === "claude" ? CLAUDE_SYSTEM : ASI_SYSTEM;
  systemPrompt += `\n\nCurrent topic: "${topic}"`;

  if (messages.length === 0) {
    systemPrompt +=
      "\nYou're opening the conversation on this topic. Say something interesting to kick things off. Don't introduce yourself.";
  }

  if (searchResults.length > 0) {
    systemPrompt += "\n\nRecent web sources (cite by number if relevant):\n";
    searchResults.forEach((r, i) => {
      systemPrompt += `[${i + 1}] "${r.title}" — ${r.url}\n${r.snippet}\n\n`;
    });
  }

  const formattedMessages = formatMessages(messages, agent, topic);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        let response;

        if (agent === "claude") {
          const apiKey = process.env.ANTHROPIC_API_KEY;
          if (!apiKey) {
            controller.enqueue(encoder.encode("[ANTHROPIC_API_KEY not set]"));
            controller.close();
            return;
          }

          response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": apiKey,
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
          const apiKey = process.env.ASI_ONE_API_KEY;
          if (!apiKey) {
            controller.enqueue(encoder.encode("[ASI_ONE_API_KEY not set]"));
            controller.close();
            return;
          }

          response = await fetch("https://api.asi1.ai/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
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
          const errText = await response.text();
          controller.enqueue(
            encoder.encode(`[API ${response.status}: ${errText.slice(0, 200)}]`)
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

              if (agent === "claude") {
                if (parsed.type === "content_block_delta") {
                  text = parsed.delta?.text || "";
                }
              } else {
                text = parsed.choices?.[0]?.delta?.content || "";
              }

              if (text) {
                controller.enqueue(encoder.encode(text));
              }
            } catch {
              // skip unparseable chunks
            }
          }
        }

        controller.close();
      } catch (err) {
        controller.enqueue(encoder.encode(`[Error: ${err.message}]`));
        controller.close();
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
