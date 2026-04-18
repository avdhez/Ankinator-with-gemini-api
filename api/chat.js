module.exports = async function handler(req, res) {
    // 1. Block anything that isn't a POST request
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    // 2. Check for the Hugging Face API Key
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

        // 3. Iron-Clad System Instructions for Llama 3
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

        // 4. Map frontend history to Hugging Face's format (user -> assistant)
        safeHistory.forEach(h => {
            messages.push({
                role: h.role === 'model' ? 'assistant' : 'user',
                content: h.text
            });
        });

        // 5. Handle Correction Mode vs Normal Gameplay
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

        // 6. Make the API Call to Hugging Face Serverless Inference
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
                max_tokens: 500 // 500 tokens ensures the JSON never gets cut off mid-sentence
            })
        });

        const data = await response.json();

        // 7. Handle Hugging Face Specific Server Errors
        if (!response.ok) {
            // 503 means the model is "sleeping" and needs 20 seconds to boot up into the GPU
            if (response.status === 503) {
                 return res.status(200).json({ 
                    question: "My neural pathways are waking up! Give me about 20 seconds and click your answer again.", 
                    isGuess: false, 
                    isRateLimit: true 
                });
            }
            // 429 means the free community server is temporarily full
            if (response.status === 429) {
                 return res.status(200).json({ 
                    question: "The servers are currently busy. Wait a moment and click again.", 
                    isGuess: false, 
                    isRateLimit: true 
                });
            }
            throw new Error(data.error || "Unknown Hugging Face Error");
        }

        // If it was just learning a correction, tell the frontend to reset
        if (isCorrection) {
            return res.status(200).json({ reset: true });
        }

        // 8. Extract the AI's raw text safely
        let responseText = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : null;
        
        if (!responseText) {
            return res.status(200).json({ 
                question: "My mind went blank. Can you click your answer again?", 
                isGuess: false,
                isRateLimit: true 
            });
        }

        // 9. THE BULLETPROOF JSON EXTRACTOR
        // Strip out markdown code blocks if Llama added them
        let cleanText = responseText.replace(/```json/gi, '').replace(/```/g, '').trim();
        
        // Physically carve out ONLY the JSON object by finding the first { and last }
        const startIdx = cleanText.indexOf('{');
        const endIdx = cleanText.lastIndexOf('}');
        
        if (startIdx === -1 || endIdx === -1) {
            console.error("AI returned text with no brackets:", responseText);
            throw new Error("Format Scrambled");
        }
        
        cleanText = cleanText.substring(startIdx, endIdx + 1);
        
        // 10. Parse the clean JSON and send it back to the game!
        res.status(200).json(JSON.parse(cleanText));

    } catch (error) {
        console.error("API Crash Details:", error);
        
        // If the JSON parsing still fails, gracefully ask the user to click again instead of crashing
        if (error.message.includes("Unexpected token") || error.message.includes("valid JSON") || error.message.includes("Format Scrambled")) {
            return res.status(200).json({ 
                question: "The magic got scrambled. Can you click your answer again?", 
                isGuess: false,
                isRateLimit: true
            });
        }
        
        // For all other errors, show it on the screen so you can debug
        res.status(200).json({ question: `SERVER ERROR: ${error.message}`, isGuess: false });
    }
};