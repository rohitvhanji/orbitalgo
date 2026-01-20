const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const TIMEZONEDB_KEY = 'VW4CCUCGOI2M'; 

// --- 1. ENHANCED CONFIGURATION ---
const INTERNAL_POINTS = { PERFECT: 100, OKAY: 70, STRETCH: 40, PAINFUL: 10, IMPOSSIBLE: -100 };

// NEW: This is the "Pain Weight" for the negatives
const MISERY_UNITS = { "Perfect": 0, "Lunch": 1, "Shoulder": 2, "Stretch": 5, "Painful": 10, "Sleeping": 50 };

// NEW: Policies mapping to Weight and Host Strictness
const POLICIES = {
    "peer_sync": { hostStrict: false, weight: 12 },    // Balanced
    "client_meeting": { hostStrict: true, weight: 12 }, // Manager Mode
    "all_hands": { hostStrict: false, weight: 7 },     // Fast Scheduling
    "urgent_briefing": { hostStrict: true, weight: 7 },  // Host First
    "culture_chat": { hostStrict: false, weight: 18 },  // People First
    "gold_standard": { hostStrict: true, weight: 18 }   // High Standards
};

const HOURS = { 
    WORK_START: 9, WORK_END: 17.5, 
    LUNCH_START: 12, LUNCH_END: 13.5, 
    SHOULDER_START: 8, SHOULDER_END: 18, 
    STRETCH_START: 7, STRETCH_END: 20, 
    PAIN_START: 6, PAIN_END: 22 
};

// --- LOGIC HELPERS ---
function getOffsetInHours(timeZone, dateStr) {
    try {
        const date = new Date(dateStr + "T12:00:00Z");
        const format = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" });
        const parts = format.formatToParts(date);
        const val = parts.find(p => p.type === "timeZoneName").value.replace("GMT", "").replace("UTC", "");
        if (!val) return 0;
        const [h, m] = val.split(":").map(Number);
        return h + (h < 0 ? -(m / 60 || 0) : (m / 60 || 0));
    } catch (e) { return null; }
}

function calculateSlotScore(utc, locations, hostOffset, viewerZone, policy) {
    const hostDate = new Date(utc + (hostOffset * 3600000));
    const hostDay = hostDate.getUTCDay();
    const hostTime = hostDate.getUTCHours() + (hostDate.getUTCMinutes() / 60);

    let displayTime = "Invalid";
    try {
        displayTime = new Intl.DateTimeFormat("en-US", { timeZone: viewerZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(utc));
    } catch (e) { displayTime = "Invalid Zone"; }

    // --- 2. HOST POLICY CHECK ---
    if (hostDay === 0 || hostDay === 6) {
        return { display_time: displayTime, status: "red", blockers: ["Host: Weekend"] };
    }

    if (policy.hostStrict) {
        if (hostTime < HOURS.WORK_START || hostTime >= HOURS.WORK_END) {
            return { display_time: displayTime, status: "red", blockers: ["Host: Strict 9-5 Veto"] };
        }
    } else {
        if (hostTime < HOURS.PAIN_START || hostTime >= HOURS.PAIN_END) {
            return { display_time: displayTime, status: "red", blockers: ["Host: Outside Flex Hours"] };
        }
    }

    // --- 3. TEAM SCORING (Happiness - (Misery * Weight)) ---
    let totalHappiness = 0, totalMisery = 0, blockers = [], hasDealbreaker = false;

    for (const loc of locations) {
        const localDate = new Date(utc + (loc.offsetVal * 3600000));
        const timeValue = localDate.getUTCHours() + (localDate.getUTCMinutes() / 60);
        let points = 0, misery = 0, note = "";

        if (localDate.getUTCDay() === 0 || localDate.getUTCDay() === 6) { 
            points = INTERNAL_POINTS.IMPOSSIBLE; misery = MISERY_UNITS.Sleeping; hasDealbreaker = true; 
        } else {
            if (timeValue >= HOURS.WORK_START && timeValue < HOURS.WORK_END) {
                if (timeValue >= HOURS.LUNCH_START && timeValue < HOURS.LUNCH_END) { points = INTERNAL_POINTS.OKAY; misery = MISERY_UNITS.Lunch; note = "Lunch"; }
                else { points = INTERNAL_POINTS.PERFECT; misery = MISERY_UNITS.Perfect; }
            }
            else if (timeValue >= HOURS.SHOULDER_START && timeValue < HOURS.SHOULDER_END) { points = INTERNAL_POINTS.OKAY; misery = MISERY_UNITS.Shoulder; note = "Shoulder"; }
            else if (timeValue >= HOURS.STRETCH_START && timeValue < HOURS.STRETCH_END) { points = INTERNAL_POINTS.STRETCH; misery = MISERY_UNITS.Stretch; note = "Hard"; }
            else if (timeValue >= HOURS.PAIN_START && timeValue < HOURS.PAIN_END) { points = INTERNAL_POINTS.PAINFUL; misery = MISERY_UNITS.Painful; note = "Painful"; }
            else { points = INTERNAL_POINTS.IMPOSSIBLE; misery = MISERY_UNITS.Sleeping; hasDealbreaker = true; note = "Sleep"; }
        }
        totalHappiness += points;
        totalMisery += misery;
        if (note) blockers.push(`${loc.timezone}: ${note}`);
    }

    const finalScore = totalHappiness - (totalMisery * policy.weight);

    return { 
        display_time: displayTime, 
        score: finalScore, 
        status: hasDealbreaker ? "red" : "green", 
        blockers 
    };
}

// --- ROUTES ---

app.post('/api/optimize', (req, res) => {
    const { date, timezones, host_timezone, scenario } = req.body;
    
    const policy = POLICIES[scenario] || POLICIES.peer_sync;
    const hostOffset = getOffsetInHours(host_timezone, date);
    const locations = timezones.map(tz => ({ timezone: tz, offsetVal: getOffsetInHours(tz, date) }));

    const results = [];
    const startUTC = new Date(date + "T00:00:00Z").getTime();
    
    for (let i = 0; i < 24; i++) {
        results.push(calculateSlotScore(startUTC + (i * 3600000), locations, hostOffset, host_timezone, policy));
    }

    res.json({ 
        policy_used: scenario,
        top_3: results.filter(r => r.status !== 'red').sort((a, b) => b.score - a.score).slice(0, 3)
    });
});

// Reuse your existing resolve logic...
app.post('/api/resolve', async (req, res) => {
    const { city } = req.body;
    try {
        const gRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(city)}`, { headers: { 'User-Agent': 'Orbit/1.0' } });
        const gData = await gRes.json();
        const tRes = await fetch(`https://api.timezonedb.com/v2.1/get-time-zone?key=${TIMEZONEDB_KEY}&format=json&by=position&lat=${gData[0].lat}&lng=${gData[0].lon}`);
        const tData = await tRes.json();
        res.json({ status: "OK", timezone_id: tData.zoneName });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 API Test Server: http://localhost:${PORT}`));
