const Groq = require("groq-sdk");

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))
    ]);
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const keys = (process.env.GROQ_API_KEYS || "").split(',').filter(k => k.trim());
    const { history = [], userInput = "" } = req.body;

    // Filter out error messages so they don't break the logic
    const validHistory = history.filter(h => !h.text.includes("mind is clouded"));
    const qCount = Math.floor(validHistory.length / 2);

    // --- PHASE 1: HARDCODED BROAD SPLITS (Saves API Tokens) ---
    if (qCount === 0) return res.status(200).json({ question: "Is it a living thing?", isGuess: false });
    if (qCount === 1) {
        const lastAns = userInput.toLowerCase();
        if (lastAns.includes("yes")) return res.status(200).json({ question: "Is it a real person?", isGuess: false });
        return res.status(200).json({ question: "Is it a physical object?", isGuess: false });
    }

    // --- PHASE 2: AI REASONING ---
    for (let key of keys.sort(() => Math.random() - 0.5)) {
        try {
            const groq = new Groq({ apiKey: key });

            // Determine Phase for the System Prompt
            let strategy = "Ask about broad categories (e.g., location, usage, material).";
            if (qCount > 5 && qCount < 12) strategy = "Narrow down the specific sub-type (e.g., if it's a tool, is it for cooking? if it's a person, are they an actor?).";
            if (qCount >= 12) strategy = "You are close. Ask very specific identifying questions.";

            const systemPrompt = `You are Avdhez the Jinn.
            
            RULES:
            1. DO NOT mention specific brands (Nintendo, Apple, Sony) or specific items (Switch, iPhone, TV) in your "question" field unless "isGuess" is true.
            2. STRATEGY: ${strategy}
            3. ALWAYS output this JSON format: {"reasoning":"...","hypothesis":"...","question":"...","isGuess":false,"finalAnswer":"","confidence":0}
            4. If confidence > 90%, set isGuess:true and name the object in finalAnswer.`;

            const completion = await withTimeout(groq.chat.completions.create({
                // We use 8b for general questions to save the 70b rate limit for the "Guess"
                model: qCount < 12 ? "llama-3.1-8b-instant" : "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: systemPrompt },
                    ...validHistory.map(h => ({ role: h.role === "model" ? "assistant" : "user", content: h.text })),
                    { role: "user", content: userInput }
                ],
                temperature: 0.1, // Forces logic over "creative" guessing
                response_format: { type: "json_object" }
            }), 9000);

            const result = JSON.parse(completion.choices[0].message.content);

            // Double-check: If the AI tried to guess in a normal question, block it.
            if (!result.isGuess && qCount < 10) {
                const containsSpecific = /(nintendo|switch|ps5|xbox|iphone|tv|laptop)/i.test(result.question);
                if (containsSpecific) {
                    result.question = "Is it primarily used for entertainment?"; // Fallback to a broad question
                }
            }

            return res.status(200).json(result);

        } catch (err) {
            continue; // Failover to next key
        }
    }

    return res.status(200).json({ question: "My mind is clouded. Could you repeat that?", isGuess: false });
};