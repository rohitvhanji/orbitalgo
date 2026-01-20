const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const TIMEZONEDB_KEY = 'VW4CCUCGOI2M'; 

// --- SCORING CONFIGURATION ---
const INTERNAL_POINTS = { PERFECT: 100, LUNCH: 75, SHOULDER: 65, STRETCH: 40, PAINFUL: 10, IMPOSSIBLE: -100 };
const PENALTY_UNITS = { "Perfect": 0, "Lunch": 1, "Early": 2, "Late": 2, "Hard Stretch": 5, "Painful": 10, "Weekend": 20, "Sleeping": 50 };

// --- WEIGHT PROFILES (The Personality) ---
const WEIGHT_PROFILES = {
    efficiency: 7,  // Prioritizes the majority. Good for quick syncs.
    balanced: 12,    // The "Human" default. Derivied from zone logic.
    human: 18       // Protects the individual at all costs.
};

const HOURS = { WORK_START: 9, WORK_END: 17.5, LUNCH_START: 12, LUNCH_END: 13.5, SHOULDER_START: 8, SHOULDER_END: 18, STRETCH_START: 7, STRETCH_END: 20, PAIN_START: 6, PAIN_END: 22 };

// --- HELPERS ---
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

function calculateSlotScore(utc, locations, hostOffset, viewerZone, hostMode, weightValue) {
    let totalHappiness = 0;
    let maxPossible = 0;
    let miseryIndex = 0;
    let blockers = [];
    let hasDealbreaker = false;
    let breakdown = []; 

    const hostDate = new Date(utc + (hostOffset * 3600000));
    const hostDay = hostDate.getUTCDay();
    const hostTime = hostDate.getUTCHours() + (hostDate.getUTCMinutes() / 60);

    // Host Gatekeeper Logic
    if (hostDay === 0 || hostDay === 6) { hasDealbreaker = true; miseryIndex += PENALTY_UNITS["Weekend"]; } 
    else if (hostMode === 'strict') {
        if (hostTime < HOURS.WORK_START || hostTime >= HOURS.WORK_END) { hasDealbreaker = true; miseryIndex += PENALTY_UNITS["Painful"]; }
    } else {
        if (hostTime < HOURS.PAIN_START || hostTime >= HOURS.PAIN_END) { hasDealbreaker = true; miseryIndex += PENALTY_UNITS["Sleeping"]; }
    }

    // Scoring Loop
    for (const loc of locations) {
        const localDate = new Date(utc + (loc.offsetVal * 3600000));
        const day = localDate.getUTCDay();
        const timeValue = localDate.getUTCHours() + (localDate.getUTCMinutes() / 60);
        let points = 0, reason = "";

        if (day === 0 || day === 6) { points = INTERNAL_POINTS.IMPOSSIBLE; reason = "Weekend"; hasDealbreaker = true; } 
        else {
            if (timeValue >= HOURS.WORK_START && timeValue < HOURS.WORK_END) {
                if (timeValue >= HOURS.LUNCH_START && timeValue < HOURS.LUNCH_END) { points = INTERNAL_POINTS.LUNCH; reason = "Lunch"; }
                else { points = INTERNAL_POINTS.PERFECT; reason = "Perfect"; }
            }
            else if ((timeValue >= HOURS.SHOULDER_START && timeValue < HOURS.WORK_START) || (timeValue >= HOURS.WORK_END && timeValue < HOURS.SHOULDER_END)) {
                points = INTERNAL_POINTS.SHOULDER; reason = (timeValue < 12) ? "Early" : "Late";
            }
            else if ((timeValue >= HOURS.STRETCH_START && timeValue < HOURS.SHOULDER_START) || (timeValue >= HOURS.SHOULDER_END && timeValue < HOURS.STRETCH_END)) {
                points = INTERNAL_POINTS.STRETCH; reason = "Hard Stretch";
            }
            else if ((timeValue >= HOURS.PAIN_START && timeValue < HOURS.STRETCH_START) || (timeValue >= HOURS.STRETCH_END && timeValue < HOURS.PAIN_END)) {
                points = INTERNAL_POINTS.PAINFUL; reason = "Painful";
            }
            else { points = INTERNAL_POINTS.IMPOSSIBLE; reason = "Sleeping"; hasDealbreaker = true; }
        }
        
        totalHappiness += points;
        maxPossible += INTERNAL_POINTS.PERFECT;
        miseryIndex += (PENALTY_UNITS[reason] || 0);
        if (points < INTERNAL_POINTS.PERFECT) blockers.push(`${loc.timezone}: ${reason}`);
        
        breakdown.push({ zone: loc.timezone, status: reason, score: points });
    }

    const conflictPenalty = miseryIndex * weightValue;
    const finalScore = totalHappiness - conflictPenalty;

    return { 
        utc, 
        display_time: new Intl.DateTimeFormat("en-US", { timeZone: viewerZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(utc)),
        fairness_score: finalScore,
        happiness_score: totalHappiness,
        misery_index: miseryIndex,
        conflict_penalty: conflictPenalty,
        status: hasDealbreaker ? "red" : (finalScore > 0 ? "green" : "yellow"),
        blockers, 
        breakdown 
    };
}

app.post('/api/optimize', (req, res) => {
    const { date, timezones, optimize_for, host_timezone, host_mode, profile } = req.body;
    
    const weightValue = WEIGHT_PROFILES[profile] || WEIGHT_PROFILES.balanced;
    const hMode = host_mode || 'strict';
    const hostZone = host_timezone || optimize_for;
    const viewerZone = optimize_for || "UTC";

    const hostOffset = getOffsetInHours(hostZone, date);
    const locations = [];
    for (const tz of timezones) {
        const off = getOffsetInHours(tz, date);
        if (off !== null) locations.push({ timezone: tz, offsetVal: off });
    }

    const utcMidnight = new Date(date + "T00:00:00Z").getTime();
    const startUTC = utcMidnight - (hostOffset * 3600000); 
    
    const results = [];
    for (let i = 0; i < 24; i++) {
        const slotUTC = startUTC + (i * 60 * 60000); 
        results.push(calculateSlotScore(slotUTC, locations, hostOffset, viewerZone, hMode, weightValue));
    }

    results.sort((a, b) => b.fairness_score - a.fairness_score);

    res.json({ 
        profile, 
        weight_used: weightValue,
        top_3: results.filter(r => r.status !== 'red').slice(0, 3), 
        all_slots: results 
    });
});

app.post('/api/resolve', async (req, res) => {
    const { city } = req.body;
    try {
        const gRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(city)}`, { headers: { 'User-Agent': 'Orbit/1.0' } });
        const gData = await gRes.json();
        const tRes = await fetch(`https://api.timezonedb.com/v2.1/get-time-zone?key=${TIMEZONEDB_KEY}&format=json&by=position&lat=${gData[0].lat}&lng=${gData[0].lon}`);
        const tData = await tRes.json();
        res.json({ status: "OK", timezone_id: tData.zoneName });
    } catch (e) { res.status(500).json({ error: "Resolution failed" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Orbit Engine Ready` ));
