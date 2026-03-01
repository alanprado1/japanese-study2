/**
 * 積む — Gemini API Proxy
 * Cloudflare Worker that forwards requests to Gemini, keeping the API key
 * server-side. The key is stored as a Cloudflare secret (GEMINI_API_KEY),
 * never in any file, never visible to the browser.
 *
 * Endpoint:  POST /generate
 * Body:      { prompt: string, temperature?: number, maxOutputTokens?: number }
 * Response:  { text: string }  |  { error: string }
 *
 * Deployed URL example: https://jpStudy-gemini.YOUR-SUBDOMAIN.workers.dev
 */

const GEMINI_MODEL = 'gemini-3-flash-preview';
const GEMINI_API   = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                     GEMINI_MODEL + ':generateContent';

// Allowed origins — add your GitHub Pages / hosting URL here.
// '*' is fine while developing locally; restrict before sharing publicly.
const ALLOWED_ORIGINS = [
  'https://alanprado1.github.io',   // ← replace with your actual GitHub Pages URL
  'http://localhost',                   // local dev (any port)
  'http://127.0.0.1',
  'null',                               // local file:// access (origin is "null")
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(function(o) {
    return origin === o || origin.startsWith(o);
  });
  return {
    'Access-Control-Allow-Origin':  allowed ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Only accept POST /generate
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/generate') {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    // Parse request body
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    if (!body.prompt || typeof body.prompt !== 'string') {
      return new Response(JSON.stringify({ error: 'Missing prompt' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    // Forward to Gemini — key comes from Cloudflare secret, never from the request
    const geminiRes = await fetch(GEMINI_API + '?key=' + env.GEMINI_API_KEY, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: body.prompt }] }],
        generationConfig: {
          temperature:      body.temperature      ?? 0.85,
          maxOutputTokens:  body.maxOutputTokens  ?? 8192,
        },
      }),
    });

    const data = await geminiRes.json();

    // Surface Gemini-level errors clearly
    if (data.error) {
      return new Response(
        JSON.stringify({ error: 'Gemini ' + data.error.code + ': ' + data.error.message }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
      );
    }

    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      return new Response(
        JSON.stringify({ error: 'Unexpected Gemini response', raw: JSON.stringify(data).slice(0, 400) }),
        { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
      );
    }

    return new Response(
      JSON.stringify({ text: data.candidates[0].content.parts[0].text }),
      { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } }
    );
  },
};
