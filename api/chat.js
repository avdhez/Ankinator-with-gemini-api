const Groq = require("groq-sdk");

const FIRST_QUESTION_HINTS = [
    "real-or-fictional",
    "living-thing",
    "human-being",
    "entertainment-related",
    "physically-touchable",
    "globally-famous",
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

// ─────────────────────────────────────────────────────────────
//  BUILD COMPACT PROFILE STRING FROM HISTORY
//  YES answers → confirmed traits  (most valuable)
//  NO answers  → eliminated traits (grouped compactly)
//  MAYBE/DK    → uncertain traits  (noted but not relied on)
//
//  Example output:
//  CONFIRMED: real-person, male, entertainer, western, young
//  ELIMINATED: fictional, female, athlete, politician, asian
//  UNCERTAIN: comedian
// ─────────────────────────────────────────────────────────────
function buildProfileString(history) {
    if (!history || history.length < 2) return "";

    const confirmed  = [];   // YES answers — build on these
    const eliminated = [];   // NO answers  — never revisit
    const uncertain  = [];   // MAYBE / DON'T KNOW

    // history alternates: [user-answer, model-response, user-answer, model-response, ...]
    // user answers come first (even index), model questions come from model responses
    for (let i = 0; i + 1 < history.length; i += 2) {
        const userTurn  = history[i];
        const modelTurn = history[i + 1];

        const answer = (userTurn?.text || "").trim().toLowerCase();
        let question = "";
        try {
            const mData = JSON.parse(modelTurn?.text || "{}");
            question = (mData.question || "").trim();
        } catch {
            question = (modelTurn?.text || "").trim();
        }

        if (!question) continue;

        // Extract a compact 1-4 word tag from the question
        const tag = compressQuestion(question);
        if (!tag) continue;

        if (answer === "yes") {
            confirmed.push(tag);
        } else if (answer === "no") {
            eliminated.push(tag);
        } else if (answer === "maybe" || answer.includes("don") || answer.includes("know")) {
            uncertain.push(tag);
        }
    }

    const parts = [];
    if (confirmed.length)  parts.push(`YES[${confirmed.join(",")}]`);
    if (eliminated.length) parts.push(`NO[${eliminated.join(",")}]`);
    if (uncertain.length)  parts.push(`MAYBE[${uncertain.join(",")}]`);

    return parts.join(" | ");
}

// Compress a full question into a short semantic tag
// "Is it a real person?" → "real-person"
// "Is this person male?" → "male"
// "Is it related to sports?" → "sports"
function compressQuestion(q) {
    q = q.toLowerCase().replace(/[?'"]/g, "").trim();

    const rules = [
        // Entity type
        [/real person|actual person/,           "real-person"],
        [/fictional|imaginary|made.?up/,        "fictional"],
        [/living (thing|creature|being)/,       "living-thing"],
        [/physically exist|real world/,         "physical"],
        [/human being|is (it|this) a human/,   "human"],
        [/animal/,                              "animal"],
        [/place|location|country|city/,         "place"],
        [/object|thing you (can|could) (hold|touch|use)/, "object"],
        [/concept|idea|abstract/,               "concept"],
        // Person attributes
        [/male|man|boy|he\b/,                   "male"],
        [/female|woman|girl|she\b/,             "female"],
        [/alive|living person|still alive/,     "alive"],
        [/dead|deceased|passed away/,           "deceased"],
        // Fields
        [/actor|actress|acting|film|movie/,     "actor"],
        [/musician|singer|music|band/,          "musician"],
        [/youtube|content creator|streamer/,    "youtuber"],
        [/athlete|sport|football|basketball|soccer|cricket/, "athlete"],
        [/politician|president|prime minister/, "politician"],
        [/comedian|comedy/,                     "comedian"],
        [/scientist|researcher/,                "scientist"],
        [/business|ceo|entrepreneur/,           "business"],
        [/influencer/,                          "influencer"],
        // Nationality / region
        [/american|united states|us\b/,         "american"],
        [/british|uk\b|england/,               "british"],
        [/indian\b/,                            "indian"],
        [/asian\b/,                             "asian"],
        [/european\b/,                          "european"],
        [/western\b/,                           "western"],
        [/latin|spanish|hispanic/,              "latin"],
        // Age / era
        [/under 30|young|20s/,                  "young"],
        [/30.?50|middle.?aged/,                 "middle-aged"],
        [/over 50|older|senior/,               "older"],
        [/historical|19th|18th|century/,        "historical"],
        // Fame
        [/globally famous|everyone knows|worldwide/, "global-fame"],
        [/niche|specific community|not mainstream/,  "niche-fame"],
        // Fictional medium
        [/anime\b/,                             "anime"],
        [/manga\b/,                             "manga"],
        [/comic book|dc|marvel/,               "comic"],
        [/cartoon\b/,                           "cartoon"],
        [/video game|game character/,           "video-game"],
        [/movie character|film character/,      "movie-char"],
        [/tv show|television|series/,           "tv-char"],
        [/book|novel|literature/,               "book-char"],
        // Character traits
        [/superhero|super power|powers/,        "superhero"],
        [/villain|antagonist/,                  "villain"],
        [/protagonist|main character|hero/,     "protagonist"],
        [/sidekick|supporting/,                 "sidekick"],
        [/real|physically real/,                "real"],
        [/supernatural|magic|wizard/,           "supernatural"],
        [/robot|ai character|android/,          "robot"],
        [/alien\b/,                             "alien"],
        // Physical / size
        [/bigger than a car|large|huge/,        "large"],
        [/smaller than|tiny|small/,             "small"],
        [/hold in (your|one) hand/,             "handheld"],
        [/indoors|inside (a )?home/,            "indoor"],
        [/outdoors|outside|nature/,             "outdoor"],
        [/electronic|digital/,                  "electronic"],
        [/man.?made|manufactured/,              "man-made"],
        [/natural\b/,                           "natural"],
        // Entertainment
        [/entertainment|show business/,         "entertainer"],
        [/oscar|emmy|grammy|award/,             "award-winner"],
        [/gaming|gamer|plays games/,            "gaming-content"],
        [/comedy content|funny video/,          "comedy-content"],
        [/educational/,                         "educational-content"],
    ];

    for (const [pattern, tag] of rules) {
        if (pattern.test(q)) return tag;
    }

    // Fallback: extract key noun (2-3 words max)
    const words = q.replace(/^(is it|does this|is this|has this|can this|was this|did this|do they|are they)\s*/i, "")
                   .split(/\s+/).slice(0, 3).join("-");
    return words.length > 2 ? words : "";
}

// ─────────────────────────────────────────────────────────────
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

    // ── CORRECTION MODE ──
    if (isCorrection) {
        for (let i = 0; i < keyArray.length; i++) {
            try {
                const groq = new Groq({ apiKey: keyArray[i] });
                await withTimeout(groq.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages: [
                        { role: "system", content: `Reply ONLY with this JSON: {"reasoning":"Noted.","hypothesis":"","question":"The Jinn learns from every defeat. Let us play again!","isGuess":false,"finalAnswer":"","confidence":0}` },
                        { role: "user", content: `Answer was "${correctThing}".` }
                    ],
                    temperature: 0.1, max_tokens: 80,
                }), 10000);
                break;
            } catch {}
        }
        return res.status(200).json({ reset: true });
    }

    // ── BUILD COMPACT PROFILE STRING ──
    const profile = buildProfileString(history || []);

    // ── PHASE ──
    let phase = "";
    if (qCount >= 18)      phase = `FORCE-GUESS now. ${qCount} questions used. Set isGuess:true immediately.`;
    else if (qCount >= 11) phase = `COMMIT: ${qCount}q used. confidence>=80→guess. Else one sharp question only.`;
    else if (qCount >= 6)  phase = `VERIFY: ${qCount}q used. Confirm hypothesis via indirect attributes. Guess if confidence>=80.`;
    else if (qCount >= 3)  phase = `NARROW: ${qCount}q used. Sub-category/field/region drill. Build on confirmed traits.`;
    else                   phase = `EXPLORE: ${qCount}q used. Determine entity type. Binary halving only.`;

    const systemPrompt = `You are Avdhez the Jinn — the world's greatest mind reader. You deduce what someone is thinking by asking precise questions, then guessing correctly. You specialise in: real famous people (actors, YouTubers, musicians, athletes, streamers, politicians), fictional characters (anime, superheroes, cartoons, comics, video games), animals, objects, places, and concepts.

OUTPUT: Raw JSON only — nothing before or after, no markdown:
{"reasoning":"...","hypothesis":"...","question":"...","isGuess":false,"finalAnswer":"","confidence":0}

━━━ PROFILE STRING (compact summary of ALL prior answers) ━━━
${profile || "No answers yet — first question."}

This profile is your deduction foundation. Every YES tag is a confirmed trait. Every NO tag is eliminated. MAYBE tags are uncertain. Your next question MUST logically extend from the YES tags — never re-ask anything already in the profile.

━━━ REASONING PROCESS (do this every turn) ━━━
In "reasoning" field, write:
  1. WHAT I KNOW: List every YES tag and what it means for my hypothesis
  2. WHAT'S RULED OUT: List every NO tag and what category it eliminates
  3. HYPOTHESES: Your top 2-3 specific guesses with % probability each, justified by YES tags
  4. GAP ANALYSIS: What single unknown would most help distinguish between hypotheses?
  5. CHOSEN QUESTION: Why this question gives maximum information given the gap

━━━ DECISION TREE ━━━

IF no entity type confirmed yet:
  → Ask: real person / fictional character / animal / object / place / concept?

IF real-person confirmed:
  → Unknown gender?     Ask gender
  → Unknown alive/dead? Ask alive
  → Unknown field?      Ask field (actor / musician / youtuber / athlete / politician / comedian / business)
  → Unknown region?     Ask nationality region (western / asian / latin / european)
  → Unknown age?        Ask age range (under 35 / 35-55 / over 55)
  → Unknown fame scope? Ask global-fame vs niche
  → All above known?    Verify with 1-2 indirect attribute questions, then GUESS

IF fictional confirmed:
  → Unknown medium?     Ask medium (anime / comic / movie / tv / game / cartoon / book)
  → Unknown genre?      Ask genre (superhero / fantasy / sci-fi / action / comedy)
  → Unknown origin?     Ask origin (Japanese / American / other)
  → Unknown role?       Ask protagonist / villain / side-character
  → Unknown powers?     Ask specific ability/trait
  → All above known?    Verify with 1-2 indirect questions, then GUESS

━━━ INDIRECT VERIFICATION (before guessing) ━━━
Confirm hypothesis through PROPERTIES — NEVER name it until final guess:
  ✓ "Has this person appeared in a superhero franchise?" (not "Is it Robert Downey Jr?")
  ✓ "Does this character use a weapon as their signature?" (not "Is it Naruto?")
  ✓ "Does this person have over 100 million subscribers?" (not "Is it MrBeast?")
  ✓ "Is this character primarily associated with a red color scheme?" (not "Is it Spider-Man?")

━━━ GUESSING ━━━
When confidence >= 80: set isGuess:true, finalAnswer to specific name, question to "Is it [finalAnswer]?"
finalAnswer must be specific: "MrBeast" / "Naruto" / "Eiffel Tower" — never vague.

━━━ STRICT RULES ━━━
1. Never ask a question whose tag already exists in the profile string
2. Never ask "Is it X or Y?" — one subject per question only
3. Never name hypothesis in question before final guess
4. Each question must eliminate ~50% of remaining possibilities
5. Build every question from the YES tags in the profile — they are your clues

PHASE: ${phase}`;

    let lastError = null;

    for (let i = 0; i < keyArray.length; i++) {
        try {
            const groq = new Groq({ apiKey: keyArray[i] });

            const openingHint = isFirstMove
                ? `\nOPENING: ${FIRST_QUESTION_HINTS[Math.floor(Math.random() * FIRST_QUESTION_HINTS.length)]}`
                : "";

            const messages = [
                { role: "system", content: systemPrompt + openingHint },
                ...safeHistory,
                { role: "user", content: userInput || "Let's start!" }
            ];

            const completion = await withTimeout(
                groq.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages,
                    temperature: 0.25,
                    max_tokens: 850,
                }),
                14000
            );

            const raw = completion.choices[0]?.message?.content || "";
            const parsed = parseJSON(raw);
            const confidence = parsed.confidence || 0;

            console.log(`Q${qCount+1} | profile:"${profile}" | hypothesis:"${parsed.hypothesis}" | conf:${confidence}%`);

            // Block low-confidence guesses — ask one more verification question
            if (parsed.isGuess && confidence < 80) {
                console.log(`Guess blocked (${confidence}%). Requesting verification.`);
                const verifyMsg = [
                    {
                        role: "system",
                        content: `You are Avdhez the Jinn. Hypothesis: "${parsed.hypothesis || parsed.finalAnswer}", confidence: ${confidence}% (need 80%).
Profile so far: ${profile}
Ask ONE indirect yes/no question about a specific attribute of "${parsed.hypothesis || parsed.finalAnswer}" that does NOT name it. This question must distinguish it from alternatives.
Reply ONLY with JSON: {"reasoning":"why","hypothesis":"${parsed.hypothesis || parsed.finalAnswer}","question":"indirect question here","isGuess":false,"finalAnswer":"","confidence":${confidence}}`
                    },
                    ...safeHistory,
                    { role: "user", content: userInput || "continue" }
                ];
                try {
                    const vc = await withTimeout(groq.chat.completions.create({
                        model: "llama-3.3-70b-versatile",
                        messages: verifyMsg,
                        temperature: 0.2,
                        max_tokens: 350,
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