const { GoogleGenerativeAI } = require("@google/generative-ai");

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // 1. API KEY ROTATION: Grab the string of keys and split them
    const keysString = process.env.GEMINI_API_KEYS;
    if (!keysString) {
        return res.status(200).json({ 
            question: "SYSTEM ERROR: Missing GEMINI_API_KEYS in Vercel settings.", 
            isGuess: false 
        });
    }

    const keyArray = keysString.split(',').map(k => k.trim());
    const selectedKey = keyArray[Math.floor(Math.random() * keyArray.length)];

    try {
        const { history, userInput, isCorrection, correctThing } = req.body;
        const safeHistory = history ? history.map(h => ({ role: h.role, parts: [{ text: h.text }] })) : [];

        // 2. Initialize Gemini 2.5 with the randomly selected key
        const genAI = new GoogleGenerativeAI(selectedKey);
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            systemInstruction: `
                You are 'The Mystic Node', an Akinator-style mind-reading bot. You must figure out what the user is thinking of.
                CRITICAL RULES:
                1. You MUST phrase your question so it can ONLY be answered with "Yes", "No", "Maybe", or "Don't know".
                2. NEVER ask "A or B" questions. (e.g., NEVER ask "Is it real or fictional?". Instead ask "Is it a real person?").
                3. DO NOT GUESS IMMEDIATELY. Ask strategic, broad questions first to gather clues.
                4. Respond ONLY in strict JSON format: {"question": "Your exact yes/no question", "isGuess": false, "finalAnswer": ""}
                5. ONLY set "isGuess" to true if you are highly confident based on clues. If true, put your guess in "finalAnswer".
                6. Absolutely NO conversational filler. ONLY output the JSON object.
            `
        });

        // 3. Handle Correction Mode
        if (isCorrection) {
            const learningPrompt = `I was thinking of "${correctThing}". Review our history: ${JSON.stringify(safeHistory)}. Learn from your mistake. Reply with strict JSON: {"question": "Got it! I will remember that. Let's play again!", "isGuess": false, "finalAnswer": ""}`;
            await model.generateContent(learningPrompt);
            return res.status(200).json({ reset: true });
        }

        // 4. Start Chat and Send Message
        const chat = model.startChat({ history: safeHistory });
        const result = await chat.sendMessage(userInput || "Let's start!");
        let responseText = result.response.text();

        // 5. Bulletproof JSON Cleanup
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("AI did not return valid JSON.");
        
        const cleanJSON = jsonMatch[0].trim();
        res.status(200).json(JSON.parse(cleanJSON));

    } catch (error) {
        console.error("API Crash Details:", error);
        
        // 6. Catch Gemini Quota/Rate Limits Gracefully
        if (error.status === 429 || error.message.includes("429") || error.message.includes("quota")) {
             return res.status(200).json({ 
                question: "Re-routing neural pathways... Please click your answer again.", 
                isGuess: false, 
                isRateLimit: true 
            });
        }

        if (error.message.includes("Unexpected token") || error.message.includes("valid JSON")) {
            return res.status(200).json({ 
                question: "The magic got scrambled. Can you click your answer again?", 
                isGuess: false,
                isRateLimit: true
            });
        }

        res.status(200).json({ question: `SERVER ERROR: ${error.message}`, isGuess: false });
    }
};