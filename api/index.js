const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

const TIMEZONEDB_KEY = 'VW4CCUCGOI2M'; 

// --- CONFIGURATION ---
const INTERNAL_POINTS = { PERFECT: 100, OKAY: 70, STRETCH: 40, PAINFUL: 10, IMPOSSIBLE: -100 };
const MISERY_UNITS = { "Perfect": 0, "Lunch": 1, "Shoulder": 2, "Stretch": 5, "Painful": 10, "Sleeping": 50 };

const POLICIES = {
    "peer_sync": { hostStrict: false, weight: 12 },
    "client_meeting": { hostStrict: true, weight: 12 },
    "all_hands": { hostStrict: false, weight: 7 },
    "urgent_briefing": { hostStrict: true, weight: 7 },
    "culture_chat": { hostStrict: false, weight: 18 },
    "gold_standard": { hostStrict: true, weight: 18 }
};

const HOURS = { WORK_START: 9, WORK_END: 17.5, LUNCH_START: 12, LUNCH_END: 13.5, PAIN_START: 6, PAIN_END: 22 };

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

function calculateSlotScore(utc, locations, hostOffset, viewerOffset, hostZone, viewerZone, policy) {
    const dateObj = new Date(utc);
    const hostTime = (dateObj.getUTCHours() + hostOffset + 24) % 24;
    
    const timeFormatter = (zone) => new Intl.DateTimeFormat("en-US", { 
        timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true 
    });

    // 1. HOST VETO CHECK
    const hostDateLocal = new Date(utc + (hostOffset * 3600000));
    const hostDay = hostDateLocal.getUTCDay();
    
    // Weekend Veto
    if (hostDay === 0 || hostDay === 6) return { host_time: timeFormatter(hostZone).format(dateObj), total_score: -999, status: "red", blockers: ["Weekend"] };

    // Work Hours Veto
    if (policy.hostStrict) {
        if (hostTime < HOURS.WORK_START || hostTime >= HOURS.WORK_END) 
            return { host_time: timeFormatter(hostZone).format(dateObj), total_score: -999, status: "red", blockers: ["Host Veto: Strict 9-5"] };
    } else {
        if (hostTime < HOURS.PAIN_START || hostTime >= HOURS.PAIN_END) 
            return { host_time: timeFormatter(hostZone).format(dateObj), total_score: -999, status: "red", blockers: ["Host Veto: Flex"] };
    }

    // 2. TEAM SCORING
    let totalHappiness = 0, totalMisery = 0, blockers = [], hasDealbreaker = false;

    for (const loc of locations) {
        const localTime = (dateObj.getUTCHours() + loc.offsetVal + 24) % 24;
        const localDay = new Date(utc + (loc.offsetVal * 3600000)).getUTCDay();
        
        let p = 0, m = 0, note = "";

        if (localDay === 0 || localDay === 6) { p = INTERNAL_POINTS.IMPOSSIBLE; m = MISERY_UNITS.Sleeping; hasDealbreaker = true; note = "Weekend"; }
        else if (localTime >= HOURS.WORK_START && localTime < HOURS.WORK_END) {
            if (localTime >= HOURS.LUNCH_START && localTime < HOURS.LUNCH_END) { p = INTERNAL_POINTS.OKAY; m = MISERY_UNITS.Lunch; note = "Lunch"; }
            else { p = INTERNAL_POINTS.PERFECT; m = MISERY_UNITS.Perfect; }
        }
        else if (localTime >= 6 && localTime < 22) { p = INTERNAL_POINTS.PAINFUL; m = MISERY_UNITS.Painful; note = "Painful"; }
        else { p = INTERNAL_POINTS.IMPOSSIBLE; m = MISERY_UNITS.Sleeping; hasDealbreaker = true; note = "Sleep"; }

        totalHappiness += p;
        totalMisery += m;
        if (note) blockers.push(`${loc.timezone}: ${note}`);
    }

    const weightedMisery = totalMisery * policy.weight;
    const finalScore = totalHappiness - weightedMisery;

    return {
        viewer_time: timeFormatter(viewerZone).format(dateObj),
        host_time: timeFormatter(hostZone).format(dateObj),
        total_score: Math.round(finalScore),
        happiness_score: totalHappiness,
        misery_score: totalMisery,
        weight_applied: policy.weight,
        status: (hasDealbreaker || finalScore < 0) ? "red" : (finalScore > 60 ? "green" : "yellow"),
        blockers
    };
}

app.post('/api/optimize', (req, res) => {
    const { date, timezones, host_timezone, viewer_timezone, scenario } = req.body;
    const policy = POLICIES[scenario] || POLICIES.peer_sync;
    
    const hOffset = getOffsetInHours(host_timezone, date);
    const vOffset = getOffsetInHours(viewer_timezone, date);
    const locations = timezones.map(tz => ({ timezone: tz, offsetVal: getOffsetInHours(tz, date) }));

    const startUTC = new Date(date + "T00:00:00Z").getTime();
    const results = [];

    for (let i = 0; i < 24; i++) {
        results.push(calculateSlotScore(startUTC + (i * 3600000), locations, hOffset, vOffset, host_timezone, viewer_timezone, policy));
    }

    // --- SORTED BY TOTAL SCORE (DESCENDING) ---
    const sorted_results = results.sort((a, b) => b.total_score - a.total_score);

    res.json({ 
        metadata: { 
            host: host_timezone, 
            viewer: viewer_timezone, 
            policy: scenario,
            total_slots: sorted_results.length 
        },
        slots: sorted_results 
    });
});

app.listen(3000, () => console.log('🚀 API Running: Port 3000'));
