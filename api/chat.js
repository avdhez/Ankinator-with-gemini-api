module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
        return res.status(200).json({ 
            question: "SYSTEM ERROR: Missing OPENROUTER_API_KEY in Vercel settings.", 
            isGuess: false 
        });
    }

    try {
        const { history, userInput, isCorrection, correctThing } = req.body;
        const safeHistory = history || [];

        // 1. Enhanced System Instructions for better Akinator logic
        const messages = [
            {
                role: "system",
                content: `You are 'The Mystic Node', an Akinator-style mind-reading bot. You must figure out the character, person, object, or concept the user is thinking of.
                CRITICAL RULES:
                1. Ask ONE strategic question at a time to narrow down the possibilities. Start very broad (e.g., "Is it alive?", "Is it real or fictional?", "Is it a human?") and slowly get more specific based on the user's answers.
                2. DO NOT GUESS IMMEDIATELY. You must ask questions to gather clues first.
                3. Respond ONLY in strict JSON format: {"question": "Your next question here", "isGuess": false, "finalAnswer": ""}
                4. ONLY set "isGuess" to true if you are highly confident based on several clues. If true, put your guess in "finalAnswer".
                5. Absolutely NO conversational filler, ONLY output the JSON object.`
            }
        ];

        // 2. Map frontend history to OpenRouter's format
        safeHistory.forEach(h => {
            messages.push({
                role: h.role === 'model' ? 'assistant' : 'user',
                content: h.text
            });
        });

        // 3. Handle Correction Mode vs Normal Gameplay
        if (isCorrection) {
            messages.push({
                role: "user",
                content: `I was thinking of "${correctThing}". Review our history. Learn from your mistake. Reply with strict JSON: {"question": "Got it! I will remember that. Let's play again!", "isGuess": false, "finalAnswer": ""}`
            });
        } else {
            messages.push({
                role: "user",
                content: userInput || "Let's start!"
            });
        }

        // 4. Make the raw HTTP request to OpenRouter
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://github.com/avdhez/Ankinator-with-gemini-api",
                "X-Title": "Mystic Node Bot"
            },
            body: JSON.stringify({
                model: "openrouter/free",
                messages: messages,
                temperature: 0.7 // Prevents the AI from being too chaotic
            })
        });

        const data = await response.json();

        // Catch OpenRouter Rate Limits
        if (!response.ok) {
            if (response.status === 429) {
                 return res.status(200).json({ 
                    question: "The free servers are currently packed! Wait a few seconds and try clicking again.", 
                    isGuess: false, 
                    isRateLimit: true 
                });
            }
            throw new Error(data.error?.message || "Unknown OpenRouter Error");
        }

        if (isCorrection) {
            return res.status(200).json({ reset: true });
        }

        // 5. Extract the response safely
        let responseText = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
        
        if (!responseText) {
            return res.status(200).json({ 
                question: "My mind went blank for a second. Can you click your answer again?", 
                isGuess: false,
                isRateLimit: true 
            });
        }

        // 6. Bulletproof JSON Extraction (Finds the first { and last })
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
             throw new Error("AI did not return valid JSON. It said: " + responseText);
        }
        
        const cleanJSON = jsonMatch[0].trim();
        res.status(200).json(JSON.parse(cleanJSON));

    } catch (error) {
        console.error("API Crash Details:", error);
        
        // If it failed to parse JSON, don't crash the game, just ask the user to click again
        if (error.message.includes("Unexpected token") || error.message.includes("valid JSON")) {
            return res.status(200).json({ 
                question: "The magic got scrambled. Can you click your answer again?", 
                isGuess: false,
                isRateLimit: true
            });
        }

        res.status(200).json({ 
            question: `SERVER ERROR: ${error.message}`, 
            isGuess: false 
        });
    }
};