const Groq = require("groq-sdk");

// Utility to handle API timeouts
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

    // 1. FILTER SYSTEM ERRORS (Prevents the "Clouded Mind" loop)
    const validHistory = history.filter(h => 
        !h.text.includes("My mind is clouded") && !h.text.includes("SERVER ERROR")
    );

    const qCount = Math.floor(validHistory.length / 2);

    // 2. ZERO-TOKEN STARTING STRATEGY
    // We hardcode the first 2 splits to save API usage for later.
    if (qCount === 0) {
        return res.status(200).json({ question: "Is it a living thing?", isGuess: false });
    }
    if (qCount === 1) {
        const lastAns = userInput.toLowerCase();
        if (lastAns === "yes") return res.status(200).json({ question: "Is it a real person?", isGuess: false });
        return res.status(200).json({ question: "Is it something you can hold in your hand?", isGuess: false });
    }

    // 3. MODEL TIERING (Small model for middle, Big model for the endgame)
    // qCount < 10 uses the "8b" (Cheap/High RPM), qCount >= 10 uses "70b" (Smarter)
    const targetModel = qCount < 10 ? "llama-3.1-8b-instant" : "llama-3.3-70b-versatile";

    // 4. SMART RETRY LOOP
    for (let key of keys.sort(() => Math.random() - 0.5)) {
        try {
            const groq = new Groq({ apiKey: key });
            
            const systemPrompt = `You are Avdhez the Jinn. 
            Phase: ${qCount >= 12 ? 'GUESSING' : 'NARROWING'}. 
            Output JSON: {"reasoning":"...","hypothesis":"...","question":"...","isGuess":false,"finalAnswer":"","confidence":0}
            Rules: Be precise. If confidence > 85%, set isGuess:true.`;

            const completion = await withTimeout(groq.chat.completions.create({
                model: targetModel,
                messages: [
                    { role: "system", content: systemPrompt },
                    ...validHistory.map(h => ({ role: h.role === "model" ? "assistant" : "user", content: h.text })),
                    { role: "user", content: userInput }
                ],
                temperature: 0.1, // Low temp saves logic "drift"
                response_format: { type: "json_object" }
            }), 8000);

            const result = JSON.parse(completion.choices[0].message.content);
            return res.status(200).json(result);

        } catch (err) {
            console.error("Key failed, trying next...");
            continue; // Try next key
        }
    }

    // If all else fails
    return res.status(200).json({ 
        question: "The Jinn's vision is blurred by the ether. Try your last answer again.", 
        isGuess: false 
    });
};