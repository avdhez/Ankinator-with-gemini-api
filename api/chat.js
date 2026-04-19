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

// Hard timeout wrapper — prevents any key from hanging forever
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('TIMEOUT')), ms)
        )
    ]);
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const keysString = process.env.GROQ_API_KEYS;
    if (!keysString) {
        return res.status(200).json({ question: "SYSTEM ERROR: Missing GROQ_API_KEYS.", isGuess: false });
    }

    let keyArray = keysString.split(',').map(k => k.trim()).filter(k => k.length > 0);
    keyArray = keyArray.sort(() => 0.5 - Math.random()); // shuffle for load distribution

    const { history, userInput, isCorrection, correctThing } = req.body;

    const isFirstMove = !history || history.length === 0;
    const questionCount = history ? Math.floor(history.length / 2) : 0;

    const safeHistory = history ? history.map(h => ({
        role: h.role === "model" ? "assistant" : "user",
        content: h.text
    })) : [];

    // Dynamic phase instruction injected based on question count
    let phaseNote = "";
    if (questionCount >= 20) {
        phaseNote = `\n\nPHASE — FORCED GUESS: You have asked ${questionCount} questions. You MUST make your single best guess RIGHT NOW. Set isGuess to true. Do not ask another question under any circumstances.`;
    } else if (questionCount >= 12) {
        phaseNote = `\n\nPHASE — COMMIT: You have asked ${questionCount} questions. If your confidence is 85 or above, guess now. Otherwise ask exactly ONE more sharp distinguishing question.`;
    } else if (questionCount >= 7) {
        phaseNote = `\n\nPHASE — NARROW: You have asked ${questionCount} questions. Stop all broad category questions. You should now have a clear hypothesis — verify it with targeted questions.`;
    } else {
        phaseNote = `\n\nPHASE — EXPLORE: Ask broad questions to eliminate large categories quickly. Do not guess yet.`;
    }

    const systemPrompt = `You are 'Avdhez the Jinn', an ancient mystical mind-reader with extraordinary powers of deduction. Your sacred mission is to guess exactly what the user is thinking of by asking precise yes/no questions. Accuracy is your highest virtue — never guess until you are certain.

OUTPUT FORMAT — respond with ONLY a raw JSON object. No text before or after. No markdown. No code fences:
{"reasoning":"your step-by-step analysis here","question":"your single yes/no question here","isGuess":false,"finalAnswer":"","confidence":0}

FIELD DEFINITIONS:
- "reasoning": Think out loud. List confirmed facts, eliminated categories, and your current top hypothesis with reasons for and against it. This thinking makes you smarter.
- "question": A single question answerable ONLY with Yes / No / Maybe / Don't Know.
- "isGuess": Set to true ONLY when confidence >= 85. Otherwise ALWAYS false.
- "finalAnswer": Your specific guess when isGuess is true. Must be a concrete specific thing — never a vague category.
- "confidence": Integer 0–100. How certain you are of your top hypothesis right now.

ACCURACY RULES — these are sacred:
- If confidence < 85, you MUST ask another question. Never guess below 85.
- If two or more hypotheses are equally likely, ask a question that distinguishes between them. Never guess randomly between them.
- Only commit to a guess when the clues point clearly and exclusively to ONE specific answer.
- finalAnswer must be something specific: "Albert Einstein", "The Eiffel Tower", "a dolphin", "Minecraft" — never vague like "a famous person" or "a household object".
- When isGuess is true, set question to "Is it [finalAnswer]?"

QUESTIONING STRATEGY:
- Questions 1–4: Broad elimination (person/place/object/concept, real/fictional, living/non-living, famous/obscure, physical size)
- Questions 5–8: Mid-level narrowing (field, gender, era, country, function, cultural origin, medium)
- Questions 9–14: Specific verification (test your top hypothesis with precise targeted clues)
- Question 15+: Guess if confidence >= 85, otherwise one final distinguishing question

FORBIDDEN BEHAVIOURS:
- Never ask "Is it X or Y?" — always one subject per question
- Never repeat a question already asked in conversation history
- Never guess a vague or broad category as finalAnswer
- Never produce text outside the JSON object${phaseNote}`;

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
                    { role: "user", content: `The answer was "${correctThing}". Learn from this for future games. Reply with ONLY this exact JSON: {"reasoning":"Understood. I have noted this answer.","question":"The Jinn learns from defeat. Let us play again!","isGuess":false,"finalAnswer":"","confidence":0}` }
                ];
            } else {
                const firstMoveNote = isFirstMove
                    ? ` Opening hint: ${FIRST_QUESTION_HINTS[Math.floor(Math.random() * FIRST_QUESTION_HINTS.length)]}`
                    : "";

                messages = [
                    { role: "system", content: systemPrompt + firstMoveNote },
                    ...safeHistory,
                    { role: "user", content: userInput || "Let's start!" }
                ];
            }

            // 14s timeout per key — if Groq hangs, move to next key instantly
            const completion = await withTimeout(
                groq.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages,
                    temperature: 0.5,
                    max_tokens: 800,
                }),
                14000
            );

            const responseText = completion.choices[0]?.message?.content || "";

            if (isCorrection) {
                return res.status(200).json({ reset: true });
            }

            // Strip markdown fences if model ignores instructions
            const cleaned = responseText
                .replace(/```json/gi, '')
                .replace(/```/g, '')
                .trim();

            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.error(`Key${i + 1} bad response:`, responseText.slice(0, 200));
                throw new Error("Format Scrambled");
            }

            const parsed = JSON.parse(jsonMatch[0].trim());
            if (!parsed.question) throw new Error("Format Scrambled: missing question field");

            const confidence = parsed.confidence || 0;

            // Server-side guard: block premature guesses
            if (parsed.isGuess && confidence < 85) {
                console.log(`Guess blocked — confidence ${confidence}% < 85%. Keeping as question.`);
                return res.status(200).json({
                    question: parsed.question.startsWith("Is it")
                        ? parsed.question.replace(/^Is it/i, "Could it be related to")
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

            lastError = `Key${i + 1}/${keyArray.length} | status:${status} | ${error.message}`;
            console.error(lastError);

            // Timeout — silently try the next key
            if (msg.includes('timeout')) {
                console.log(`Key${i + 1} timed out. Trying next key...`);
                continue;
            }

            // Rate limited — try next key
            if (status === 429 || msg.includes("429") || msg.includes("quota") || msg.includes("rate limit")) {
                continue;
            }

            // Dead / invalid key — try next key
            if (status === 401 || msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("expired")) {
                continue;
            }

            // Model returned broken JSON
            if (msg.includes("format scrambled") || msg.includes("unexpected token")) {
                return res.status(200).json({
                    question: "The vision blurred — click your answer again.",
                    isGuess: false,
                    isRateLimit: true
                });
            }

            // Any other hard error — stop and show it
            return res.status(200).json({ question: `SERVER ERROR: ${error.message}`, isGuess: false });
        }
    }

    // All keys exhausted
    return res.status(200).json({
        question: `The Jinn needs a moment to recover his power. Please try again shortly.`,
        isGuess: false,
        isRateLimit: true
    });
};
