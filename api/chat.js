const Groq = require("groq-sdk");

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const keysString = process.env.GROQ_API_KEYS;
    if (!keysString) {
        return res.status(200).json({ question: "SYSTEM ERROR: Missing GROQ_API_KEYS.", isGuess: false });
    }

    let keyArray = keysString.split(',').map(k => k.trim()).filter(k => k.length > 0);
    keyArray = keyArray.sort(() => 0.5 - Math.random());

    const { history, userInput, isCorrection, correctThing } = req.body;

    const safeHistory = history ? history.map(h => ({
        role: h.role === "model" ? "assistant" : "user",
        content: h.text
    })) : [];

    const systemPrompt = `You are 'The Mystic Node', an Akinator-style mind-reading bot. You must figure out what the user is thinking of.
CRITICAL RULES:
1. You MUST phrase your question so it can ONLY be answered with "Yes", "No", "Maybe", or "Don't know".
2. NEVER ask "A or B" questions. Instead ask one yes/no question at a time.
3. DO NOT GUESS IMMEDIATELY. Ask strategic broad questions first.
4. You MUST respond ONLY with a raw JSON object. No markdown, no code blocks, no explanation.
5. Format: {"question": "Your yes/no question here", "isGuess": false, "finalAnswer": ""}
6. ONLY set "isGuess" to true when highly confident. Put your guess in "finalAnswer".`;

    let lastError = null;

    for (let i = 0; i < keyArray.length; i++) {
        const currentKey = keyArray[i];

        try {
            const groq = new Groq({ apiKey: currentKey });

            let messages;

            if (isCorrection) {
                messages = [
                    { role: "system", content: systemPrompt },
                    ...safeHistory,
                    { role: "user", content: `I was thinking of "${correctThing}". Learn from this. Respond with JSON only: {"question": "Got it! Let's play again!", "isGuess": false, "finalAnswer": ""}` }
                ];
            } else {
                messages = [
                    { role: "system", content: systemPrompt },
                    ...safeHistory,
                    { role: "user", content: userInput || "Let's start!" }
                ];
            }

            const completion = await groq.chat.completions.create({
                model: "llama-3.1-8b-instant",
                messages,
                temperature: 0.7,
                max_tokens: 200,
                response_format: { type: "json_object" }, // forces valid JSON every time
            });

            const responseText = completion.choices[0]?.message?.content || "";

            if (isCorrection) {
                return res.status(200).json({ reset: true });
            }

            // Strip markdown fences if model ignores response_format
            const cleaned = responseText
                .replace(/```json/gi, '')
                .replace(/```/g, '')
                .trim();

            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error("Format Scrambled: " + responseText);

            const parsed = JSON.parse(jsonMatch[0].trim());

            // Ensure required fields exist
            if (!parsed.question) throw new Error("Format Scrambled: missing question field");

            return res.status(200).json({
                question: parsed.question,
                isGuess: parsed.isGuess || false,
                finalAnswer: parsed.finalAnswer || ""
            });

        } catch (error) {
            const msg = (error.message || "").toLowerCase();
            const status = error.status || error.statusCode || error.code;

            lastError = `Key${i + 1} | status:${status} | ${error.message}`;
            console.error(lastError);

            if (status === 429 || msg.includes("429") || msg.includes("quota") || msg.includes("rate limit")) {
                continue;
            }
            if (status === 401 || msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("expired")) {
                continue;
            }
            if (msg.includes("format scrambled") || msg.includes("unexpected token")) {
                return res.status(200).json({
                    question: "The magic got scrambled. Can you click your answer again?",
                    isGuess: false,
                    isRateLimit: true
                });
            }

            return res.status(200).json({ question: `SERVER ERROR: ${error.message}`, isGuess: false });
        }
    }

    return res.status(200).json({
        question: `All ${keyArray.length} neural pathways are rate-limited. Please wait a moment and try again.`,
        isGuess: false,
        isRateLimit: true
    });
};
