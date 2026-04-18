module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const apiKey = process.env.HF_API_KEY;
    if (!apiKey) {
        return res.status(200).json({ 
            question: "SYSTEM ERROR: Missing HF_API_KEY in Vercel settings.", 
            isGuess: false 
        });
    }

    try {
        const { history, userInput, isCorrection, correctThing } = req.body;
        const safeHistory = history || [];

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

        // --- NEW UNIFIED HUGGING FACE ROUTER URL ---
        const hfModelUrl = "https://api-inference.huggingface.co/models/meta-llama/Meta-Llama-3-8B-Instruct/v1/chat/completions";

        const response = await fetch(hfModelUrl, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                model: "meta-llama/Meta-Llama-3-8B-Instruct",
                messages: messages,
                temperature: 0.5,
                max_tokens: 500
            })
        });

        // --- NEW SAFE PARSING METHOD ---
        // Read the raw text FIRST so we don't crash if HF sends an HTML error page
        const rawText = await response.text();

        if (!response.ok) {
            if (response.status === 503) {
                 return res.status(200).json({ 
                    question: "My neural pathways are waking up! Give me about 20 seconds and click your answer again.", 
                    isGuess: false, 
                    isRateLimit: true 
                });
            }
            if (response.status === 429) {
                 return res.status(200).json({ 
                    question: "The servers are currently busy. Wait a moment and click again.", 
                    isGuess: false, 
                    isRateLimit: true 
                });
            }
            // If it's a 401 or 404, we will actually see the real error now!
            throw new Error(`Hugging Face Error (${response.status}): ${rawText}`);
        }

        if (isCorrection) {
            return res.status(200).json({ reset: true });
        }

        // Now that we know the response is a successful 200 OK, we parse it
        const data = JSON.parse(rawText);

        let responseText = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
        
        if (!responseText) {
            return res.status(200).json({ 
                question: "My mind went blank. Can you click your answer again?", 
                isGuess: false,
                isRateLimit: true 
            });
        }

        let cleanText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        const startIdx = cleanText.indexOf('{');
        const endIdx = cleanText.lastIndexOf('}');
        
        if (startIdx === -1 || endIdx === -1) {
            console.error("AI returned text with no brackets:", responseText);
            throw new Error("Format Scrambled");
        }
        
        cleanText = cleanText.substring(startIdx, endIdx + 1);
        res.status(200).json(JSON.parse(cleanText));

    } catch (error) {
        console.error("API Crash Details:", error);
        
        // If the error contains "Hugging Face Error", print it directly to the UI so you can see it
        if (error.message.includes("Hugging Face Error")) {
            return res.status(200).json({ 
                question: `HF CONNECTION FAILED: ${error.message.substring(0, 100)}`, 
                isGuess: false,
                isRateLimit: true
            });
        }

        if (error.message.includes("Unexpected token") || error.message.includes("valid JSON") || error.message.includes("Format Scrambled")) {
            return res.status(200).json({ 
                question: "The magic got scrambled. Can you click your answer again?", 
                isGuess: false,
                isRateLimit: true
            });
        }
        res.status(200).json({ question: `SERVER ERROR: ${error.message}`, isGuess: false });
    }
};