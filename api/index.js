const express = require('express');
const cors = require('cors');
const app = express();

// Robust CORS to allow local file testing
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST']
}));
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

// Simple route to check if server is alive
app.get('/api/health', (req, res) => {
    res.json({ status: "Online", time: new Date().toISOString() });
});

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

function calculateSlot(utc, locations, hostOffset, viewerZone, config) {
    let totalHappiness = 0, miseryIndex = 0, blockers = [], hasDealbreaker = false, breakdown = [];
    
    const hostDate = new Date(utc + (hostOffset * 3600000));
    const hTime = hostDate.getUTCHours() + (hostDate.getUTCMinutes() / 60);
    const hDay = hostDate.getUTCDay();

    if (hDay === 0 || hDay === 6) hasDealbreaker = true;
    else if (config.hostMode === 'strict') {
        if (hTime < HOURS.WORK_START || hTime >= HOURS.WORK_END) hasDealbreaker = true;
    } else {
        if (hTime < HOURS.PAIN_START || hTime >= HOURS.PAIN_END) hasDealbreaker = true;
    }

    for (const loc of locations) {
        const localDate = new Date(utc + (loc.offsetVal * 3600000));
        const time = localDate.getUTCHours() + (localDate.getUTCMinutes() / 60);
        let p = 0, r = "";

        if (localDate.getUTCDay() === 0 || localDate.getUTCDay() === 6) { p = POINTS.IMPOSSIBLE; r = "Weekend"; hasDealbreaker = true; }
        else if (time >= HOURS.WORK_START && time < HOURS.WORK_END) {
            if (time >= HOURS.LUNCH_START && time < HOURS.LUNCH_END) { p = POINTS.LUNCH; r = "Lunch"; }
            else { p = POINTS.PERFECT; r = "Perfect"; }
        }
        else if (time >= 8 && time < 18) { p = POINTS.SHOULDER; r = (time < 12) ? "Early" : "Late"; }
        else if (time >= 7 && time < 20) { p = POINTS.STRETCH; r = "Hard Stretch"; }
        else if (time >= 6 && time < 22) { p = POINTS.PAINFUL; r = "Painful"; }
        else { p = POINTS.IMPOSSIBLE; r = "Sleeping"; hasDealbreaker = true; }

        totalHappiness += p;
        miseryIndex += (MISERY[r] || 0);
        if (p < POINTS.PERFECT) blockers.push(`${loc.timezone}: ${r}`);

        breakdown.push({
            zone: loc.timezone,
            local_time: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: 'numeric', minute: '2-digit', hour12: true }).format(localDate),
            score: p
        });
    }

    const penalty = miseryIndex * config.weight;
    const finalScore = totalHappiness - penalty;

    return {
        utc,
        display_time: new Intl.DateTimeFormat("en-US", { timeZone: viewerZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(utc)),
        fairness_score: finalScore,
        happiness_score: totalHappiness,
        conflict_penalty: penalty,
        status: hasDealbreaker ? "red" : (finalScore > 100 ? "green" : "yellow"),
        blockers: [...new Set(blockers)],
        breakdown
    };
}

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

app.post('/api/resolve', async (req, res) => {
    try {
        const { city } = req.body;
        const gRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${city}`);
        const gData = await gRes.json();
        if (!gData.length) return res.status(404).json({ error: "City not found" });
        
        const tRes = await fetch(`https://api.timezonedb.com/v2.1/get-time-zone?key=${TIMEZONEDB_KEY}&format=json&by=position&lat=${gData[0].lat}&lng=${gData[0].lon}`);
        const tData = await tRes.json();
        res.json({ timezone_id: tData.zoneName });
    } catch(e) { res.status(500).json({ error: "Location resolution failed" }); }
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Orbit Engine Ready!`);
    console.log(`Endpoint: http://localhost:${PORT}`);
});
