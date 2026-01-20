const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors()); // Allows your HTML file to talk to this server
app.use(express.json());

const TIMEZONEDB_KEY = 'VW4CCUCGOI2M'; 

const POINTS = { PERFECT: 100, LUNCH: 75, SHOULDER: 65, STRETCH: 40, PAINFUL: 10, IMPOSSIBLE: -100 };
const MISERY = { "Perfect": 0, "Lunch": 1, "Early": 2, "Late": 2, "Hard Stretch": 5, "Painful": 10, "Weekend": 20, "Sleeping": 50 };
const HOURS = { WORK_START: 9, WORK_END: 17.5, LUNCH_START: 12, LUNCH_END: 13.5, PAIN_START: 6, PAIN_END: 22 };

const SCENARIOS = {
    "peer_sync": { hostMode: 'flexible', weight: 12 },
    "client_meeting": { hostMode: 'strict', weight: 12 },
    "all_hands": { hostMode: 'flexible', weight: 7 },
    "urgent_briefing": { hostMode: 'strict', weight: 7 },
    "culture_chat": { hostMode: 'flexible', weight: 18 },
    "gold_standard": { hostMode: 'strict', weight: 18 }
};

// Helper: Get Offset
function getOffsetInHours(timeZone, dateStr) {
    try {
        const date = new Date(dateStr + "T12:00:00Z");
        const format = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" });
        const parts = format.formatToParts(date);
        const val = parts.find(p => p.type === "timeZoneName").value.replace("GMT", "").replace("UTC", "");
        const [h, m] = val.split(":").map(Number);
        return h + (h < 0 ? -(m / 60 || 0) : (m / 60 || 0));
    } catch (e) { return 0; }
}

// THE CALCULATION ENGINE
function calculateSlot(utc, locations, hostOffset, viewerZone, config) {
    let totalHappiness = 0, miseryIndex = 0, blockers = [], breakdown = [], hasDealbreaker = false;
    const hostDate = new Date(utc + (hostOffset * 3600000));
    const hTime = hostDate.getUTCHours() + (hostDate.getUTCMinutes() / 60);

    if (config.hostMode === 'strict' && (hTime < HOURS.WORK_START || hTime >= HOURS.WORK_END)) hasDealbreaker = true;

    for (const loc of locations) {
        const localDate = new Date(utc + (loc.offsetVal * 3600000));
        const time = localDate.getUTCHours() + (localDate.getUTCMinutes() / 60);
        let p = 0, r = "";

        if (localDate.getUTCDay() === 0 || localDate.getUTCDay() === 6) { p = POINTS.IMPOSSIBLE; r = "Weekend"; hasDealbreaker = true; }
        else if (time >= HOURS.WORK_START && time < HOURS.WORK_END) {
            if (time >= HOURS.LUNCH_START && time < HOURS.LUNCH_END) { p = POINTS.LUNCH; r = "Lunch"; }
            else { p = POINTS.PERFECT; r = "Perfect"; }
        } else if (time >= 6 && time < 22) { p = POINTS.PAINFUL; r = "Painful"; }
        else { p = POINTS.IMPOSSIBLE; r = "Sleeping"; hasDealbreaker = true; }

        totalHappiness += p;
        miseryIndex += (MISERY[r] || 0);
        breakdown.push({ zone: loc.timezone, local_time: new Intl.DateTimeFormat("en-US", { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: "UTC" }).format(localDate), score: p });
    }

    const penalty = miseryIndex * config.weight;
    return {
        display_time: new Intl.DateTimeFormat("en-US", { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: viewerZone }).format(new Date(utc)),
        fairness_score: totalHappiness - penalty,
        conflict_penalty: penalty,
        status: hasDealbreaker ? "red" : "green",
        breakdown
    };
}

// 1. RESOLVE CITIES (SERVER-SIDE)
app.post('/api/resolve-team', async (req, res) => {
    try {
        const { cities } = req.body;
        const results = [];
        for (let city of cities) {
            const gRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(city)}`);
            const gData = await gRes.json();
            if (gData.length > 0) {
                const tRes = await fetch(`https://api.timezonedb.com/v2.1/get-time-zone?key=${TIMEZONEDB_KEY}&format=json&by=position&lat=${gData[0].lat}&lng=${gData[0].lon}`);
                const tData = await tRes.json();
                results.push(tData.zoneName);
                // Artificial delay to prevent 429 API Limit
                await new Promise(r => setTimeout(r, 1100)); 
            }
        }
        res.json({ timezones: results });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2. OPTIMIZE
app.post('/api/optimize', (req, res) => {
    const { date, timezones, optimize_for, scenario } = req.body;
    const config = SCENARIOS[scenario] || SCENARIOS.peer_sync;
    const hostOffset = getOffsetInHours(optimize_for, date);
    const locations = timezones.map(tz => ({ timezone: tz, offsetVal: getOffsetInHours(tz, date) }));

    const startUTC = new Date(date + "T00:00:00Z").getTime() - (hostOffset * 3600000); 
    const results = [];
    for (let i = 0; i < 24; i++) {
        results.push(calculateSlot(startUTC + (i * 3600000), locations, hostOffset, optimize_for, config));
    }
    results.sort((a, b) => b.fairness_score - a.fairness_score);
    res.json({ top_3: results.filter(r => r.status !== 'red').slice(0, 3) });
});

app.listen(3000, () => console.log('🚀 Server running on http://localhost:3000'));
