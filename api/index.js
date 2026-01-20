const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const TIMEZONEDB_KEY = 'VW4CCUCGOI2M'; 

// 1. SCORING CONSTANTS (The "Good" Points)
const INTERNAL_POINTS = { 
    PERFECT: 100, 
    LUNCH: 75,       // Better than shoulder
    SHOULDER: 65,    // Worse than lunch
    STRETCH: 40, 
    PAINFUL: 10, 
    IMPOSSIBLE: -100 
};

// 2. PENALTY CONSTANTS (The "Pain" Points)
const PENALTY = {
    "Perfect": 0,
    "Lunch": 1,
    "Early": 2,
    "Late": 2,
    "Hard Stretch": 5,
    "Painful": 10,
    "Weekend": 20,
    "Sleeping": 50
};

// 3. THE WEIGHT (How much we care about pain)
// A weight of 10 means 1 person in "Pain" (10 misery) cancels out 100 points of happiness.
const MISERY_WEIGHT = 10; 

const HOURS = { 
    WORK_START: 9, WORK_END: 17.5, 
    LUNCH_START: 12, LUNCH_END: 13.5, 
    SHOULDER_START: 8, SHOULDER_END: 18, 
    STRETCH_START: 7, STRETCH_END: 20, 
    PAIN_START: 6, PAIN_END: 22 
};

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

function calculateSlotScore(utc, locations, hostOffset, viewerZone, hostMode) {
    let totalHappiness = 0; // Was 'totalPoints'
    let maxPossible = 0;
    let blockers = [];
    let hasDealbreaker = false;
    let breakdown = []; 
    let miseryIndex = 0;    // Was 'miseryScore'

    // --- 1. HOST ANALYSIS ---
    const hostDate = new Date(utc + (hostOffset * 3600000));
    const hostDay = hostDate.getUTCDay();
    const hostTime = hostDate.getUTCHours() + (hostDate.getUTCMinutes() / 60);
    const hostTimeStr = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: 'numeric', minute: '2-digit', hour12: true }).format(hostDate);

    if (hostDay === 0 || hostDay === 6) {
        hasDealbreaker = true;
        blockers.push("Host: Weekend");
        miseryIndex += PENALTY["Weekend"];
    } 
    else if (hostMode === 'strict') {
        if (hostTime < HOURS.WORK_START || hostTime >= HOURS.WORK_END) {
            hasDealbreaker = true;
            blockers.push(`Host: Strict Hours (${hostTimeStr})`);
            miseryIndex += PENALTY["Painful"]; 
        }
    } 
    else {
        // Flexible Mode
        if (hostTime < HOURS.PAIN_START || hostTime >= HOURS.PAIN_END) {
            hasDealbreaker = true;
            blockers.push(`Host: Sleeping (${hostTimeStr})`);
            miseryIndex += PENALTY["Sleeping"];
        }
    }

    // --- 2. TEAM SCORING ---
    for (const loc of locations) {
        const localDate = new Date(utc + (loc.offsetVal * 3600000));
        const day = localDate.getUTCDay();
        const timeValue = localDate.getUTCHours() + (localDate.getUTCMinutes() / 60);
        const localTimeStr = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: 'numeric', minute: '2-digit', hour12: true }).format(localDate);

        let points = 0;
        let reason = ""; 

        if (day === 0 || day === 6) { 
            points = INTERNAL_POINTS.IMPOSSIBLE; reason = "Weekend"; hasDealbreaker = true; 
        } else {
            if (timeValue >= HOURS.WORK_START && timeValue < HOURS.WORK_END) {
                if (timeValue >= HOURS.LUNCH_START && timeValue < HOURS.LUNCH_END) {
                    points = INTERNAL_POINTS.LUNCH; reason = "Lunch"; 
                } else {
                    points = INTERNAL_POINTS.PERFECT; reason = "Perfect"; 
                }
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
            else {
                points = INTERNAL_POINTS.IMPOSSIBLE; reason = "Sleeping"; hasDealbreaker = true;
            }
        }
        
        totalHappiness += points; 
        maxPossible += INTERNAL_POINTS.PERFECT;
        miseryIndex += (PENALTY[reason] || 0);

        if (points < INTERNAL_POINTS.PERFECT) blockers.push(`${loc.timezone}: ${reason}`);
        
        breakdown.push({
            zone: loc.timezone,
            local_time: localTimeStr,
            status: reason,
            score: points
        });
    }

    // --- 3. THE FAIRNESS CALCULATION ---
    const conflictPenalty = miseryIndex * MISERY_WEIGHT;
    const finalScore = totalHappiness - conflictPenalty;

    const status = (hasDealbreaker || maxPossible === 0) ? "red" : ((finalScore / maxPossible) * 100 >= 70 ? "green" : "yellow");
    
    let displayTime = "Invalid";
    try {
        displayTime = new Intl.DateTimeFormat("en-US", { timeZone: viewerZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(utc));
    } catch (e) { displayTime = "Invalid Zone"; }

    return { 
        utc, 
        display_time: displayTime, 
        
        // THE 4 SCORES
        fairness_score: finalScore,      // The Ranker
        happiness_score: totalHappiness, // The Good
        misery_index: miseryIndex,       // The Bad
        conflict_penalty: conflictPenalty, // The Tax
        
        status, 
        blockers, 
        breakdown 
    };
}

// --- ROUTES ---

app.get('/api/health', (req, res) => {
    res.json({ status: "Orbit Engine Online", env: process.env.VERCEL ? "Vercel" : "Standard Server" });
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
    const { date, timezones, optimize_for, host_timezone, host_mode } = req.body;
    
    if (!date || !timezones) return res.status(400).json({ error: "Missing inputs" });

    const mode = host_mode || 'strict'; 
    const hostZone = host_timezone || optimize_for || "UTC";
    const viewerZone = optimize_for || "UTC";

    const hostOffset = getOffsetInHours(hostZone, date);
    if (hostOffset === null) return res.status(400).json({ error: "Invalid Host Timezone" });

    const locations = [], errors = [];
    
    for (const tz of timezones) {
        const off = getOffsetInHours(tz, date);
        if (off === null) errors.push(tz);
        else locations.push({ timezone: tz, offsetVal: off });
    }
    
    if (errors.length) return res.status(400).json({ error: "Invalid Timezones", invalid_ids: errors });

    const utcMidnight = new Date(date + "T00:00:00Z").getTime();
    const startUTC = utcMidnight - (hostOffset * 3600000); 
    
    const results = [];
    for (let i = 0; i < 24; i++) {
        const slotUTC = startUTC + (i * 60 * 60000); 
        results.push(calculateSlotScore(slotUTC, locations, hostOffset, viewerZone, mode));
    }

    // Sort by Fairness Score
    results.sort((a, b) => b.fairness_score - a.fairness_score);

    res.json({ 
        host: hostZone,
        mode: mode,
        viewer: viewerZone,
        top_3: results.filter(r => r.status !== 'red').slice(0, 3), 
        all_slots: results 
    });
});

if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`🚀 Orbit Server running on http://localhost:${PORT}`));
}

module.exports = app;
