const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const TIMEZONEDB_KEY = 'VW4CCUCGOI2M'; 

// --- UPDATED CONFIGURATION ---
const INTERNAL_POINTS = { PERFECT: 100, OKAY: 70, STRETCH: 40, PAINFUL: 10, IMPOSSIBLE: -100 };
// Misery Units: Used for the Penalty calculation
const MISERY_UNITS = { "Perfect": 0, "Lunch": 1, "Shoulder": 2, "Stretch": 5, "Painful": 10, "Sleeping": 50 };

// Meeting Scenarios mapping to Weight and Host Policy
const SCENARIOS = {
    "peer_sync": { hostStrict: false, weight: 12 },    // The Compromiser
    "client_meeting": { hostStrict: true, weight: 12 }, // The Executive
    "all_hands": { hostStrict: false, weight: 7 },     // Majority Rules
    "urgent_briefing": { hostStrict: true, weight: 7 },  // Host First
    "culture_chat": { hostStrict: false, weight: 18 },  // People First
    "gold_standard": { hostStrict: true, weight: 18 }   // High Standards
};

const HOURS = { WORK_START: 9, WORK_END: 17.5, LUNCH_START: 12, LUNCH_END: 13.5, SHOULDER_START: 8, SHOULDER_END: 18, STRETCH_START: 7, STRETCH_END: 20, PAIN_START: 6, PAIN_END: 22 };

function getOffsetInHours(timeZone, dateStr) {
    try {
        const date = new Date(dateStr + "T12:00:00Z");
        const format = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" });
        const parts = format.formatToParts(date);
        const val = parts.find(p => p.type === "timeZoneName").value.replace("GMT", "").replace("UTC", "");
        const [h, m] = val.split(":").map(Number);
        return h + (h < 0 ? -(m / 60 || 0) : (m / 60 || 0));
    } catch (e) { return null; }
}

function calculateSlotScore(utc, locations, hostOffset, viewerZone, config) {
    const hostDate = new Date(utc + (hostOffset * 3600000));
    const hostDay = hostDate.getUTCDay();
    const hostTime = hostDate.getUTCHours() + (hostDate.getUTCMinutes() / 60);
    const displayTime = new Intl.DateTimeFormat("en-US", { timeZone: viewerZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(utc));

    // --- 1. HOST POLICY CHECK ---
    if (hostDay === 0 || hostDay === 6) return { status: "red", blockers: ["Weekend"] };
    
    if (config.hostStrict) {
        if (hostTime < HOURS.WORK_START || hostTime >= HOURS.WORK_END) 
            return { status: "red", blockers: ["Host: Strict 9-5 Constraint"] };
    } else {
        if (hostTime < HOURS.PAIN_START || hostTime >= HOURS.PAIN_END) 
            return { status: "red", blockers: ["Host: Outside Flexible Range"] };
    }

    // --- 2. TEAM SCORING (HAPPINESS vs MISERY) ---
    let totalHappiness = 0;
    let totalMisery = 0;
    let blockers = [];
    let hasDealbreaker = false;

    for (const loc of locations) {
        const localDate = new Date(utc + (loc.offsetVal * 3600000));
        const time = localDate.getUTCHours() + (localDate.getUTCMinutes() / 60);
        let points = 0, misery = 0, label = "";

        if (localDate.getUTCDay() === 0 || localDate.getUTCDay() === 6) { 
            points = INTERNAL_POINTS.IMPOSSIBLE; misery = MISERY_UNITS.Sleeping; hasDealbreaker = true; 
        } else {
            if (time >= HOURS.WORK_START && time < HOURS.WORK_END) {
                if (time >= HOURS.LUNCH_START && time < HOURS.LUNCH_END) { points = INTERNAL_POINTS.OKAY; misery = MISERY_UNITS.Lunch; label = "Lunch"; }
                else { points = INTERNAL_POINTS.PERFECT; misery = MISERY_UNITS.Perfect; }
            }
            else if (time >= HOURS.SHOULDER_START && time < HOURS.SHOULDER_END) { points = INTERNAL_POINTS.OKAY; misery = MISERY_UNITS.Shoulder; label = "Shoulder"; }
            else if (time >= HOURS.STRETCH_START && time < HOURS.STRETCH_END) { points = INTERNAL_POINTS.STRETCH; misery = MISERY_UNITS.Stretch; label = "Stretch"; }
            else if (time >= HOURS.PAIN_START && time < HOURS.PAIN_END) { points = INTERNAL_POINTS.PAINFUL; misery = MISERY_UNITS.Painful; label = "Pain"; }
            else { points = INTERNAL_POINTS.IMPOSSIBLE; misery = MISERY_UNITS.Sleeping; label = "Sleep"; hasDealbreaker = true; }
        }

        totalHappiness += points;
        totalMisery += misery;
        if (label) blockers.push(`${loc.timezone}: ${label}`);
    }

    // --- 3. THE WEIGHTED CALCULATION ---
    const penalty = totalMisery * config.weight;
    const finalScore = totalHappiness - penalty;

    return { 
        utc, 
        display_time: displayTime, 
        score: finalScore, 
        penalty: penalty,
        status: hasDealbreaker ? "red" : (finalScore > 50 ? "green" : "yellow"), 
        blockers 
    };
}

app.post('/api/optimize', (req, res) => {
    const { date, timezones, host_timezone, scenario } = req.body;
    const config = SCENARIOS[scenario] || SCENARIOS.peer_sync;
    const hostOffset = getOffsetInHours(host_timezone, date);
    
    const locations = timezones.map(tz => ({ timezone: tz, offsetVal: getOffsetInHours(tz, date) }));
    const results = [];
    const startUTC = new Date(date + "T00:00:00Z").getTime();
    
    for (let i = 0; i < 24; i++) {
        results.push(calculateSlotScore(startUTC + (i * 3600000), locations, hostOffset, host_timezone, config));
    }

    res.json({ 
        top_3: results.filter(r => r.status !== 'red').sort((a, b) => b.score - a.score).slice(0, 3),
        all_slots: results 
    });
});

app.post('/api/resolve', async (req, res) => {
    const { city } = req.body;
    try {
        const gRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${city}`);
        const gData = await gRes.json();
        const tRes = await fetch(`https://api.timezonedb.com/v2.1/get-time-zone?key=${TIMEZONEDB_KEY}&format=json&by=position&lat=${gData[0].lat}&lng=${gData[0].lon}`);
        const tData = await tRes.json();
        res.json({ status: "OK", timezone_id: tData.zoneName, resolved_name: gData[0].display_name });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(3000);
