const { GoogleGenerativeAI } = require("@google/generative-ai");

module.exports = async function handler(req, res) {
    // 1. Check if the API key even exists
    if (!process.env.GEMINI_API_KEY) {
        console.error("CRITICAL ERROR: GEMINI_API_KEY is missing in Vercel.");
        return res.status(500).json({ 
            error: "API Key missing! Check Vercel Environment Variables.",
            question: "SYSTEM ERROR: Missing API Key.", 
            isGuess: false 
        });
    }

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model_name: "gemini-1.5-flash" });
        
        const { history, userInput, isCorrection, correctThing } = req.body;
        const safeHistory = history ? history.map(h => ({ role: h.role, parts: [{ text: h.text }] })) : [];

        let systemInstruction = `
            You are 'The Mystic Node', an all-knowing entity. 
            Respond ONLY in strict JSON format: {"question": "Your question here", "isGuess": false, "finalAnswer": ""}
            If you are 90% sure, set 'isGuess' to true, and put your guess in 'finalAnswer'.
            Do not include markdown tags.
        `;

        if (isCorrection) {
            const learningPrompt = `I was thinking of "${correctThing}". Review our history: ${JSON.stringify(safeHistory)}. Learn from this mistake. Reply with strict JSON: {"question": "Got it! I will remember that. Let's play again!"}`;
            await model.generateContent([systemInstruction, learningPrompt]);
            return res.json({ reset: true });
        }

        const chat = model.start_chat({ history: safeHistory });
        const result = await chat.sendMessage(userInput || "Let's start!");
        let responseText = result.response.text();
        
        responseText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        
        res.status(200).json(JSON.parse(responseText));

    } catch (error) {
        console.error("API Crash Details:", error);
        // Send the exact error back to the screen
        res.status(200).json({ 
            question: `SERVER ERROR: ${error.message.substring(0, 50)}...`, 
            isGuess: false 
        });
    }
};