const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const { history, userInput, isCorrection, correctThing } = req.body;
    const model = genAI.getGenerativeModel({ model_name: "gemini-1.5-flash" });

    let systemInstruction = `
        You are an advanced Akinator. You can guess characters, objects, or concepts.
        Rules:
        1. Ask YES/NO questions only.
        2. Respond ONLY in JSON: {"question": "string", "isGuess": boolean, "finalAnswer": "string"}.
        3. If isGuess is true, 'finalAnswer' is your guess.
        4. If you lose, I will tell you the correct answer. Use that to improve your logic next time.
    `;

    // If the user is teaching the bot after a wrong guess
    if (isCorrection) {
        const learningPrompt = `I was thinking of "${correctThing}". Review these questions we just played: ${JSON.stringify(history)}. Briefly acknowledge and reset.`;
        const result = await model.generateContent([systemInstruction, learningPrompt]);
        return res.json({ reset: true, message: "I've learned from that! Let's play again." });
    }

    const chat = model.start_chat({
        history: history.map(h => ({ role: h.role, parts: [{ text: h.text }] })),
        generationConfig: { response_mime_type: "application/json" }
    });

    try {
        const result = await chat.sendMessage(userInput || "Let's start!");
        const responseText = result.response.text();
        res.status(200).json(JSON.parse(responseText));
    } catch (error) {
        res.status(500).json({ error: "Failed to parse Gemini response" });
    }
}