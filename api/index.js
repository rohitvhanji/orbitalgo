const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const TIMEZONEDB_KEY = 'VW4CCUCGOI2M'; 

// Happiness points (Positive)
const INTERNAL_POINTS = { 
    PERFECT: 100, 
    OKAY: 70, 
    STRETCH: 40, 
    PAINFUL: 10, 
    IMPOSSIBLE: -100 
};

// Misery units (Negative - used for the "Pain Tax")
const MISERY_UNITS = { 
    "Perfect": 0, 
    "Lunch": 1, 
    "Shoulder": 2, 
    "Stretch": 5, 
    "Painful": 10, 
    "Sleeping": 50 
};

// Meeting Policies (The "Personality" of the calculation)
const POLICIES = {
    "peer_sync": { hostStrict: false, weight: 12 },    // Balanced
    "client_meeting": { hostStrict: true, weight: 12 }, // Manager Mode
    "all_hands": { hostStrict: false, weight: 7 },     // Efficiency First
    "urgent_briefing": { hostStrict: true, weight: 7 },  // Host Priority
    "culture_chat": { hostStrict: false, weight: 18 },  // Human-First
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
        displayTime = new Intl.DateTimeFormat("en-US", { 
            timeZone: viewerZone, 
            hour: 'numeric', 
            minute: '2-digit', 
            hour12: true 
        }).format(new Date(utc));
    } catch (e) { displayTime = "Invalid Zone"; }

    // 1. HOST POLICY CHECK (STRICT VS FLEXIBLE)
    if (hostDay === 0 || hostDay === 6) {
        return { display_time: displayTime, score: -999, status: "red", blockers: ["Host: Weekend"] };
    }

    if (policy.hostStrict) {
        // Strict 9-5 Policy
        if (hostTime < HOURS.WORK_START || hostTime >= HOURS.WORK_END) {
            return { display_time: displayTime, score: -999, status: "red", blockers: ["Host: 9-5 Constraint"] };
        }
    } else {
        // Flexible (Allows Shoulder/Stretch hours)
        if (hostTime < HOURS.PAIN_START || hostTime >= HOURS.PAIN_END) {
            return { display_time: displayTime, score: -999, status: "red", blockers: ["Host: Outside Flex Hours"] };
        }
    }

    // 2. TEAM SCORING (Happiness - (Misery * Weight))
    let totalHappiness = 0;
    let totalMisery = 0;
    let blockers = [];
    let hasDealbreaker = false;

    for (const loc of locations) {
        const localDate = new Date(utc + (loc.offsetVal * 3600000));
        const timeValue = localDate.getUTCHours() + (localDate.getUTCMinutes() / 60);
        let p = 0, m = 0, note = "";

        if (localDate.getUTCDay() === 0 || localDate.getUTCDay() === 6) { 
            p = INTERNAL_POINTS.IMPOSSIBLE; m = MISERY_UNITS.Sleeping; hasDealbreaker = true; note = "Weekend";
        } else {
            if (timeValue >= HOURS.WORK_START && timeValue < HOURS.WORK_END) {
                if (timeValue >= HOURS.LUNCH_START && timeValue < HOURS.LUNCH_END) { p = INTERNAL_POINTS.OKAY; m = MISERY_UNITS.Lunch; note = "Lunch"; }
                else { p = INTERNAL_POINTS.PERFECT; m = MISERY_UNITS.Perfect; }
            }
            else if (timeValue >= HOURS.SHOULDER_START && timeValue < HOURS.SHOULDER_END) { p = INTERNAL_POINTS.OKAY; m = MISERY_UNITS.Shoulder; note = "Shoulder"; }
            else if (timeValue >= HOURS.STRETCH_START && timeValue < HOURS.STRETCH_END) { p = INTERNAL_POINTS.STRETCH; m = MISERY_UNITS.Stretch; note = "Hard"; }
            else if (timeValue >= HOURS.PAIN_START && timeValue < HOURS.PAIN_END) { p = INTERNAL_POINTS.PAINFUL; m = MISERY_UNITS.Painful; note = "Painful"; }
            else { p = INTERNAL_POINTS.IMPOSSIBLE; m = MISERY_UNITS.Sleeping; hasDealbreaker = true; note = "Sleep"; }
        }
        totalHappiness += p;
        totalMisery += m;
        if (note) blockers.push(`${loc.timezone}: ${note}`);
    }

    // Applying the Weight to the Misery Index
    const penalty = totalMisery * policy.weight;
    const finalScore = totalHappiness - penalty;

    // Determine status based on final fairness score
    let status = "green";
    if (hasDealbreaker || finalScore < 0) status = "red";
    else if (finalScore < 60) status = "yellow";

    return { 
        utc,
        display_time: displayTime, 
        score: Math.round(finalScore), 
        penalty: Math.round(penalty),
        status, 
        blockers 
    };
}

// --- ROUTES ---

app.get('/api/health', (req, res) => {
    res.json({ status: "Orbit Online", version: "2.1.0" });
});

app.post('/api/resolve', async (req, res) => {
    const { city } = req.body;
    if (!city) return res.status(400).json({ error: "Missing city" });
    try {
        const gRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(city)}`, { headers: { 'User-Agent': 'Orbit/1.0' } });
        const gData = await gRes.json();
        if (!gData.length) return res.status(404).json({ error: "City not found" });

        const tRes = await fetch(`https://api.timezonedb.com/v2.1/get-time-zone?key=${TIMEZONEDB_KEY}&format=json&by=position&lat=${gData[0].lat}&lng=${gData[0].lon}`);
        const tData = await tRes.json();

        res.json({ status: "OK", timezone_id: tData.zoneName, resolved_name: gData[0].display_name });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/optimize', (req, res) => {
    const { date, timezones, host_timezone, scenario } = req.body;
    
    if (!date || !timezones || !host_timezone) {
        return res.status(400).json({ error: "Missing required inputs (date, timezones, host_timezone)" });
    }

    const policy = POLICIES[scenario] || POLICIES.peer_sync;
    const hostOffset = getOffsetInHours(host_timezone, date);
    
    const locations = timezones.map(tz => ({
        timezone: tz,
        offsetVal: getOffsetInHours(tz, date)
    }));

    const all_slots = [];
    const startUTC = new Date(date + "T00:00:00Z").getTime();
    
    // Loop through all 24 hours of the day
    for (let i = 0; i < 24; i++) {
        const slotUTC = startUTC + (i * 3600000);
        all_slots.push(calculateSlotScore(slotUTC, locations, hostOffset, host_timezone, policy));
    }

    res.json({ 
        host: host_timezone,
        policy_used: scenario,
        // Now returning only the full timeline; UI can filter for top 3 if needed
        all_slots: all_slots 
    });
});

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`🚀 Orbit Server running on port ${PORT}`));
}

module.exports = app;
