// Private helper for the Plank Tracker AI coach.
// Holds the Gemini key (env GEMINI_API_KEY), so the key never reaches the public page.
const http = require('http');

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_FRAMES = 12;
const MAX_QUESTION_CHARS = 500;
const PER_IP_PER_HOUR = Number(process.env.PER_IP_PER_HOUR || 20);
const PER_DAY = Number(process.env.PER_DAY || 200);

const ipHits = new Map();
let day = new Date().toDateString();
let dayCount = 0;

function allowRequest(ip) {
  const today = new Date().toDateString();
  if (today !== day) { day = today; dayCount = 0; }
  if (dayCount >= PER_DAY) return false;
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter(t => now - t < 3600e3);
  if (hits.length >= PER_IP_PER_HOUR) { ipHits.set(ip, hits); return false; }
  hits.push(now);
  ipHits.set(ip, hits);
  dayCount++;
  return true;
}

const SYSTEM_PROMPT = `You are a friendly, encouraging plank and push-up form coach in the Plank Tracker app.
You get several photos taken during one set, in time order, with the time (seconds) and a camera measurement for each.
The measurement "hips" says whether the hips were in line with shoulders and ankles, too low (sagging) or too high (piking). It is a rough estimate, so trust the photos first.
Rules:
- Reply in plain text, no markdown symbols, at most 120 words.
- For a first review use three short parts: "Good:", "Needs work:" (name the time when it happened), "Try next time:" (one single fix).
- For follow-up questions answer directly and briefly.
- Only mention photos if photos were given. Only talk about exercise form. If a photo does not show a person doing the exercise, say so kindly.
- Do not give medical diagnoses. If the user mentions pain, suggest stopping and seeing a professional.`;

function send(res, code, body, origin) {
  const headers = { 'Content-Type': 'application/json' };
  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
  }
  res.writeHead(code, headers);
  res.end(code === 204 ? undefined : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY_BYTES) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function buildParts(body) {
  const exercise = body.exercise === 'Push-ups' ? 'Push-ups' : 'Plank';
  const question = String(body.question || '').slice(0, MAX_QUESTION_CHARS);
  const frames = Array.isArray(body.frames) ? body.frames.slice(0, MAX_FRAMES) : [];
  const parts = [{ text: `Exercise: ${exercise}. Total time done: ${Number(body.seconds) || 0} seconds.\n` +
    (question ? `User question: ${question}` : 'Give the first review of this set.') }];
  for (const f of frames) {
    const img = String(f.img || '');
    if (!/^[A-Za-z0-9+/=]+$/.test(img) || img.length > 400000) continue;
    parts.push({ text: `Photo at ${Number(f.t) || 0}s, camera says hips: ${['ok', 'sagging', 'piking'].includes(f.hips) ? f.hips : 'unknown'}` });
    parts.push({ inline_data: { mime_type: 'image/jpeg', data: img } });
  }
  return { parts, photos: parts.filter(p => p.inline_data).length };
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const originOk = origin && ALLOWED_ORIGINS.includes(origin);
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (!originOk) return send(res, 403, { error: 'forbidden' });
  if (req.method === 'OPTIONS') return send(res, 204, {}, origin);
  if (req.method !== 'POST' || req.url !== '/coach') return send(res, 404, { error: 'not_found' }, origin);
  if (!API_KEY) return send(res, 500, { error: 'not_configured' }, origin);
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!allowRequest(ip)) return send(res, 429, { error: 'rate_limited' }, origin);

  try {
    const body = JSON.parse(await readBody(req));
    const { parts, photos } = buildParts(body);
    if (photos === 0 && !body.question) return send(res, 400, { error: 'no_photos' }, origin);
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: 800, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } }
      })
    });
    if (!r.ok) { console.error('gemini status', r.status); return send(res, 502, { error: 'upstream' }, origin); }
    const data = await r.json();
    const reply = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
    return send(res, 200, { reply: reply || 'I could not read that set. Try again!' }, origin);
  } catch (e) {
    const code = e.message === 'too_large' ? 413 : 400;
    return send(res, code, { error: e.message === 'too_large' ? 'too_large' : 'bad_request' }, origin);
  }
});

server.listen(PORT, () => console.log('coach-api listening on ' + PORT));
