// api/resolve.js
const TIMEZONEDB_KEY = 'VW4CCUCGOI2M'; // Kept secure on server

export default async function handler(req, res)
{
    // 1. CORS Headers (Allow everyone to call this API)
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    // Handle Pre-flight request
    if (req.method === 'OPTIONS')
    {
        res.status(200).end();
        return;
    }

    const { city } = req.body;
    if (!city) return res.status(400).json({ error: "Missing 'city'" });

    try
    {
        // A. Geocoding (OpenStreetMap)
        const geoUrl = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(city)}`;
        const geoRes = await fetch(geoUrl, { headers: { 'User-Agent': 'OrbitApp/1.0' } });
        const geoData = await geoRes.json();

        if (!geoData || geoData.length === 0)
        {
            return res.status(404).json({ error: "City not found" });
        }

        // B. Timezone (TimezoneDB)
        const tzUrl = `https://api.timezonedb.com/v2.1/get-time-zone?key=${TIMEZONEDB_KEY}&format=json&by=position&lat=${geoData[0].lat}&lng=${geoData[0].lon}`;
        const tzRes = await fetch(tzUrl);
        const tzData = await tzRes.json();

        if (tzData.status !== 'OK')
        {
            return res.status(500).json({ error: "Timezone service failed" });
        }

        return res.status(200).json({
            status: "OK",
            input: city,
            resolved_name: geoData[0].display_name,
            timezone_id: tzData.zoneName, // e.g., "Asia/Kolkata"
            gmt_offset: tzData.gmtOffset / 3600
        });

    } catch (e)
    {
        return res.status(500).json({ error: e.message });
    }
}
