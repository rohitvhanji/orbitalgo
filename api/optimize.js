// ==========================================
// 1. CONFIGURATION (Internal Math)
// ==========================================
const INTERNAL_POINTS = {
  PERFECT: 100,     // Best possible slot
  OKAY: 70,         // Doable (Lunch/Shoulder)
  STRETCH: 40,      // Hard (Early/Late)
  PAINFUL: 10,      // Really hard
  IMPOSSIBLE: -100  // Dealbreaker (Sleeping/Weekend)
};

const HOURS = {
  WORK_START: 9, WORK_END: 17,
  LUNCH_START: 12, LUNCH_END: 13,
  SHOULDER_START: 8, SHOULDER_END: 18,
  STRETCH_START: 7, STRETCH_END: 20,
  PAIN_START: 6, PAIN_END: 22,
};

// ==========================================
// 2. HELPER: Timezone Math
// ==========================================
// Calculates the numeric offset (e.g. -4.0) for a specific date
function getOffsetInHours(timeZone, dateStr) {
    try {
        const date = new Date(dateStr + "T12:00:00Z");
        const format = new Intl.DateTimeFormat("en-US", {
            timeZone,
            timeZoneName: "shortOffset" 
        });
        const parts = format.formatToParts(date);
        const tzPart = parts.find(p => p.type === "timeZoneName");
        
        // Output is like "GMT-4" or "GMT+5:30"
        const offsetString = tzPart.value.replace("GMT", "").replace("UTC", "");
        if (!offsetString) return 0; 
        
        const [hours, minutes] = offsetString.split(":").map(Number);
        const decimal = minutes ? (minutes / 60) : 0;
        return hours + (hours < 0 ? -decimal : decimal);
    } catch (e) {
        return null; // Invalid timezone
    }
}

// Helper: Formats a UTC timestamp into a readable string for a specific zone
function formatLocalTime(utcTimestamp, timeZone) {
    try {
        return new Intl.DateTimeFormat("en-US", {
            timeZone,
            hour: 'numeric',
            minute: '2-digit',
            hour12: true
        }).format(new Date(utcTimestamp));
    } catch (e) {
        return "Invalid Zone";
    }
}

// ==========================================
// 3. THE ENGINE
// ==========================================
function calculateSlotScore(utcTimestamp, locations, viewerTimezone) {
  let totalScore = 0;
  let maxPossibleScore = 0;
  let blockers = [];
  let hasDealbreaker = false; 

  for (const loc of locations) {
      const localDate = new Date(utcTimestamp + (loc.offsetVal * 3600000));
      const day = localDate.getUTCDay();
      const hour = localDate.getUTCHours();
      const minute = localDate.getUTCMinutes();
      const timeValue = hour + (minute / 60);

      let points = 0;
      let note = "";

      // --- LOGIC ---
      if (day === 0 || day === 6) {
          points = INTERNAL_POINTS.IMPOSSIBLE;
          note = "Weekend";
          hasDealbreaker = true;
      }
      else {
          if (timeValue >= HOURS.WORK_START && timeValue < HOURS.WORK_END) {
              if (timeValue >= HOURS.LUNCH_START && timeValue < HOURS.LUNCH_END) points = INTERNAL_POINTS.OKAY;
              else points = INTERNAL_POINTS.PERFECT;
          } 
          else if ((timeValue >= HOURS.SHOULDER_START && timeValue < HOURS.WORK_START) || 
                   (timeValue >= HOURS.WORK_END && timeValue < HOURS.SHOULDER_END)) {
              points = INTERNAL_POINTS.OKAY;
          } 
          else if ((timeValue >= HOURS.STRETCH_START && timeValue < HOURS.SHOULDER_START) || 
                   (timeValue >= HOURS.SHOULDER_END && timeValue < HOURS.STRETCH_END)) {
              points = INTERNAL_POINTS.STRETCH;
              note = (timeValue < 12) ? "Early Start" : "Late Stay";
          } 
          else if ((timeValue >= HOURS.PAIN_START && timeValue < HOURS.STRETCH_START) || 
                   (timeValue >= HOURS.STRETCH_END && timeValue < HOURS.PAIN_END)) {
              points = INTERNAL_POINTS.PAINFUL;
              note = (timeValue < 12) ? "Very Early" : "Night Call";
          } 
          else {
              points = INTERNAL_POINTS.IMPOSSIBLE;
              note = "Sleeping";
              hasDealbreaker = true;
          }
      }

      totalScore += points;
      maxPossibleScore += INTERNAL_POINTS.PERFECT;

      if (note) blockers.push(`${loc.timezone}: ${note}`);
  }

  const status = determineTrafficLight(totalScore, maxPossibleScore, hasDealbreaker);
  const displayTime = formatLocalTime(utcTimestamp, viewerTimezone);

  return { 
    utc: utcTimestamp,
    display_time: displayTime, 
    score: totalScore, 
    status: status, 
    blockers: blockers 
  };
}

function determineTrafficLight(score, maxScore, hasDealbreaker) {
    if (hasDealbreaker) return "red";
    if (maxScore === 0) return "red";
    const percentage = (score / maxScore) * 100;
    if (percentage >= 80) return "green";
    return "yellow";
}

// ==========================================
// 4. API HANDLER
// ==========================================
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // EXPECTED INPUT:
  // { 
  //   "date": "2023-11-01", 
  //   "timezones": ["Asia/Kolkata", "America/New_York"],
  //   "optimize_for": "America/New_York"
  // }
  const { date, timezones, optimize_for } = req.body;

  if (!date || !timezones || !Array.isArray(timezones)) {
    return res.status(400).json({ error: "Missing 'date' or 'timezones' array" });
  }

  const viewerZone = optimize_for || "UTC";

  // 1. PRE-CALCULATE OFFSETS
  const locations = [];
  const errors = [];

  for (const tz of timezones) {
      const offset = getOffsetInHours(tz, date);
      if (offset === null) {
          errors.push(`Invalid Timezone: ${tz}`);
      } else {
          locations.push({ timezone: tz, offsetVal: offset });
      }
  }

  if (errors.length > 0) {
      return res.status(400).json({ error: "Invalid Timezones", details: errors });
  }

  const results = [];
  const startUTC = new Date(date + "T00:00:00Z").getTime();

  // 2. RUN LOOP (48 Slots)
  for (let i = 0; i < 48; i++) {
      const currentSlot = startUTC + (i * 30 * 60000);
      results.push(calculateSlotScore(currentSlot, locations, viewerZone));
  }

  results.sort((a, b) => b.score - a.score);

  res.status(200).json({ 
    top_3: results.filter(r => r.status !== 'red').slice(0, 3), 
    all_slots: results 
  });
}
