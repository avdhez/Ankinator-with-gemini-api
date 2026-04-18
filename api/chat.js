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

        // 1. IRON-CLAD SYSTEM INSTRUCTIONS
        const messages = [
            {
                role: "system",
                content: `You are 'The Mystic Node', an Akinator-style mind-reading bot. You must figure out what the user is thinking of.
                CRITICAL RULES:
                1. You MUST phrase your question so it can ONLY be answered with "Yes", "No", "Maybe", or "Don't know".
                2. NEVER ask "A or B" questions. (e.g., NEVER ask "Is it real or fictional?". Instead ask "Is it a real person?").
                3. DO NOT GUESS IMMEDIATELY. Ask strategic, broad questions first to gather clues.
                4. Respond ONLY in strict JSON format: {"question": "Your exact yes/no question", "isGuess": false, "finalAnswer": ""}
                5. ONLY set "isGuess" to true if you are highly confident based on clues. If true, put your guess in "finalAnswer".
                6. Absolutely NO conversational filler. ONLY output the JSON object.`
            }
        ];

        safeHistory.forEach(h => {
            messages.push({
                role: h.role === 'model' ? 'assistant' : 'user',
                content: h.text
            });
        });

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
                temperature: 0.3 // Lowered temperature forces strict logic over creativity
            })
        });

        const data = await response.json();

        if (!response.ok) {
            if (response.status === 429) {
                 return res.status(200).json({ 
                    question: "The free servers are packed! Wait 5 seconds and click your answer again.", 
                    isGuess: false, 
                    isRateLimit: true 
                });
            }
            throw new Error(data.error?.message || "Unknown OpenRouter Error");
        }

        if (isCorrection) {
            return res.status(200).json({ reset: true });
        }

        let responseText = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
        
        if (!responseText) {
            return res.status(200).json({ 
                question: "My mind went blank. Can you click your answer again?", 
                isGuess: false,
                isRateLimit: true 
            });
        }

        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
             throw new Error("AI did not return valid JSON. It said: " + responseText);
        }
        
        const cleanJSON = jsonMatch[0].trim();
        res.status(200).json(JSON.parse(cleanJSON));

    } catch (error) {
        console.error("API Crash Details:", error);
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