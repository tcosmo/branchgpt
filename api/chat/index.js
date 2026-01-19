const API_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-5.2";
const SYSTEM_PROMPT =
    "You are a helpful research assistant. Provide concise, precise explanations, " +
    "use structured reasoning, and cite key assumptions when relevant.";

module.exports = async function handler(context, req) {
    try {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            context.res = {
                status: 500,
                body: "Missing OPENAI_API_KEY on the server.",
            };
            return;
        }

        const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
        const messages = Array.isArray(payload.messages) ? payload.messages : [];
        const hiddenContext = typeof payload.hiddenContext === "string" ? payload.hiddenContext : "";

        const systemMessages = [{ role: "system", content: SYSTEM_PROMPT }];
        if (hiddenContext.trim()) {
            systemMessages.push({ role: "system", content: hiddenContext.trim() });
        }

        const response = await fetch(API_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: MODEL,
                messages: [...systemMessages, ...messages],
                temperature: 0.2,
            }),
        });

        if (!response.ok) {
            const details = await response.text();
            context.res = {
                status: response.status,
                body: details || "OpenAI request failed.",
            };
            return;
        }

        const data = await response.json();
        const reply = data.choices?.[0]?.message?.content?.trim() ?? "";
        context.res = {
            status: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reply }),
        };
    } catch (err) {
        context.res = {
            status: 500,
            body: err?.message || "Unexpected server error.",
        };
    }
};
