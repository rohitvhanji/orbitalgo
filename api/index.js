// api/index.js
const express = require('express');
const cors = require('cors');

// Initialize Express
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// --- CONFIGURATION ---
const TIMEZONEDB_KEY = 'VW4CCUCGOI2M'; 
const INTERNAL_POINTS = { PERFECT: 100, OKAY: 70, STRETCH: 40, PAINFUL: 10, IMPOSSIBLE: -100 };
const HOURS = { WORK_START: 9, WORK_END: 17, LUNCH_START: 12, LUNCH_END: 13, SHOULDER_START: 8, SHOULDER_END: 18, STRETCH_START: 7, STRETCH_END: 20, PAIN_START: 6, PAIN_END: 22 };

// --- LOGIC HELPERS ---
function getOffsetInHours(timeZone, dateStr) {
    try {
        const date = new Date(dateStr + "T12:00:00Z");
        const format = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" });
        const parts = format.formatToParts(date);
        const val = parts.find(p => p.type === "timeZoneName").value.replace("GMT", "").replace("UTC", "");
        if (!val) return 0;
        const [h, m] = val.split(":").map(Number);
        return h + (h < 0 ? -(m/60||0) : (m/60||0));
    } catch (e) { return null; }
}

function calculateSlotScore(utc, locations, viewerZone) {
    let totalScore = 0, maxScore = 0, blockers = [], hasDealbreaker = false;
    for (const loc of locations) {
        const localDate = new Date(utc + (loc.offsetVal * 3600000));
        const day = localDate.getUTCDay();
        const timeValue = localDate.getUTCHours() + (localDate.getUTCMinutes() / 60);
        let points = 0, note = "";

        if (day === 0 || day === 6) { points = INTERNAL_POINTS.IMPOSSIBLE; note = "Weekend"; hasDealbreaker = true; }
        else {
            if (timeValue >= HOURS.WORK_START && timeValue < HOURS.WORK_END) points = (timeValue >= HOURS.LUNCH_START && timeValue < HOURS.LUNCH_END) ? INTERNAL_POINTS.OKAY : INTERNAL_POINTS.PERFECT;
            else if ((timeValue >= HOURS.SHOULDER_START && timeValue < HOURS.WORK_START) || (timeValue >= HOURS.WORK_END && timeValue < HOURS.SHOULDER_END)) points = INTERNAL_POINTS.OKAY;
            else if ((timeValue >= HOURS.STRETCH_START && timeValue < HOURS.SHOULDER_START) || (timeValue >= HOURS.SHOULDER_END && timeValue < HOURS.STRETCH_END)) { points = INTERNAL_POINTS.STRETCH; note = "Hard"; }
            else if ((timeValue >= HOURS.PAIN_START && timeValue < HOURS.STRETCH_START) || (timeValue >= HOURS.STRETCH_END && timeValue < HOURS.PAIN_END)) { points = INTERNAL_POINTS.PAINFUL; note = "Painful"; }
            else { points = INTERNAL_POINTS.IMPOSSIBLE; note = "Sleeping"; hasDealbreaker = true; }
        }
        totalScore += points; maxScore += INTERNAL_POINTS.PERFECT;
        if (note) blockers.push(`${loc.timezone}: ${note}`);
    }
    const status = (hasDealbreaker || maxScore === 0) ? "red" : ((totalScore/maxScore)*100 >= 80 ? "green" : "yellow");
    let displayTime = "Invalid";
    try { displayTime = new Intl.DateTimeFormat("en-US", { timeZone: viewerZone, hour:'numeric', minute:'2-digit', hour12:true }).format(new Date(utc)); } catch(e){}
    return { utc, display_time: displayTime, score: totalScore, status, blockers };
}

// --- ROUTES ---

// 1. Health Check
app.get('/api/health', (req, res) => {
    res.json({ status: "Orbit Engine Online", env: process.env.VERCEL ? "Vercel" : "Standard Server" });
});

// 2. Resolve API
app.post('/api/resolve', async (req, res) => {
    const { city } = req.body;
    if (!city) return res.status(400).json({ error: "Missing city" });
    try {
        const gRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(city)}`, { headers: {'User-Agent': 'Orbit/1.0'} });
        const gData = await gRes.json();
        if(!gData.length) return res.status(404).json({ error: "City not found" });

        const tRes = await fetch(`https://api.timezonedb.com/v2.1/get-time-zone?key=${TIMEZONEDB_KEY}&format=json&by=position&lat=${gData[0].lat}&lng=${gData[0].lon}`);
        const tData = await tRes.json();
        
        res.json({ status: "OK", timezone_id: tData.zoneName, resolved_name: gData[0].display_name });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// 3. Optimize API
app.post('/api/optimize', (req, res) => {
    const { date, timezones, optimize_for } = req.body;
    if (!date || !timezones) return res.status(400).json({ error: "Missing inputs" });

    const locations = [], errors = [];
    for (const tz of timezones) {
        const off = getOffsetInHours(tz, date);
        if (off === null) errors.push(tz);
        else locations.push({ timezone: tz, offsetVal: off });
    }
    if (errors.length) return res.status(400).json({ error: "Invalid Timezones", invalid_ids: errors });

    const results = [];
    const startUTC = new Date(date + "T00:00:00Z").getTime();
    for (let i = 0; i < 48; i++) results.push(calculateSlotScore(startUTC + (i*30*60000), locations, optimize_for || "UTC"));
    
    res.json({ top_3: results.sort((a,b) => b.score - a.score).filter(r => r.status !== 'red').slice(0,3), all_slots: results });
});


// --- SERVER STARTUP ---
// If running directly (node api/index.js), listen on port 3000
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`🚀 Orbit Server running on http://localhost:${PORT}`));
}

// Export for Vercel Serverless
module.exports = app;
