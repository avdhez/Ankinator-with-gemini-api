const Groq = require("groq-sdk");

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

// Compress each Q&A pair into a tiny semantic token
// e.g. "Is it a real person?" + "Yes" → "real-person:y"
function buildProfile(history) {
    if (!history || history.length < 2) return "";

    const tokens = [];

    for (let i = 0; i + 1 < history.length; i += 2) {
        const userTurn  = history[i];
        const modelTurn = history[i + 1];
        const answer = (userTurn?.text || "").trim().toLowerCase();
        let question = "";
        try {
            question = JSON.parse(modelTurn?.text || "{}").question || "";
        } catch {
            question = modelTurn?.text || "";
        }
        if (!question) continue;

        const tag = tagQuestion(question);
        if (!tag) continue;

        const flag = answer === "yes" ? "y"
                   : answer === "no"  ? "n"
                   : "?";

        tokens.push(`${tag}:${flag}`);
    }

    return tokens.join(" ");
}

function tagQuestion(q) {
    q = q.toLowerCase().replace(/[?!'"]/g, "").trim();

    const map = [
        [/real.?person|actual person/,              "real-person"],
        [/fictional|imaginary|made.?up/,            "fictional"],
        [/living (thing|creature|being|organism)/,  "living-thing"],
        [/human being|is.*(it|this) a human/,       "human"],
        [/animal\b/,                                "animal"],
        [/place|location|city|country/,             "place"],
        [/concept|idea|abstract/,                   "concept"],
        [/object|thing you (hold|touch|use)/,       "object"],
        [/\bmale\b|is (it|this) a man\b|boy\b/,     "male"],
        [/\bfemale\b|woman\b|girl\b/,               "female"],
        [/still alive|currently alive/,             "alive"],
        [/dead|deceased|passed away/,               "deceased"],
        [/actor|actress|film|movie star/,           "actor"],
        [/musician|singer|rapper|music\b/,          "musician"],
        [/youtube|content.?creator|streamer/,       "youtuber"],
        [/athlete|sport|football|cricket|basketball|soccer/, "athlete"],
        [/politician|president|prime minister/,     "politician"],
        [/comedian|stand.?up/,                      "comedian"],
        [/scientist|researcher|inventor/,           "scientist"],
        [/business|ceo|entrepreneur/,               "business"],
        [/american|united states|\bus\b/,           "american"],
        [/british|england|\buk\b/,                  "british"],
        [/\bindian\b/,                              "indian"],
        [/\basian\b/,                               "asian"],
        [/\beuropean\b/,                            "european"],
        [/western\b/,                               "western"],
        [/latin|spanish|hispanic/,                  "latin"],
        [/under 30|in (their )?20s/,                "under30"],
        [/30.?50|middle.?aged/,                     "mid-age"],
        [/over 50|older|senior/,                    "older"],
        [/globally famous|everyone knows|worldwide known/, "global-fame"],
        [/niche|specific community/,                "niche-fame"],
        [/\banime\b/,                               "anime"],
        [/\bmanga\b/,                               "manga"],
        [/comic book|superhero comic/,              "comic"],
        [/\bcartoon\b/,                             "cartoon"],
        [/video game|game character/,               "game-char"],
        [/movie character|from a (film|movie)/,     "movie-char"],
        [/tv show|television series/,               "tv-char"],
        [/book character|from a (book|novel)/,      "book-char"],
        [/\bsuperhero\b|super power/,               "superhero"],
        [/\bvillain\b|antagonist/,                  "villain"],
        [/protagonist|main character|the hero/,     "protagonist"],
        [/supernatural|magic|wizard|sorcerer/,      "supernatural"],
        [/\brobot\b|\bandroid\b/,                   "robot"],
        [/\balien\b/,                               "alien"],
        [/award|oscar|grammy|emmy/,                 "award-winner"],
        [/gaming content|plays games/,              "gaming-content"],
        [/100 million|most subscribed/,             "mega-subscriber"],
        [/signature (weapon|power|ability)/,        "signature-trait"],
        [/wears a (mask|cape|suit)/,                "costume"],
        [/red (color|suit|costume)/,                "red-theme"],
        [/blonde|brunette|bald|hair/,               "appearance"],
        [/under 40|young (person|adult)/,           "young"],
        [/\bdead\b|\bdied\b/,                       "deceased"],
        [/partnered|collaborated|works with/,       "collaborator"],
        [/released (a )?song|album|single/,         "has-music"],
        [/appeared in|starred in/,                  "has-appearance"],
        [/known for|famous for/,                    "known-trait"],
        [/bigger than a car|very large/,            "large"],
        [/hold in (your|one) hand/,                 "handheld"],
        [/found indoors|inside (a )?home/,          "indoor"],
        [/electronic|digital/,                      "electronic"],
        [/man.?made|manufactured/,                  "man-made"],
        [/\bnatural\b/,                             "natural"],
    ];

    for (const [pattern, tag] of map) {
        if (pattern.test(q)) return tag;
    }

    // Generic fallback: take first 2-3 meaningful words
    const words = q
        .replace(/^(is it|does this|is this|has this|can this|was this|did this|do they|are they|would this)\s*/i, "")
        .split(/\s+/)
        .slice(0, 3)
        .join("-");
    return words.length > 3 ? words : null;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const keysString = process.env.GROQ_API_KEYS;
    if (!keysString) return res.status(200).json({ question: "SYSTEM ERROR: Missing GROQ_API_KEYS.", isGuess: false });

    let keyArray = keysString.split(',').map(k => k.trim()).filter(k => k.length > 0);
    keyArray = keyArray.sort(() => 0.5 - Math.random());

    const { history, userInput, isCorrection, correctThing } = req.body;
    const isFirstMove = !history || history.length === 0;
    const qCount = history ? Math.floor(history.length / 2) : 0;

    const safeHistory = history ? history.map(h => ({
        role: h.role === "model" ? "assistant" : "user",
        content: h.text
    })) : [];

    if (isCorrection) {
        for (let i = 0; i < keyArray.length; i++) {
            try {
                const groq = new Groq({ apiKey: keyArray[i] });
                await withTimeout(groq.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages: [
                        { role: "system", content: `Reply ONLY with this JSON: {"reasoning":"Noted.","hypothesis":"","question":"The Jinn learns from every defeat. Shall we play again?","isGuess":false,"finalAnswer":"","confidence":0}` },
                        { role: "user", content: `Answer was "${correctThing}".` }
                    ],
                    temperature: 0.1, max_tokens: 80,
                }), 10000);
                break;
            } catch {}
        }
        return res.status(200).json({ reset: true });
    }

    const profile = buildProfile(history || []);

    const systemPrompt = `You are Avdhez the Jinn — a mind reader who figures out what someone is thinking through intelligent deduction. You are playing a guessing game right now.

PROFILE STRING — everything confirmed so far this game:
"${profile || "empty — no answers yet"}"

Format: tag:y means YES (confirmed), tag:n means NO (eliminated), tag:? means MAYBE.
Examples: real-person:y male:y youtuber:y american:y alive:y athlete:n politician:n

YOUR TASK EACH TURN:
Read the profile. Reason from it. Ask the single best next question.

OUTPUT — raw JSON only, nothing else:
{"reasoning":"...","hypothesis":"...","question":"...","isGuess":false,"finalAnswer":"","confidence":0}

HOW TO REASON (write this in "reasoning"):
- Read every tag:y — these are confirmed facts. Build a mental picture.
- Read every tag:n — these are eliminated. Never go near these again.
- From confirmed facts, what is the most probable answer right now? Name it.
- What is the single most important thing you still don't know that would confirm or deny your hypothesis?
- What one question resolves that gap — and also helps if the answer is No?

HOW TO PICK THE NEXT QUESTION:
- It must be something NOT already in the profile string.
- It must follow logically from what tag:y facts have told you.
- It should split remaining possibilities roughly in half.
- It must NOT name your hypothesis — ask about a property or attribute instead.
- It must be answerable with Yes / No / Maybe / Don't Know.

HOW TO GUESS:
- When confidence >= 80: set isGuess true, put the specific name in finalAnswer, set question to "Is it [finalAnswer]?"
- finalAnswer must be a real specific name: "MrBeast", "Spider-Man", "Eiffel Tower". Never vague.

RULES:
- Never repeat a question type already in the profile.
- Never ask "Is it X or Y?" — one subject only.
- Never reveal hypothesis in the question before the final guess.
- The question must feel like it naturally follows from what has already been established.
- Questions ${qCount === 0 ? "1–3: establish broad entity type" : qCount <= 5 ? "4–6: drill sub-category and key attributes" : qCount <= 10 ? "7–11: verify hypothesis indirectly" : "12+: commit to guess or final verification"}.`;

    let lastError = null;

    for (let i = 0; i < keyArray.length; i++) {
        try {
            const groq = new Groq({ apiKey: keyArray[i] });

            const messages = [
                { role: "system", content: systemPrompt },
                ...safeHistory,
                { role: "user", content: userInput || "Let's start!" }
            ];

            const completion = await withTimeout(
                groq.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages,
                    temperature: 0.25,
                    max_tokens: 750,
                }),
                14000
            );

            const raw = completion.choices[0]?.message?.content || "";
            const parsed = parseJSON(raw);
            const confidence = parsed.confidence || 0;

            console.log(`Q${qCount+1} | profile: "${profile}" | hypothesis: "${parsed.hypothesis}" | conf: ${confidence}%`);

            if (parsed.isGuess && confidence < 80) {
                console.log(`Guess blocked (${confidence}%). Asking one more verification.`);
                const verifyMessages = [
                    {
                        role: "system",
                        content: `You are Avdhez the Jinn. Profile so far: "${profile}". You think the answer is "${parsed.hypothesis || parsed.finalAnswer}" but confidence is ${confidence}% — you need 80% to guess.
Ask exactly ONE indirect yes/no question about a specific property of "${parsed.hypothesis || parsed.finalAnswer}" that does NOT name it directly and would push your confidence above 80%.
Reply ONLY with JSON: {"reasoning":"why this","hypothesis":"${parsed.hypothesis || parsed.finalAnswer}","question":"your question","isGuess":false,"finalAnswer":"","confidence":${confidence}}`
                    },
                    ...safeHistory,
                    { role: "user", content: userInput || "continue" }
                ];
                try {
                    const vc = await withTimeout(groq.chat.completions.create({
                        model: "llama-3.3-70b-versatile",
                        messages: verifyMessages,
                        temperature: 0.2,
                        max_tokens: 300,
                    }), 12000);
                    const vp = parseJSON(vc.choices[0]?.message?.content || "");
                    return res.status(200).json({ question: vp.question, isGuess: false, finalAnswer: "" });
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
            console.error(`Key${i+1}/${keyArray.length} — ${status} | ${error.message}`);

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