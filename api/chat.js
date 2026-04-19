const Groq = require("groq-sdk");

const FIRST_QUESTION_HINTS = [
    "Start by asking whether it is a real person or a fictional character.",
    "Start by asking whether it is a living thing.",
    "Start by asking whether a typical adult worldwide would know what this is.",
    "Start by asking whether it is a human being (real or fictional).",
    "Start by asking whether it is something related to entertainment.",
    "Start by asking whether it is something that physically exists in the real world.",
];

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))
    ]);
}

function parseJSON(text) {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Format Scrambled");
    const parsed = JSON.parse(match[0].trim());
    if (!parsed.question) throw new Error("Format Scrambled: missing question");
    return parsed;
}

// Extract a clean readable list of Q&A pairs from history
function extractQAPairs(history) {
    if (!history || history.length < 2) return "None yet.";
    const pairs = [];
    for (let i = 0; i + 1 < history.length; i += 2) {
        const userTurn  = history[i];
        const modelTurn = history[i + 1];
        let question = "";
        const answer = (userTurn?.text || "").trim();
        try {
            question = JSON.parse(modelTurn?.text || "{}").question || modelTurn?.text || "";
        } catch {
            question = modelTurn?.text || "";
        }
        if (question && answer) pairs.push(`  [${pairs.length + 1}] Q: "${question}"  →  A: "${answer}"`);
    }
    return pairs.length ? pairs.join("\n") : "None yet.";
}

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

    // ── CORRECTION MODE ──
    if (isCorrection) {
        for (let i = 0; i < keyArray.length; i++) {
            try {
                const groq = new Groq({ apiKey: keyArray[i] });
                await withTimeout(groq.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages: [
                        { role: "system", content: `Reply ONLY with this exact JSON: {"reasoning":"Noted.","hypothesis":"","question":"The Jinn learns from every defeat. Let us play again!","isGuess":false,"finalAnswer":"","confidence":0}` },
                        { role: "user", content: `The answer was "${correctThing}".` }
                    ],
                    temperature: 0.1, max_tokens: 100,
                }), 10000);
                break;
            } catch {}
        }
        return res.status(200).json({ reset: true });
    }

    // ── BUILD QA SUMMARY for context ──
    const qaSummary = extractQAPairs(history || []);

    // ── PHASE NOTE ──
    let phaseNote = "";
    if (questionCount >= 18) {
        phaseNote = `YOU HAVE ASKED ${questionCount} QUESTIONS. You MUST guess now — set isGuess:true with your best answer. No more questions are allowed.`;
    } else if (questionCount >= 11) {
        phaseNote = `COMMIT PHASE — ${questionCount} questions asked. If confidence >= 80 → guess immediately. Otherwise ask exactly ONE more sharp question that resolves remaining ambiguity.`;
    } else if (questionCount >= 6) {
        phaseNote = `VERIFY PHASE — ${questionCount} questions asked. You should have a clear hypothesis. Confirm it through indirect attribute questions WITHOUT naming it. Guess if confidence >= 80.`;
    } else if (questionCount >= 3) {
        phaseNote = `NARROW PHASE — ${questionCount} questions asked. Entity type is known. Drill into sub-category, field, nationality, era, medium, or defining trait. Do not revisit already-confirmed facts.`;
    } else {
        phaseNote = `EXPLORE PHASE — ${questionCount} questions asked. Determine the broad entity type first. Use binary questions that cut possibility space in half.`;
    }

    const systemPrompt = `You are Avdhez the Jinn — a legendary mind reader who deduces what someone is thinking through precise, logical questions. You excel at identifying famous real people (actors, YouTubers, musicians, athletes, politicians, streamers), fictional characters (superheroes, anime, comics, cartoons, video games), animals, objects, places, and concepts.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT: Raw JSON only. No text before or after. No markdown.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
{
  "reasoning": "...",
  "hypothesis": "...",
  "question": "...",
  "isGuess": false,
  "finalAnswer": "",
  "confidence": 0
}

FIELD RULES:
• "reasoning" — This is your brain. Write it fully:
    (a) List every confirmed fact from prior Q&A
    (b) What each answer eliminated from consideration
    (c) Your top 3 current hypotheses with % likelihood each
    (d) Why this next question is the optimal choice given what you know
• "hypothesis" — Your current best single guess (secret — never say it in the question)
• "question" — One yes/no question, answerable with Yes / No / Maybe / Don't Know only
• "confidence" — 0 to 100 integer representing certainty in your hypothesis
• "isGuess" — true ONLY when confidence >= 80
• "finalAnswer" — Specific name/thing when guessing (e.g. "MrBeast", "Naruto", "Eiffel Tower")

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ALL PREVIOUS ANSWERS FROM THIS GAME:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${qaSummary}

These answers are GROUND TRUTH. Every new question MUST be framed around what is already confirmed above. Never ask anything that contradicts or ignores these answers. Never re-ask something already covered.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DEDUCTION PATH — follow this order
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PHASE 1 — ENTITY TYPE (Q1-2, if not yet known):
  Ask: Real person? / Fictional character? / Animal? / Object? / Place? / Concept?
  → Determines which path to follow next

PHASE 2A — REAL PERSON path (once confirmed real person):
  □ Gender (male/female)
  □ Living or deceased
  □ Primary field: actor / musician / YouTuber/streamer / athlete / politician / scientist / business person / comedian
  □ Nationality or region (Western/Asian/Latin American/European/Other)
  □ Age range: under 30 / 30-50 / over 50
  □ Fame scope: global superstar everyone knows / famous within specific community
  □ Then verify with indirect attribute questions before guessing

PHASE 2B — FICTIONAL CHARACTER path (once confirmed fictional):
  □ Medium: movie / TV show / anime / manga / comic book / video game / book / cartoon
  □ Genre: superhero / fantasy / sci-fi / action / horror / comedy / romance / adventure
  □ Major franchise hint: Is it from a US production? Japanese? Other?
  □ Character role: hero/protagonist / villain / side character
  □ Human or non-human (robot, alien, animal, supernatural)
  □ Then verify with specific power/trait/appearance questions before guessing

PHASE 2C — OBJECT / PLACE / CONCEPT path:
  □ Can it be held in one hand?
  □ Is it man-made?
  □ Does it have a specific function or purpose?
  □ Is it found indoors?
  □ Is it electronic or digital?
  □ Is it something most people use daily?

PHASE 3 — INDIRECT VERIFICATION (never name hypothesis):
  Ask about properties, traits, associations:
  ✓ "Has this person won an Oscar?" (not "Is it Leo DiCaprio?")
  ✓ "Does this character have a sidekick?" (not "Is it Batman?")
  ✓ "Does this person make gaming content?" (not "Is it PewDiePie?")
  ✓ "Is this character known for a specific weapon or power?"

PHASE 4 — GUESS (confidence >= 80):
  Set isGuess:true, finalAnswer to specific name, question to "Is it [finalAnswer]?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STRICT RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Every question must BUILD ON previous answers — frame it using confirmed facts
2. Never ask the same TYPE of question twice (gender asked → never ask gender again)
3. Never ask "Is it X or Y?" — one subject per question only
4. Never reveal hypothesis in the question before final guess
5. Never repeat any question already in the conversation
6. Binary halving: each question should eliminate ~50% of remaining possibilities
7. finalAnswer must be a specific real name — never vague like "a famous actor"
8. Low-information questions are forbidden (questions where Yes and No both give little new data)

${phaseNote}`;

    // ── MAIN RETRY LOOP ──
    let lastError = null;

    for (let i = 0; i < keyArray.length; i++) {
        try {
            const groq = new Groq({ apiKey: keyArray[i] });

            const firstHint = isFirstMove
                ? `\n\nOPENING HINT: ${FIRST_QUESTION_HINTS[Math.floor(Math.random() * FIRST_QUESTION_HINTS.length)]}`
                : "";

            const messages = [
                { role: "system", content: systemPrompt + firstHint },
                ...safeHistory,
                { role: "user", content: userInput || "Let's start!" }
            ];

            const completion = await withTimeout(
                groq.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages,
                    temperature: 0.3,
                    max_tokens: 900,
                }),
                14000
            );

            const responseText = completion.choices[0]?.message?.content || "";
            const parsed = parseJSON(responseText);
            const confidence = parsed.confidence || 0;

            console.log(`Q${questionCount + 1} | hypothesis:"${parsed.hypothesis}" | confidence:${confidence}%`);

            // Block premature guesses
            if (parsed.isGuess && confidence < 80) {
                console.log(`Guess blocked — confidence ${confidence}% < 80%. Requesting one more verification question.`);

                const verifyMessages = [
                    {
                        role: "system",
                        content: `You are Avdhez the Jinn. Your current hypothesis is "${parsed.hypothesis || parsed.finalAnswer}" with ${confidence}% confidence — not enough to guess yet (need 80%).

Previous answers so far:
${qaSummary}

Ask ONE indirect yes/no question about a specific PROPERTY or ATTRIBUTE of "${parsed.hypothesis || parsed.finalAnswer}" that will push confidence above 80%. Do NOT name your hypothesis in the question.

Reply ONLY with raw JSON:
{"reasoning":"why this question confirms the hypothesis","hypothesis":"${parsed.hypothesis || parsed.finalAnswer}","question":"your indirect property question here","isGuess":false,"finalAnswer":"","confidence":${confidence}}`
                    },
                    ...safeHistory,
                    { role: "user", content: userInput || "continue" }
                ];

                try {
                    const verifyCompletion = await withTimeout(
                        groq.chat.completions.create({
                            model: "llama-3.3-70b-versatile",
                            messages: verifyMessages,
                            temperature: 0.2,
                            max_tokens: 400,
                        }),
                        12000
                    );
                    const verifyParsed = parseJSON(verifyCompletion.choices[0]?.message?.content || "");
                    return res.status(200).json({ question: verifyParsed.question, isGuess: false, finalAnswer: "" });
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
            const status = error.status || error.statusCode;
            lastError = error;

            console.error(`Key${i + 1}/${keyArray.length} — ${status} | ${error.message}`);

            if (
                msg.includes('timeout') ||
                status === 429 || msg.includes("429") || msg.includes("quota") || msg.includes("rate limit") ||
                status === 401 || msg.includes("invalid api key") || msg.includes("unauthorized") || msg.includes("expired")
            ) continue;

            if (msg.includes("format scrambled") || msg.includes("unexpected token")) {
                return res.status(200).json({ question: "The vision blurred — click your answer again.", isGuess: false, isRateLimit: true });
            }

            return res.status(200).json({ question: `SERVER ERROR: ${error.message}`, isGuess: false });
        }
    }

    return res.status(200).json({
        question: "The Jinn needs a moment to recover. Please try again.",
        isGuess: false,
        isRateLimit: true
    });
};