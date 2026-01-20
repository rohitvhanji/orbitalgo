// ==========================================
// 1. CONFIGURATION & WEIGHTS
// ==========================================
const WEIGHTS = {
  PERFECT: 0,       // 9 AM - 5 PM
  OKAY: 10,         // 8-9 AM, 5-6 PM
  STRETCH: 25,      // 7-8 AM, 6-8 PM
  PAINFUL: 50,      // 6-7 AM, 8-10 PM
  IMPOSSIBLE: 1000, // Sleeping
  WEEKEND: 2000     // Sat/Sun
};

// ==========================================
// 2. THE ALGORITHM
// ==========================================
function calculateSlotScore(utcTimestamp, team) {
  let totalScore = 0;
  let reasons = [];
  
  for (const member of team) {
      const localDate = new Date(utcTimestamp + (member.offset * 3600000));
      const day = localDate.getUTCDay();
      const hour = localDate.getUTCHours();
      const minute = localDate.getUTCMinutes();
      const timeValue = hour + (minute / 60);

      // Rule 1: Weekends
      if (day === 0 || day === 6) {
          totalScore += WEIGHTS.WEEKEND;
      }

      // Rule 2: Hours
      let memberScore = 0;
      let note = "";

      if (timeValue >= 9 && timeValue < 17) {
          memberScore = WEIGHTS.PERFECT;
      } else if ((timeValue >= 8 && timeValue < 9) || (timeValue >= 17 && timeValue < 18)) {
          memberScore = WEIGHTS.OKAY;
      } else if ((timeValue >= 7 && timeValue < 8) || (timeValue >= 18 && timeValue < 20)) {
          memberScore = WEIGHTS.STRETCH;
          note = (timeValue < 12) ? "Early Start" : "Late Stay";
      } else if ((timeValue >= 6 && timeValue < 7) || (timeValue >= 20 && timeValue < 22)) {
          memberScore = WEIGHTS.PAINFUL;
          note = (timeValue < 12) ? "Very Early" : "Night Call";
      } else {
          memberScore = WEIGHTS.IMPOSSIBLE;
          note = "Sleeping";
      }

      // Rule 3: Preferences
      if (member.prefs && member.prefs.includes('night_owl')) {
          if (timeValue >= 20 && timeValue < 24) memberScore = WEIGHTS.OKAY;
          if (timeValue >= 7 && timeValue < 10) memberScore = WEIGHTS.PAINFUL;
      }
      if (member.prefs && member.prefs.includes('early_bird')) {
          if (timeValue >= 6 && timeValue < 9) memberScore = WEIGHTS.PERFECT;
          if (timeValue >= 17 && timeValue < 20) memberScore = WEIGHTS.PAINFUL;
      }

      totalScore += memberScore;
      if (note) reasons.push(`${member.name}: ${note}`);
  }

  return { utc: utcTimestamp, score: totalScore, blockers: reasons };
}

// ==========================================
// 3. THE API HANDLER (Vercel Specific)
// ==========================================
export default function handler(req, res) {
  // Allow CORS so you can test from anywhere
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { date, team } = req.body;

  if (!date || !team) {
    return res.status(400).json({ error: "Missing 'date' or 'team' in body" });
  }

  const results = [];
  const startUTC = new Date(date + "T00:00:00Z").getTime();

  // Check 48 slots (24 hours * 2 slots/hr)
  for (let i = 0; i < 48; i++) {
      const currentSlot = startUTC + (i * 30 * 60000);
      const analysis = calculateSlotScore(currentSlot, team);
      // Only keep reasonable options to save bandwidth
      if (analysis.score < 500) { 
          results.push(analysis);
      }
  }

  // Sort by Best Score
  results.sort((a, b) => a.score - b.score);

  res.status(200).json({ 
    top_3: results.slice(0, 3),
    all_slots: results 
  });
}
