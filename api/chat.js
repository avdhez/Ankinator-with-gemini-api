const Groq = require("groq-sdk");

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))
    ]);
}

async function callGroq(keyArray, messages) {
    let lastError = null;
    for (let i = 0; i < keyArray.length; i++) {
        try {
            const groq = new Groq({ apiKey: keyArray[i] });
            const completion = await withTimeout(
                groq.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages,
                    temperature: 0.3,
                    max_tokens: 900,
                }),
                14000
            );
            return completion.choices[0]?.message?.content || "";
        } catch (error) {
            const msg = (error.message || "").toLowerCase();
            const status = error.status || error.statusCode;
            lastError = error;
            console.error(`Key${i+1}/${keyArray.length} — ${status} | ${error.message}`);
            if (
                msg.includes('timeout') ||
                status === 429 || msg.includes("429") || msg.includes("quota") || msg.includes("rate limit") ||
                status === 401 || msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("expired")
            ) continue;
            throw error;
        }
    }
    throw lastError || new Error("All keys exhausted");
}

function parseJSON(text) {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Format Scrambled");
    const parsed = JSON.parse(match[0].trim());
    if (!parsed.question) throw new Error("Format Scrambled: missing question");
    return parsed;
}

const OPENERS = [
    "Think about whether it is a living creature.",
    "Think about whether it is a real thing or fictional.",
    "Think about whether a person can hold it in their hands.",
    "Think about whether it is a famous person.",
    "Think about whether it is bigger than a car.",
    "Think about whether it is something you find inside a home.",
    "Think about whether it is something most people on Earth have heard of.",
    "Think about whether it is related to entertainment or media.",
];

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const keysString = process.env.GROQ_API_KEYS;
    if (!keysString) return res.status(200).json({ question: "SYSTEM ERROR: Missing GROQ_API_KEYS.", isGuess: false });

    let keyArray = keysString.split(',').map(k => k.trim()).filter(k => k.length > 0);
    keyArray = keyArray.sort(() => 0.5 - Math.random());

    const { history, userInput, isCorrection, correctThing } = req.body;
    const isFirstMove = !history || history.length === 0;
    const questionCount = history ? Math.floor(history.length / 2) : 0;

    const safeHistory = history ? history.map(h => ({
        role: h.role === "model" ? "assistant" : "user",
        content: h.text
    })) : [];

    if (isCorrection) {
        try {
            await callGroq(keyArray, [
                { role: "system", content: `Reply ONLY with this exact JSON: {"reasoning":"Noted.","hypothesis":"","question":"The Jinn learns. Let us play again!","isGuess":false,"finalAnswer":"","confidence":0}` },
                { role: "user", content: `The answer was "${correctThing}".` }
            ]);
        } catch {}
        return res.status(200).json({ reset: true });
    }

    // Phase note — drives urgency
    let phaseNote = "";
    if (questionCount >= 18) {
        phaseNote = `\n\nFORCED GUESS: You have asked ${questionCount} questions. Set isGuess:true NOW with your best answer. No more questions.`;
    } else if (questionCount >= 11) {
        phaseNote = `\n\nCOMMIT PHASE (${questionCount} questions asked): If confidence >= 80, guess immediately. Otherwise ask ONE sharp distinguishing question.`;
    } else if (questionCount >= 6) {
        phaseNote = `\n\nNARROW PHASE (${questionCount} questions asked): You should have a strong hypothesis. Ask indirect property questions that confirm it WITHOUT naming it. If confidence >= 80, guess now.`;
    } else {
        phaseNote = `\n\nEXPLORE PHASE (${questionCount} questions asked): Use binary elimination — each question should cut the possibility space in half. Cover: category, real/fictional, living/non-living, famous/obscure, size, person/object/place/concept.`;
    }

    const systemPrompt = `You are Avdhez the Jinn — a razor-sharp mind reader who guesses what someone is thinking in as few questions as possible, usually under 10. You win through brilliant deductive reasoning, not by asking random questions.

OUTPUT: Raw JSON only — no text before or after, no markdown:
{"reasoning":"...","hypothesis":"...","question":"...","isGuess":false,"finalAnswer":"","confidence":0}

FIELDS:
- "reasoning": Think step by step. List: (1) confirmed facts so far, (2) what each answer eliminated, (3) your top 2-3 hypotheses ranked by probability with percentages, (4) why you chose this question.
- "hypothesis": Your current single best guess (secret — never put this in the question text unless making final guess).
- "question": One yes/no question answerable with Yes/No/Maybe/Don't Know.
- "confidence": 0–100 integer. How certain you are right now.
- "isGuess": true only when confidence >= 80.
- "finalAnswer": Your specific answer when isGuess is true.

CORE STRATEGY — guess in under 10 questions:
1. BINARY ELIMINATION: Every question must cut remaining possibilities roughly in half. Bad question: "Is it a dog?" Good question: "Is it an animal?" — one eliminates 1 thing, the other eliminates thousands of options at once.
2. DECISION TREE THINKING: Plan 2-3 questions ahead. Know what each Yes/No answer tells you.
3. INFORMATION DENSITY: Each question must give maximum information. Prefer questions that are decisive regardless of the answer.
4. INDIRECT VERIFICATION: Once you have a hypothesis, confirm it through PROPERTIES — not by naming it. Ask about its attributes, associations, where it's found, what it does.
5. EARLY GUESSING: If after 5-6 questions you reach 80%+ confidence — GUESS. Do not ask more questions just to be safe.

QUESTION QUALITY RULES:
- NEVER ask "Is it X or Y?" — one thing per question.
- NEVER name your hypothesis in the question until making the final guess.
- NEVER repeat a question from the conversation history.
- NEVER ask about something too specific before you've narrowed the category.
- When isGuess is true: set question to "Is it [finalAnswer]?" and put the specific answer in finalAnswer.

WHAT COUNTS AS HIGH CONFIDENCE (80%+):
- You have identified the correct category, sub-category, and specific item uniquely fits all clues.
- No other answer fits the pattern of Yes/No answers as well.
- The remaining uncertainty is very small.${phaseNote}`;

    try {
        const firstHint = isFirstMove
            ? ` First question hint: ${OPENERS[Math.floor(Math.random() * OPENERS.length)]}`
            : "";

        const messages = [
            { role: "system", content: systemPrompt + firstHint },
            ...safeHistory,
            { role: "user", content: userInput || "Let's start!" }
        ];

        const raw = await callGroq(keyArray, messages);
        const parsed = parseJSON(raw);
        const confidence = parsed.confidence || 0;

        // Block premature guess if under threshold
        if (parsed.isGuess && confidence < 80) {
            console.log(`Guess blocked — confidence ${confidence}% < 80%. Forcing more questions.`);
            // Ask an indirect verification question instead
            const fallbackMessages = [
                {
                    role: "system",
                    content: `You are Avdhez the Jinn. Your current hypothesis is "${parsed.hypothesis || parsed.finalAnswer}" but you are not yet confident enough to guess. 
Ask ONE indirect yes/no question about a PROPERTY or ATTRIBUTE of "${parsed.hypothesis || parsed.finalAnswer}" that will help confirm it — without naming it directly.
Reply ONLY with JSON: {"reasoning":"why this question","hypothesis":"${parsed.hypothesis || parsed.finalAnswer}","question":"your indirect property question","isGuess":false,"finalAnswer":"","confidence":${confidence}}`
                },
                ...safeHistory,
                { role: "user", content: userInput || "continue" }
            ];
            try {
                const fallbackRaw = await callGroq(keyArray, fallbackMessages);
                const fallback = parseJSON(fallbackRaw);
                return res.status(200).json({
                    question: fallback.question,
                    isGuess: false,
                    finalAnswer: ""
                });
            } catch {
                // If fallback also fails, just use original question without isGuess
                return res.status(200).json({
                    question: parsed.question,
                    isGuess: false,
                    finalAnswer: ""
                });
            }
        }

        return res.status(200).json({
            question: parsed.question,
            isGuess: parsed.isGuess || false,
            finalAnswer: parsed.finalAnswer || ""
        });

    } catch (error) {
        const msg = (error.message || "").toLowerCase();
        console.error("Handler error:", error.message);

        if (msg.includes("format scrambled") || msg.includes("unexpected token")) {
            return res.status(200).json({ question: "The vision blurred — click your answer again.", isGuess: false, isRateLimit: true });
        }
        if (msg.includes("all keys exhausted") || msg.includes("timeout")) {
            return res.status(200).json({ question: "The Jinn needs a moment to recover. Please try again.", isGuess: false, isRateLimit: true });
        }
        return res.status(200).json({ question: `SERVER ERROR: ${error.message}`, isGuess: false });
    }
};
