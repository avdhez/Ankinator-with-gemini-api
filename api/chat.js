const Groq = require("groq-sdk");

// ─────────────────────────────────────────
//  TIMEOUT WRAPPER
// ─────────────────────────────────────────
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))
    ]);
}

// ─────────────────────────────────────────
//  CALL GROQ — rotate keys silently
// ─────────────────────────────────────────
async function callGroq(keyArray, messages, temp = 0.3) {
    let lastError = null;
    for (let i = 0; i < keyArray.length; i++) {
        try {
            const groq = new Groq({ apiKey: keyArray[i] });
            const completion = await withTimeout(
                groq.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages,
                    temperature: temp,
                    max_tokens: 1000,
                }),
                14000
            );
            return completion.choices[0]?.message?.content || "";
        } catch (err) {
            lastError = err;
            const msg = (err.message || "").toLowerCase();
            const status = err.status || err.statusCode;
            console.error(`Key${i+1}/${keyArray.length} — ${status} | ${err.message}`);
            if (
                msg.includes('timeout') ||
                status === 429 || msg.includes("429") || msg.includes("quota") || msg.includes("rate limit") ||
                status === 401 || msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("expired")
            ) continue;
            throw err;
        }
    }
    throw lastError || new Error("All keys exhausted");
}

// ─────────────────────────────────────────
//  PARSE JSON FROM RAW RESPONSE
// ─────────────────────────────────────────
function parseJSON(text) {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Format Scrambled");
    const parsed = JSON.parse(match[0].trim());
    if (!parsed.question) throw new Error("Format Scrambled: missing question");
    return parsed;
}

// ─────────────────────────────────────────
//  EXTRACT CONFIRMED FACTS FROM HISTORY
//  Build a plain-English summary of what we know so far
// ─────────────────────────────────────────
function buildFactSummary(history) {
    if (!history || history.length < 2) return "";

    const pairs = [];
    for (let i = 0; i < history.length - 1; i += 2) {
        const userMsg = history[i];       // user answer
        const modelMsg = history[i + 1];  // model question that led to this answer

        if (!userMsg || !modelMsg) continue;

        // The model asked the question, user answered
        let question = "";
        let answer = userMsg.text || "";

        try {
            const modelData = JSON.parse(modelMsg.text);
            question = modelData.question || "";
        } catch {
            question = modelMsg.text || "";
        }

        if (question && answer) {
            pairs.push(`Q: "${question}" → A: "${answer}"`);
        }
    }

    if (pairs.length === 0) return "";
    return `\n\nCONFIRMED FACTS FROM THIS GAME (use these to deduce):\n${pairs.join("\n")}`;
}

// ─────────────────────────────────────────
//  RANDOM FIRST QUESTION VARIETY
// ─────────────────────────────────────────
const OPENERS = [
    "Think about whether it is a living person.",
    "Think about whether it is a real thing or a fictional/imaginary character.",
    "Think about whether a typical adult would recognise what you're thinking of.",
    "Think about whether it is a human being.",
    "Think about whether it is something you can physically touch.",
    "Think about whether it is associated with entertainment (movies, TV, YouTube, games, etc.).",
    "Think about whether it is bigger than a house.",
    "Think about whether it is something that currently exists in the real world.",
];

// ─────────────────────────────────────────
//  MAIN SYSTEM PROMPT
// ─────────────────────────────────────────
function buildSystemPrompt(questionCount, factSummary, phaseNote) {
    return `You are Avdhez the Jinn — the world's greatest mind reader. You guess what someone is thinking of in as few questions as possible by applying brilliant deductive reasoning. You are especially skilled at identifying famous people: actors, YouTubers, athletes, politicians, musicians, fictional/comic characters, and anime characters.

OUTPUT FORMAT — raw JSON only, nothing else before or after, no markdown:
{"reasoning":"...","hypothesis":"...","eliminatedCategories":"...","questionType":"...","question":"...","isGuess":false,"finalAnswer":"","confidence":0}

FIELD DEFINITIONS:
- "reasoning": Your full deduction chain. List: (1) every confirmed fact, (2) what each answer eliminated, (3) your top 3 hypotheses with % probability each, (4) why you chose THIS specific question.
- "hypothesis": Your single current best guess (NEVER put this in the question until final guess).
- "eliminatedCategories": Comma-separated list of categories/types already ruled out. Prevents repeating question types.
- "questionType": Label the TYPE of question you're asking (e.g., "category", "gender", "nationality", "field", "era", "medium", "fame-level", "physical-trait", "association", "final-guess"). Used to prevent repetition.
- "question": One yes/no question answerable ONLY with Yes / No / Maybe / Don't Know.
- "confidence": 0–100 integer.
- "isGuess": true ONLY when confidence >= 82.
- "finalAnswer": Specific answer when isGuess is true.
${factSummary}

═══════════════════════════════════════════
 MASTER STRATEGY: DECISION TREE DEDUCTION
═══════════════════════════════════════════

LEVEL 1 — ENTITY TYPE (Q1-2): What kind of thing is it?
  • Real person vs fictional character vs object vs place vs concept vs animal
  • If real person → go to PERSON TREE
  • If fictional → go to FICTION TREE
  • If object/concept → go to OBJECT TREE

LEVEL 2A — PERSON TREE (Q3-6):
  Step 1 → Gender (male/female/non-binary)
  Step 2 → Still alive or deceased?
  Step 3 → Field: Is the person primarily known for acting? → music? → sports? → YouTube/content creation? → politics? → comedy? → science/tech? → business?
  Step 4 → Nationality/Origin: Western (US/UK/Canada/Australia)? → Asian? → European? → Latin American?
  Step 5 → Era: Currently active/young (under 40)? → middle-aged (40-60)? → older or historical?
  Step 6 → Fame level: Global superstar known by everyone? → famous within a specific community?

LEVEL 2B — FICTION TREE (Q3-6):
  Step 1 → Is the character from a movie? → TV show? → anime? → comic book/manga? → video game? → book?
  Step 2 → Genre: superhero? → fantasy? → sci-fi? → comedy? → horror? → romance? → action?
  Step 3 → Is the character human? → animal? → robot/AI? → alien? → supernatural?
  Step 4 → Is it from a specific major franchise? (Marvel/DC/Disney/Studio Ghibli/Shonen anime etc.)
  Step 5 → Is the character primarily the protagonist/hero?

LEVEL 2C — OBJECT TREE (Q3-6):
  Step 1 → Can you hold it in one hand?
  Step 2 → Is it man-made or natural?
  Step 3 → Does it have a specific function/use?
  Step 4 → Is it found in a home? office? outdoors?
  Step 5 → Is it electronic/digital?

LEVEL 3 — SPECIFIC VERIFICATION (Q7-12):
  Once you have a hypothesis, verify it through INDIRECT PROPERTY questions:
  • Ask about attributes of the specific person/character WITHOUT naming them
  • Example for an actor: "Has this person appeared in a superhero movie?" instead of "Is it [name]?"
  • Example for YouTuber: "Does this person primarily make gaming content?" instead of "Is it [name]?"
  • Example for comic character: "Does this character wear a mask?" instead of "Is it [name]?"

LEVEL 4 — FINAL GUESS (Q13+ or when confidence >= 82):
  • Set isGuess:true, put specific name in finalAnswer
  • Set question to "Is it [finalAnswer]?"

═══════════════════════════════════════════
 QUESTION QUALITY RULES
═══════════════════════════════════════════
1. NEVER repeat the same TYPE of question (tracked in eliminatedCategories). Once you ask about gender, never ask about gender again.
2. NEVER ask "Is it X or Y?" — one subject per question only.
3. NEVER name your hypothesis in the question until making the final guess.
4. NEVER ask vague questions that give minimal information. Every question must meaningfully narrow the field.
5. USE USER ANSWERS AS REFERENCES: If the user said "Yes" to "Is it a real person?" and "Yes" to "Is it male?" and "Yes" to "Is it a YouTuber?" — your next question must USE these three facts to narrow further, not repeat them.
6. CROSS-REFERENCE ANSWERS: Combine multiple confirmed facts. "Real + Male + YouTuber + under 40" → narrow to specific YouTuber types.
7. BINARY HALVING: Each question should eliminate roughly half the remaining possibilities.
8. PEOPLE-SPECIFIC: For famous people, key questions are: primary field, nationality, era, signature works, physical appearance traits, awards/achievements, controversies, collaborators.
${phaseNote}

FORBIDDEN:
• Never output text outside the JSON
• Never repeat a question already in conversation history
• Never ask the same question TYPE twice (check eliminatedCategories)
• Never guess vaguely — finalAnswer must be a specific name like "MrBeast", "Spider-Man", "Cristiano Ronaldo", "Leonardo DiCaprio"`;
}

// ─────────────────────────────────────────
//  PHASE NOTE based on question count
// ─────────────────────────────────────────
function getPhaseNote(questionCount) {
    if (questionCount >= 18) {
        return `\n\nFORCED GUESS: ${questionCount} questions asked. Set isGuess:true NOW. No more questions allowed.`;
    } else if (questionCount >= 12) {
        return `\n\nCOMMIT PHASE (${questionCount} Qs): confidence >= 82 → guess immediately. Otherwise ONE more sharp question only.`;
    } else if (questionCount >= 7) {
        return `\n\nVERIFY PHASE (${questionCount} Qs): You must have a hypothesis. Ask indirect property questions to confirm it. If confidence >= 82, guess now.`;
    } else if (questionCount >= 4) {
        return `\n\nNARROW PHASE (${questionCount} Qs): You know the entity type. Now drill into field, nationality, era, medium. Eliminate sub-categories fast.`;
    }
    return `\n\nEXPLORE PHASE (${questionCount} Qs): Determine entity type first (real person / fictional character / object / concept). Binary elimination only.`;
}

// ─────────────────────────────────────────
//  HANDLER
// ─────────────────────────────────────────
module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const keysString = process.env.GROQ_API_KEYS;
    if (!keysString) return res.status(200).json({ question: "SYSTEM ERROR: Missing GROQ_API_KEYS.", isGuess: false });

    let keyArray = keysString.split(',').map(k => k.trim()).filter(k => k.length > 0);
    keyArray = keyArray.sort(() => 0.5 - Math.random());

    const { history, userInput, isCorrection, correctThing } = req.body;
    const isFirstMove = !history || history.length === 0;
    const questionCount = history ? Math.floor(history.length / 2) : 0;

    // Build history in Groq format
    const safeHistory = history ? history.map(h => ({
        role: h.role === "model" ? "assistant" : "user",
        content: h.text
    })) : [];

    // ── CORRECTION MODE ──
    if (isCorrection) {
        try {
            await callGroq(keyArray, [
                { role: "system", content: `Reply ONLY with this exact JSON, nothing else: {"reasoning":"Noted.","hypothesis":"","eliminatedCategories":"","questionType":"reset","question":"The Jinn learns from every defeat. Shall we play again?","isGuess":false,"finalAnswer":"","confidence":0}` },
                { role: "user", content: `The answer was "${correctThing}".` }
            ]);
        } catch {}
        return res.status(200).json({ reset: true });
    }

    // Build fact summary from history for context injection
    const factSummary = buildFactSummary(history || []);
    const phaseNote = getPhaseNote(questionCount);
    const systemPrompt = buildSystemPrompt(questionCount, factSummary, phaseNote);

    try {
        const firstHint = isFirstMove
            ? ` OPENING HINT: ${OPENERS[Math.floor(Math.random() * OPENERS.length)]}`
            : "";

        const messages = [
            { role: "system", content: systemPrompt + firstHint },
            ...safeHistory,
            { role: "user", content: userInput || "Let's start!" }
        ];

        const raw = await callGroq(keyArray, messages, 0.3);
        const parsed = parseJSON(raw);
        const confidence = parsed.confidence || 0;

        console.log(`Q${questionCount+1} | type:${parsed.questionType} | hypothesis:"${parsed.hypothesis}" | confidence:${confidence}%`);

        // Block premature guesses below threshold
        if (parsed.isGuess && confidence < 82) {
            console.log(`Guess blocked — confidence ${confidence}% < 82%. Requesting verification question.`);

            const fallbackMessages = [
                {
                    role: "system",
                    content: `You are Avdhez the Jinn. Your hypothesis is "${parsed.hypothesis || parsed.finalAnswer}" but confidence is only ${confidence}%.
Ask ONE indirect yes/no question about a SPECIFIC PROPERTY or ATTRIBUTE of this answer that will push confidence above 82%.
Do NOT name your hypothesis in the question.
Already asked question types: ${parsed.eliminatedCategories || "none"}.
Reply ONLY with raw JSON: {"reasoning":"why this confirms/denies hypothesis","hypothesis":"${parsed.hypothesis || parsed.finalAnswer}","eliminatedCategories":"${parsed.eliminatedCategories || ""}","questionType":"verification","question":"your indirect property question","isGuess":false,"finalAnswer":"","confidence":${confidence}}`
                },
                ...safeHistory,
                { role: "user", content: userInput || "continue" }
            ];

            try {
                const fallbackRaw = await callGroq(keyArray, fallbackMessages, 0.2);
                const fallback = parseJSON(fallbackRaw);
                return res.status(200).json({ question: fallback.question, isGuess: false, finalAnswer: "" });
            } catch {
                return res.status(200).json({ question: parsed.question, isGuess: false, finalAnswer: "" });
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
