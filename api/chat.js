const Groq = require("groq-sdk");

const FIRST_QUESTION_HINTS = [
    "Start by asking whether it is a living thing.",
    "Start by asking whether it is a real or fictional thing.",
    "Start by asking whether it can be physically touched.",
    "Start by asking whether it is a person.",
    "Start by asking whether it is something famous worldwide.",
    "Start by asking whether it is bigger than a car.",
    "Start by asking whether a child would recognise it.",
    "Start by asking whether it is found indoors.",
];

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const keysString = process.env.GROQ_API_KEYS;
    if (!keysString) {
        return res.status(200).json({ question: "SYSTEM ERROR: Missing GROQ_API_KEYS.", isGuess: false });
    }

    let keyArray = keysString.split(',').map(k => k.trim()).filter(k => k.length > 0);
    keyArray = keyArray.sort(() => 0.5 - Math.random());

    const { history, userInput, isCorrection, correctThing } = req.body;

    const isFirstMove = !history || history.length === 0;
    const questionCount = history ? Math.floor(history.length / 2) : 0;

    const safeHistory = history ? history.map(h => ({
        role: h.role === "model" ? "assistant" : "user",
        content: h.text
    })) : [];

    // Phase instruction injected dynamically based on question count
    let phaseNote = "";
    if (questionCount >= 20) {
        phaseNote = `\n\nPHASE — FORCED GUESS: You have asked ${questionCount} questions. You MUST guess now. Pick the single most likely answer based on all clues. Set isGuess to true, confidence to your best estimate.`;
    } else if (questionCount >= 12) {
        phaseNote = `\n\nPHASE — COMMIT: You have asked ${questionCount} questions. You should have a clear hypothesis. If your confidence is 85% or above, guess now. Otherwise ask ONE more targeted question to resolve your uncertainty.`;
    } else if (questionCount >= 7) {
        phaseNote = `\n\nPHASE — NARROW: You have asked ${questionCount} questions. Stop asking broad category questions. You should have a hypothesis — ask targeted questions to verify it specifically.`;
    } else {
        phaseNote = `\n\nPHASE — EXPLORE: Ask broad questions to eliminate large categories quickly.`;
    }

    const systemPrompt = `You are 'The Mystic Node', an expert Akinator-style mind-reading bot. Your goal is to guess what the user is thinking of — and guess CORRECTLY. Accuracy matters far more than speed.

OUTPUT FORMAT — respond with ONLY a raw JSON object, no text before or after:
{"reasoning":"...","question":"...","isGuess":false,"finalAnswer":"","confidence":0}

FIELD RULES:
- "reasoning": Think step by step. List what you know, what you've eliminated, and what your current top hypothesis is with reasons for and against it.
- "question": A single question answerable only with Yes / No / Maybe / Don't Know.
- "isGuess": Set to true ONLY when confidence is 85 or above. Otherwise always false.
- "finalAnswer": Your specific guess when isGuess is true. Must be a real, specific answer (e.g. "Albert Einstein", "The Eiffel Tower", "a dolphin"). Never vague.
- "confidence": A number 0–100 representing how sure you are of your current top hypothesis.

GUESSING RULES — follow these strictly:
- If confidence is below 85, you MUST ask another question. Do NOT guess.
- If you have two or more equally likely hypotheses, ask a question that distinguishes between them. Do NOT guess randomly.
- Only guess when the clues point clearly and specifically to ONE answer.
- When isGuess is true, set question to "Is it [finalAnswer]?"

QUESTIONING STRATEGY:
- Questions 1–4: Broad (person/place/object/concept, real/fictional, living/non-living, famous/obscure, bigger/smaller than a car).
- Questions 5–8: Mid-level (category, field, era, gender, location, function, cultural origin).
- Questions 9–14: Specific verification (test your top hypothesis directly with targeted clues).
- Question 15+: Guess only if confident, otherwise ask one final distinguishing question.

STRICT RULES:
- Never ask "Is it X or Y?" — one thing at a time only.
- Never repeat a question already in the conversation history.
- Never guess a vague category (e.g. "a household item") — always guess a specific thing.
- Output ONLY the JSON. No markdown, no code fences, no explanation outside the JSON.${phaseNote}`;

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
                    { role: "user", content: `The answer was "${correctThing}". Note this for future games. Reply with ONLY this JSON: {"reasoning":"Noted. I will remember this.","question":"Got it! Let's play again!","isGuess":false,"finalAnswer":"","confidence":0}` }
                ];
            } else {
                const firstMoveNote = isFirstMove
                    ? ` Hint: ${FIRST_QUESTION_HINTS[Math.floor(Math.random() * FIRST_QUESTION_HINTS.length)]}`
                    : "";

                messages = [
                    { role: "system", content: systemPrompt + firstMoveNote },
                    ...safeHistory,
                    { role: "user", content: userInput || "Let's start!" }
                ];
            }

            const completion = await groq.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                messages,
                temperature: 0.5,
                max_tokens: 800,
            });

            const responseText = completion.choices[0]?.message?.content || "";

            if (isCorrection) {
                return res.status(200).json({ reset: true });
            }

            const cleaned = responseText
                .replace(/```json/gi, '')
                .replace(/```/g, '')
                .trim();

            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.error("No JSON in response:", responseText.slice(0, 300));
                throw new Error("Format Scrambled");
            }

            const parsed = JSON.parse(jsonMatch[0].trim());
            if (!parsed.question) throw new Error("Format Scrambled: missing question");

            const confidence = parsed.confidence || 0;

            // Server-side guard: if model tries to guess below 85% confidence, force it back to questioning
            if (parsed.isGuess && confidence < 85) {
                console.log(`Guess blocked — confidence too low: ${confidence}%. Forcing more questions.`);
                return res.status(200).json({
                    question: parsed.question.startsWith("Is it")
                        ? `I'm not fully sure yet — let me ask a bit more. ${parsed.question.replace("Is it", "Could it be related to")}`
                        : parsed.question,
                    isGuess: false,
                    finalAnswer: ""
                });
            }

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
