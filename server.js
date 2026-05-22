require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { query } = require('./src/db/connection');
const { migrate } = require('./src/db/migrate');
const { uploadImage, deleteByUrl, deleteByUrls, extractAssetUrls } = require('./src/utils/r2');
const { fetchBrandLogo } = require('./src/utils/logoFetcher');

const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Staging Banner ───
const STAGING_BANNER_HTML = '<div style="background:#f59e0b;color:#000;text-align:center;padding:4px;font-size:12px;font-weight:700;position:fixed;top:0;left:0;right:0;z-index:99999;">⚠️ STAGING ENVIRONMENT</div><div style="height:28px;"></div>';
let spaHtml = '';
try {
  spaHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  if (process.env.STAGING_BANNER === 'true') {
    spaHtml = spaHtml.replace(/<body([^>]*)>/, '<body$1>' + STAGING_BANNER_HTML);
  }
} catch (e) { /* index.html loaded later via sendFile fallback */ }

// ─── JWT Session Tokens ───
const JWT_SECRET = process.env.JWT_SECRET || (process.env.MAGIC_LINK_SECRET
  ? crypto.createHash('sha256').update('saleo-session:' + process.env.MAGIC_LINK_SECRET).digest('hex')
  : 'dev-jwt-secret');
const JWT_EXPIRY = '30d';

function issueSessionToken(userId, email) {
  return jwt.sign({ userId, email }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifySessionToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// ─── Middleware ───
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// File upload config (in-memory, 10MB max)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Serve static files (index.html, etc.)
app.use(express.static(path.join(__dirname)));

// ═══════════════════════════════════════════════
// SHARED HELPERS (do not modify)
// ═══════════════════════════════════════════════

// Check admin status from ADMIN_EMAILS env var
function isAdmin(email) {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  return adminEmails.includes((email || '').toLowerCase());
}

// Get or create user — upserts, stamps last_login_at, syncs admin flag
async function getOrCreateUser(email) {
  let users = await query('SELECT * FROM users WHERE email = ?', [email]);
  if (users.length === 0) {
    const result = await query(
      'INSERT INTO users (email, is_admin) VALUES (?, ?)',
      [email, isAdmin(email)]
    );
    return { id: result.insertId, email, is_admin: isAdmin(email) };
  }
  // Sync admin status and update last_login_at on each login
  const user = users[0];
  const shouldBeAdmin = isAdmin(email);
  if (user.is_admin !== shouldBeAdmin) {
    await query('UPDATE users SET is_admin = ?, last_login_at = NOW() WHERE id = ?', [shouldBeAdmin, user.id]);
    user.is_admin = shouldBeAdmin;
  } else {
    await query('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
  }
  return user;
}

// ═══════════════════════════════════════════════
// SHARED ROUTES — Auth Config
// ═══════════════════════════════════════════════

// Returns public app configuration for the frontend (Magic key, cookie domain).
// No auth required — the frontend fetches this on load.
app.get('/api/auth/config', (req, res) => {
  res.json({
    magicPublishableKey: process.env.MAGIC_PUBLISHABLE_KEY || process.env.VITE_MAGIC_LINK_KEY || null,
    cookieDomain: process.env.COOKIE_DOMAIN || null,
  });
});

// Check if current user is admin
app.get('/api/is-admin', (req, res) => {
  const email = req.query.email;
  res.json({ isAdmin: isAdmin(email) });
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — Session Auth
// ═══════════════════════════════════════════════

// POST /api/auth/login — exchange email for a long-lived JWT session token
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const ALLOWED_EMAILS = ['aubreykemble@gmail.com'];
    if (!email.endsWith('@salesforce.com') && !ALLOWED_EMAILS.includes(email.toLowerCase())) return res.status(403).json({ error: 'Access restricted to @salesforce.com email addresses' });
    const user = await getOrCreateUser(email);
    const sessionToken = issueSessionToken(user.id, email);
    res.json({ success: true, token: sessionToken, email: user.email });
  } catch (err) {
    console.error('Session login error:', err.message);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// POST /api/auth/validate — check if a JWT session token is still valid
app.post('/api/auth/validate', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });
    const payload = verifySessionToken(token);
    if (!payload || !payload.email) return res.status(401).json({ error: 'Invalid or expired session' });
    const users = await query('SELECT id, email FROM users WHERE id = ? AND email = ?', [payload.userId, payload.email]);
    if (users.length === 0) return res.status(401).json({ error: 'User not found' });
    res.json({ valid: true, email: payload.email });
  } catch (err) {
    console.error('Session validate error:', err.message);
    res.status(401).json({ error: 'Invalid session' });
  }
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — Feedback
// ═══════════════════════════════════════════════

// POST /api/feedback — submit feedback (any user)
app.post('/api/feedback', async (req, res) => {
  try {
    const { name, email, subject, body } = req.body;
    if (!name || !email || !subject || !body) {
      return res.status(400).json({ error: 'All fields are required: name, email, subject, body' });
    }

    const user = await getOrCreateUser(email);

    const result = await query(
      'INSERT INTO feedback (user_id, name, email, subject, body) VALUES (?, ?, ?, ?, ?)',
      [user.id, name.trim(), email.trim(), subject.trim(), body.trim()]
    );

    res.status(201).json({
      feedback: {
        id: result.insertId,
        name: name.trim(),
        email: email.trim(),
        subject: subject.trim(),
        body: body.trim(),
        created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('Failed to submit feedback:', err);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

// GET /api/feedback — list all feedback (admin only)
app.get('/api/feedback', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const rows = await query('SELECT * FROM feedback ORDER BY created_at DESC');
    res.json({ feedback: rows });
  } catch (err) {
    console.error('Failed to fetch feedback:', err);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

// DELETE /api/feedback/:id — delete feedback (admin only)
app.delete('/api/feedback/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const result = await query('DELETE FROM feedback WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Feedback not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete feedback:', err);
    res.status(500).json({ error: 'Failed to delete feedback' });
  }
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — API Keys
// ═══════════════════════════════════════════════

// sleo — Change this to your app's prefix (e.g. "dsw_", "dmb_")
const API_KEY_PREFIX = 'sleo';

function generateApiKeyToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return `${API_KEY_PREFIX}${raw}`;
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

// GET /api/api-keys — list keys for a user
app.get('/api/api-keys', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const keys = await query(
      'SELECT id, name, key_prefix, last_used_at, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
      [user.id]
    );
    res.json({ apiKeys: keys });
  } catch (err) {
    console.error('Failed to list API keys:', err);
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

// POST /api/api-keys — create a new API key
app.post('/api/api-keys', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email || !name || !name.trim()) {
      return res.status(400).json({ error: 'Email and key name are required' });
    }

    const user = await getOrCreateUser(email);
    const rawKey = generateApiKeyToken();
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = rawKey.substring(0, API_KEY_PREFIX.length + 4); // prefix + first 4 hex chars

    await query(
      'INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)',
      [user.id, name.trim(), keyPrefix, keyHash]
    );

    res.status(201).json({
      success: true,
      apiKey: rawKey,
      name: name.trim(),
      keyPrefix,
      message: 'Save this key — it will not be shown again.'
    });
  } catch (err) {
    console.error('Failed to create API key:', err);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

// DELETE /api/api-keys/:id — revoke an API key
app.delete('/api/api-keys/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const result = await query(
      'DELETE FROM api_keys WHERE id = ? AND user_id = ?',
      [req.params.id, user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'API key not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to revoke API key:', err);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — Users (admin only)
// ═══════════════════════════════════════════════

// GET /api/users — admin-only: list all users with asset counts
// NOTE: Update the LEFT JOIN to match your app-specific asset table
app.get('/api/users', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    const rows = await query(`
      SELECT u.id, u.email, u.name, u.created_at, u.last_login_at,
             COUNT(i.id) AS item_count
      FROM users u
      LEFT JOIN items i ON i.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error listing users:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — Gemini Streaming Proxy
// ═══════════════════════════════════════════════

// POST /api/generate — SSE proxy to Gemini API
// Streams from Gemini to keep Heroku's connection alive, then sends assembled response.
app.post('/api/generate', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured on server' });
  }

  const { contents, generationConfig } = req.body;
  if (!contents) {
    return res.status(400).json({ error: 'Missing "contents" in request body' });
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  // Set up SSE headers so Heroku sees data flowing
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send a keepalive comment immediately so Heroku knows we're alive
  res.write(': keepalive\n\n');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 270000);

    const geminiResp = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!geminiResp.ok) {
      const errData = await geminiResp.json().catch(() => ({}));
      const errMsg = errData.error?.message || `Gemini API returned ${geminiResp.status}`;
      res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    // Collect all text parts to send a final assembled response
    let allText = '';
    const reader = geminiResp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') continue;

          try {
            const chunk = JSON.parse(dataStr);
            const textPart = chunk.candidates?.[0]?.content?.parts?.[0]?.text || '';
            if (textPart) {
              allText += textPart;
              res.write(`: chunk received\n\n`);
            }
          } catch (e) {
            // Skip non-JSON lines
          }
        }
      }
    }

    const finalResponse = {
      candidates: [{
        content: {
          parts: [{ text: allText }],
          role: 'model'
        },
        finishReason: 'STOP'
      }]
    };

    res.write(`data: ${JSON.stringify(finalResponse)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[Gemini Proxy] Request timed out');
      res.write(`data: ${JSON.stringify({ error: 'Request timed out. Try a shorter prompt.' })}\n\n`);
    } else {
      console.error('[Gemini Proxy] Error:', err.message);
      res.write(`data: ${JSON.stringify({ error: 'Failed to reach Gemini API' })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ═══════════════════════════════════════════════
// APP-SPECIFIC: File Upload & Document Extraction
// ═══════════════════════════════════════════════

// POST /api/upload — Upload PDF/DOCX, extract text
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { originalname, mimetype, buffer } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    let extractedText = '';

    if (ext === '.pdf' || mimetype === 'application/pdf') {
      const { PDFParse } = require('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      const data = await parser.getText();
      extractedText = data.text;
    } else if (ext === '.docx' || mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      extractedText = result.value;
    } else if (ext === '.doc') {
      // .doc is legacy — try mammoth, it handles some .doc files
      const mammoth = require('mammoth');
      try {
        const result = await mammoth.extractRawText({ buffer });
        extractedText = result.value;
      } catch (e) {
        return res.status(400).json({ error: 'Legacy .doc format not supported. Please convert to .docx or PDF.' });
      }
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Please upload a PDF or DOCX file.' });
    }

    if (!extractedText || extractedText.trim().length === 0) {
      return res.status(400).json({ error: 'Could not extract any text from the file. The file may be empty or contain only images.' });
    }

    // Truncate to ~50k chars to stay within Gemini context limits
    if (extractedText.length > 50000) {
      extractedText = extractedText.substring(0, 50000) + '\n\n[Document truncated — first 50,000 characters shown]';
    }

    const trimmedText = extractedText.trim();

    // Try to find an existing synopsis in the document
    // Match headings like "Synopsis", "Script Synopsis", "Demo Synopsis", etc.
    let synopsis = null;
    const topSection = trimmedText.substring(0, 5000);
    const lines = topSection.split('\n');
    let synopsisStartIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      // Match any line ending with "synopsis" (e.g. "Script Synopsis", "Synopsis:", "Demo Synopsis")
      if (/\bsynopsis[\s:;\-–—]*$/i.test(line)) {
        synopsisStartIdx = i + 1;
        break;
      }
      // Match "Synopsis: some text here" on the same line
      if (/\bsynopsis[\s:;\-–—]+\S/i.test(line)) {
        const afterLabel = line.replace(/^.*?\bsynopsis[\s:;\-–—]*/i, '').trim();
        if (afterLabel.length > 10) {
          const parts = [afterLabel];
          for (let j = i + 1; j < lines.length; j++) {
            const next = lines[j].trim();
            if (!next && parts.length > 0) break;
            if (!next) continue;
            parts.push(next);
          }
          synopsis = parts.join(' ');
          break;
        }
        synopsisStartIdx = i + 1;
        break;
      }
    }

    // Collect the paragraph(s) after the synopsis heading
    if (!synopsis && synopsisStartIdx >= 0) {
      const parts = [];
      let hitContent = false;
      for (let j = synopsisStartIdx; j < lines.length; j++) {
        const line = lines[j].trim();
        if (!line) {
          if (hitContent) break; // blank line after content = end of synopsis
          continue; // skip leading blank lines
        }
        hitContent = true;
        parts.push(line);
      }
      if (parts.length > 0) {
        synopsis = parts.join(' ');
      }
    }

    // If no synopsis found, use Gemini to generate one
    if (!synopsis) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (apiKey) {
        try {
          const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
          const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
          const geminiResp = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: `Read this demo script and write a 1 to 3 sentence synopsis of the demo story. Return ONLY the synopsis text, nothing else.\n\n${trimmedText.substring(0, 30000)}` }] }],
              generationConfig: { maxOutputTokens: 200, temperature: 0.3 }
            })
          });
          if (geminiResp.ok) {
            const geminiData = await geminiResp.json();
            const generated = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
            if (generated) synopsis = generated;
          }
        } catch (e) {
          console.warn('Synopsis generation failed, continuing without:', e.message);
        }
      }
    }

    res.json({
      text: trimmedText,
      synopsis: synopsis || null,
      filename: originalname,
      charCount: trimmedText.length
    });
  } catch (err) {
    console.error('File upload failed:', err);
    res.status(500).json({ error: 'Failed to process file: ' + (err.message || 'Unknown error') });
  }
});

// ═══════════════════════════════════════════════
// IMAGE GENERATION & LOGO ROUTES
// ═══════════════════════════════════════════════

// POST /api/images/logo — Fetch brand logo, copy to R2, return R2 URL
app.post('/api/images/logo', async (req, res) => {
  try {
    const { brand, websiteUrl, viewId } = req.body;
    if (!brand) return res.status(400).json({ error: 'brand is required' });

    const result = await fetchBrandLogo(brand, websiteUrl);
    if (!result.found || !result.url) return res.json(result);

    // Try to download and re-upload to R2; fall back to original URL if R2 fails
    const { getR2Client } = require('./src/utils/r2');
    if (getR2Client()) {
      try {
        const https = require('https');
        const http = require('http');
        const imageBuffer = await new Promise((resolve, reject) => {
          const doFetch = (url, redirects = 3) => {
            const protocol = url.startsWith('https') ? https : http;
            protocol.get(url, { timeout: 10000 }, (resp) => {
              if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && redirects > 0) {
                const loc = resp.headers.location.startsWith('http') ? resp.headers.location : new URL(resp.headers.location, url).href;
                resp.resume();
                return doFetch(loc, redirects - 1);
              }
              if (resp.statusCode !== 200) { resp.resume(); return reject(new Error(`HTTP ${resp.statusCode}`)); }
              const chunks = [];
              resp.on('data', c => chunks.push(c));
              resp.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: resp.headers['content-type'] || 'image/png' }));
              resp.on('error', reject);
            }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
          };
          doFetch(result.url);
        });

        const mimeType = imageBuffer.contentType.split(';')[0].trim();
        const folder = `views/${viewId || 'tmp'}/logo`;
        const slug = brand.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
        const filename = `${slug}-logo`;
        const r2Url = await uploadImage(imageBuffer.buffer.toString('base64'), mimeType, folder, filename);

        console.log(`[Logo] Copied ${result.source} logo for "${brand}" to R2: ${r2Url}`);
        return res.json({ found: true, url: r2Url, source: result.source });
      } catch (r2Err) {
        console.warn(`[Logo] R2 upload failed for "${brand}", using original URL:`, r2Err.message);
      }
    }

    // Fallback: return the original Clearbit/Google URL directly
    console.log(`[Logo] Returning ${result.source} logo for "${brand}" directly: ${result.url}`);
    res.json({ found: true, url: result.url, source: result.source });
  } catch (err) {
    console.error('Logo fetch failed:', err);
    res.status(500).json({ error: 'Logo fetch failed: ' + err.message });
  }
});

// POST /api/images/generate — Generate AI image via Gemini and upload to R2
// Supports all Saleo image types: brand_01, brand_02, brand_03, brand_hero, card_01-07, product_01-04
app.post('/api/images/generate', async (req, res) => {
  try {
    const { brand, brandDesc, industry, imageType, viewId, tone, visualStyle, colorPrimary, colorSecondary, websiteUrl } = req.body;
    if (!brand) return res.status(400).json({ error: 'brand is required' });

    const { GoogleGenAI } = require('@google/genai');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const ai = new GoogleGenAI({ apiKey });

    // Build brand context string for prompts
    const brandCtx = [];
    if (brandDesc) brandCtx.push(`(${brandDesc})`);
    if (industry && industry !== 'Other') brandCtx.push(`in the ${industry} industry`);
    if (tone) brandCtx.push(`Brand tone: ${tone}.`);
    if (visualStyle) brandCtx.push(`Visual style: ${visualStyle}.`);
    if (colorPrimary && colorPrimary !== '#032D60') brandCtx.push(`Primary brand color: ${colorPrimary}.`);
    if (colorSecondary && colorSecondary !== '#0176D3') brandCtx.push(`Secondary brand color: ${colorSecondary}.`);
    const brandInfo = brandCtx.join(' ');

    // Image type definitions: prompt builder and dimensions
    const imageTypes = {
      brand_01: {
        prompt: `Create a professional, wide site banner image for the brand "${brand}" ${brandInfo}. This is a cover image for a website — think sweeping, cinematic, aspirational. Show environments, landscapes, or abstract scenes that evoke the brand's industry and values. No text, no logos, no words. Ultra-wide aspect ratio. Photorealistic, high quality.`,
        w: 1984, h: 481
      },
      brand_02: {
        prompt: `Create a professional site section background image for the brand "${brand}" ${brandInfo}. Subtle, atmospheric, slightly blurred or abstract. Could be a texture, gradient scene, or environmental shot that works well behind overlaid text. No text, no logos, no words. Photorealistic.`,
        w: 1134, h: 552
      },
      brand_03: {
        prompt: `Create another professional site section background image for the brand "${brand}" ${brandInfo}. Different from the previous one — try a different color palette or subject. Subtle, atmospheric, works well as a background behind text content. No text, no logos, no words. Photorealistic.`,
        w: 1134, h: 552
      },
      brand_hero: {
        prompt: `Create a stunning hero section background image for the brand "${brand}" ${brandInfo}. This is the main hero banner — it should be the most visually striking image. Show the essence of the brand through environment, activity, or lifestyle. Bold, aspirational, high impact. No text, no logos, no words. Photorealistic.`,
        w: 1134, h: 552
      },
    };

    // CARD images (01-07): lifestyle shots relating to the brand
    for (let i = 1; i <= 7; i++) {
      const num = String(i).padStart(2, '0');
      const variation = [
        'a lifestyle scene showing people using or enjoying the brand',
        'a close-up detail shot related to the brand experience',
        'an environment or location scene related to the brand',
        'a group or social scene related to the brand lifestyle',
        'an action or activity shot related to the brand',
        'a behind-the-scenes or process shot related to the brand',
        'an aspirational or inspirational scene related to the brand'
      ][i - 1];
      imageTypes[`card_${num}`] = {
        prompt: `Create a professional lifestyle or product shot for the brand "${brand}" ${brandInfo}. This is card image ${i} of 7 for a website — ${variation}. High quality, editorial style photography. No text, no logos, no words. Photorealistic.${i === 1 ? ' This image will overlay on a background, so it should be vibrant and stand out.' : ''}`,
        w: 2551, h: 1524
      };
    }

    // PRODUCT images (01-04): realistic product shots
    for (let i = 1; i <= 4; i++) {
      const num = String(i).padStart(2, '0');
      imageTypes[`product_${num}`] = {
        prompt: `Create a clean, professional product photograph for the brand "${brand}" ${brandInfo}.${websiteUrl ? ` The brand website is ${websiteUrl} — generate a realistic product that this brand would sell.` : ''} This is product ${i} of 4. Show a single realistic product on a clean, minimal background. The product should look like something this brand actually sells. Studio lighting, high-end e-commerce photography style. No text, no logos, no watermarks. Clean white or light gradient background. 400x400 square crop.`,
        w: 400, h: 400
      };
    }

    const typeDef = imageTypes[imageType];
    if (!typeDef) {
      return res.status(400).json({ error: `Unknown imageType: ${imageType}. Valid types: ${Object.keys(imageTypes).join(', ')}` });
    }

    console.log(`[ImageGen] Generating ${imageType} for "${brand}" (${typeDef.w}x${typeDef.h})`);

    // Retry up to 3 attempts for Gemini failures
    let imageBase64 = null;
    let mimeType = 'image/png';
    let lastGenErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-image',
          contents: [{ text: typeDef.prompt }],
          config: { responseModalities: ['TEXT', 'IMAGE'] },
        });

        for (const part of response.candidates?.[0]?.content?.parts || []) {
          if (part.inlineData) {
            imageBase64 = part.inlineData.data;
            mimeType = part.inlineData.mimeType || 'image/png';
            break;
          }
        }
        if (imageBase64) break;
        throw new Error('Gemini did not return an image');
      } catch (genErr) {
        lastGenErr = genErr;
        console.warn(`[ImageGen] ${imageType} attempt ${attempt}/3 failed: ${genErr.message}`);
        if (attempt < 3) await new Promise(r => setTimeout(r, attempt === 1 ? 2000 : 5000));
      }
    }

    if (!imageBase64) {
      return res.status(500).json({ error: `Image generation failed after 3 attempts: ${lastGenErr?.message || 'No image returned'}` });
    }

    // Resize to exact specified dimensions using sharp
    // Two-step: resize to cover the target area, then extract (crop) to exact dims
    const sharp = require('sharp');
    const rawBuffer = Buffer.from(imageBase64, 'base64');
    const metadata = await sharp(rawBuffer).metadata();
    const srcW = metadata.width || 1024;
    const srcH = metadata.height || 1024;

    // Calculate scale factor to cover target dimensions (no padding)
    const scaleX = typeDef.w / srcW;
    const scaleY = typeDef.h / srcH;
    const scale = Math.max(scaleX, scaleY);
    const scaledW = Math.round(srcW * scale);
    const scaledH = Math.round(srcH * scale);

    // Scale up to cover, then crop to exact target size from center
    const resizedBuffer = await sharp(rawBuffer)
      .resize(scaledW, scaledH, { fit: 'fill' })
      .extract({
        left: Math.round((scaledW - typeDef.w) / 2),
        top: Math.round((scaledH - typeDef.h) / 2),
        width: typeDef.w,
        height: typeDef.h
      })
      .jpeg({ quality: 92 })
      .toBuffer();
    const resizedBase64 = resizedBuffer.toString('base64');
    mimeType = 'image/jpeg';

    console.log(`[ImageGen] Resized ${imageType} from ${srcW}×${srcH} → ${typeDef.w}×${typeDef.h}`);

    // Upload to R2
    const folder = `views/${viewId || 'tmp'}/generated`;
    const slug = brand.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const filename = `${slug}-${imageType}`;
    const url = await uploadImage(resizedBase64, mimeType, folder, filename);

    console.log(`[ImageGen] ${imageType} for "${brand}" uploaded: ${url}`);
    res.json({ url, mimeType, imageType });
  } catch (err) {
    console.error('Image generation failed:', err);
    res.status(500).json({ error: 'Image generation failed: ' + err.message });
  }
});

// POST /api/images/persona — Generate a persona headshot via Gemini
app.post('/api/images/persona', async (req, res) => {
  try {
    const { brand, brandDesc, industry, synopsis, personaName: inputPersonaName, viewId } = req.body;
    if (!brand) return res.status(400).json({ error: 'brand is required' });

    const { GoogleGenAI } = require('@google/genai');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const ai = new GoogleGenAI({ apiKey });

    // Step 1: Try to extract a persona from the synopsis using Gemini text
    let personaDesc = '';
    let extractedName = '';
    if (synopsis && synopsis.trim()) {
      try {
        const extractResp = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{ text: `From this demo synopsis, extract two things:
1. The person's name (if one is mentioned). If no name is mentioned, leave it empty.
2. A brief physical description suitable for generating a headshot photo (age range, gender, professional appearance).

If the persona text mentions a specific gender or name that is clearly male (e.g. "John", "Mike", "he/him"), note that the persona is male.
If no specific person is described, infer a likely customer persona for a ${industry || 'business'} brand called "${brand}"${brandDesc ? ` (${brandDesc})` : ''}.

Return ONLY valid JSON with two fields: {"name": "...", "description": "..."}
No markdown fences, no explanation.

Synopsis: ${synopsis}` }],
        });
        const rawText = extractResp.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        try {
          const parsed = JSON.parse(rawText.replace(/```json\s*\n?/g, '').replace(/```\s*$/g, '').trim());
          extractedName = parsed.name || '';
          personaDesc = parsed.description || '';
        } catch (parseErr) {
          personaDesc = rawText;
        }
        console.log(`[Persona] Extracted: name="${extractedName}", desc="${personaDesc}"`);
      } catch (extractErr) {
        console.warn('[Persona] Extraction failed, using fallback:', extractErr.message);
      }
    }

    // Determine persona name and gender
    const finalName = inputPersonaName || extractedName || 'Rachel Morris';
    const inferredGender = inferPersonaGender(finalName);
    const genderDesc = inferredGender === 'female' ? 'woman' : 'man';

    // Fallback: generate a generic persona for the brand/industry
    if (!personaDesc) {
      personaDesc = `A professional-looking ${genderDesc} named ${finalName} who would be a typical customer of ${brand}`;
      if (brandDesc) personaDesc += `, ${brandDesc}`;
      if (industry && industry !== 'Other') personaDesc += `, in the ${industry} industry`;
    }

    // Step 2: Generate headshot image — explicitly include gender
    const imagePrompt = `Generate a professional headshot photo of a ${genderDesc} named ${finalName}. ${personaDesc}. The person should look friendly, confident, and approachable. Clean background, professional lighting, business casual attire. Photorealistic portrait style, shoulders-up framing. No text or watermarks.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [{ text: imagePrompt }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });

    // Extract image
    let imageBase64 = null;
    let mimeType = 'image/png';
    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        imageBase64 = part.inlineData.data;
        mimeType = part.inlineData.mimeType || 'image/png';
        break;
      }
    }

    if (!imageBase64) {
      return res.status(500).json({ error: 'Gemini did not return an image. Try again.' });
    }

    // Upload to R2
    const folder = `views/${viewId || 'tmp'}/persona`;
    const slug = brand.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const filename = `${slug}-persona`;
    const url = await uploadImage(imageBase64, mimeType, folder, filename);

    res.json({ url, mimeType, personaDesc });
  } catch (err) {
    console.error('Persona image generation failed:', err);
    res.status(500).json({ error: 'Persona generation failed: ' + err.message });
  }
});

// POST /api/images/upload — Upload a base64 image to R2
app.post('/api/images/upload', async (req, res) => {
  try {
    const { imageBase64, mimeType, folder, filename } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 is required' });

    const url = await uploadImage(imageBase64, mimeType || 'image/png', folder || 'views/tmp', filename || null);
    res.json({ url });
  } catch (err) {
    console.error('Image upload failed:', err);
    res.status(500).json({ error: 'Image upload failed: ' + err.message });
  }
});

// Infer gender from a first name for persona image generation
function inferPersonaGender(name) {
  const first = (name || '').split(/\s+/)[0].toLowerCase();
  const femaleNames = new Set([
    'rachel','sarah','jessica','jennifer','ashley','amanda','stephanie','nicole','melissa','michelle',
    'elizabeth','emily','lauren','megan','hannah','samantha','katherine','natalie','olivia','sophia',
    'emma','ava','isabella','mia','charlotte','amelia','harper','evelyn','abigail','ella','grace',
    'victoria','lily','chloe','madison','zoe','anna','maria','diana','lisa','karen','susan','nancy',
    'betty','helen','sandra','margaret','donna','carol','ruth','sharon','laura','linda','patricia',
    'barbara','catherine','christine','deborah','janet','debra','andrea','marie','jean','alice',
    'judy','jane','joyce','teresa','ann','gloria','janice','brenda','tammy','tracy','kelly',
    'tina','sara','amy','crystal','kimberly','angela','mary','rosa','julia','alejandra','carmen',
    'fatima','priya','mei','yuki','aiko','nadia','leila','aisha',
  ]);
  const maleNames = new Set([
    'james','john','robert','michael','william','david','richard','joseph','thomas','charles',
    'christopher','daniel','matthew','anthony','mark','donald','steven','paul','andrew','joshua',
    'kenneth','kevin','brian','george','timothy','ronald','edward','jason','jeffrey','ryan',
    'jacob','gary','nicholas','eric','jonathan','stephen','larry','justin','scott','brandon',
    'benjamin','samuel','raymond','gregory','frank','alexander','patrick','jack','dennis','jerry',
    'tyler','aaron','jose','adam','nathan','henry','peter','zachary','douglas','harold','carl',
    'arthur','gerald','roger','keith','lawrence','terry','sean','albert','joe','christian',
    'austin','jesse','ethan','willie','billy','bruce','ralph','roy','louis','eugene','russell',
    'bobby','philip','harry','vincent','carlos','miguel','luis','jorge','pedro','ahmed','raj',
    'omar','yusuf','chen','wei','kenji','hiroshi','mohammed',
  ]);
  if (femaleNames.has(first)) return 'female';
  if (maleNames.has(first)) return 'male';
  return 'female'; // default
}

// GET /api/images/proxy — Proxy-fetch an R2 image to avoid CORS issues
app.get('/api/images/proxy', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'url query param is required' });

    // Only allow proxying our own R2 URLs for security
    const { getPublicUrl } = require('./src/utils/r2');
    const r2Base = getPublicUrl();
    if (!r2Base || !url.startsWith(r2Base)) {
      return res.status(403).json({ error: 'Only R2 asset URLs can be proxied' });
    }

    const https = require('https');
    const http = require('http');

    const imageBuffer = await new Promise((resolve, reject) => {
      const doFetch = (fetchUrl, redirects = 3) => {
        const protocol = fetchUrl.startsWith('https') ? https : http;
        protocol.get(fetchUrl, { timeout: 15000 }, (resp) => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && redirects > 0) {
            const loc = resp.headers.location.startsWith('http') ? resp.headers.location : new URL(resp.headers.location, fetchUrl).href;
            resp.resume();
            return doFetch(loc, redirects - 1);
          }
          if (resp.statusCode !== 200) { resp.resume(); return reject(new Error(`HTTP ${resp.statusCode}`)); }
          const chunks = [];
          resp.on('data', c => chunks.push(c));
          resp.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: resp.headers['content-type'] || 'application/octet-stream' }));
          resp.on('error', reject);
        }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
      };
      doFetch(url);
    });

    res.setHeader('Content-Type', imageBuffer.contentType);
    res.setHeader('Content-Length', imageBuffer.buffer.length);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(imageBuffer.buffer);
  } catch (err) {
    console.error('Image proxy failed:', err);
    res.status(500).json({ error: 'Image proxy failed: ' + err.message });
  }
});

// POST /api/images/delete — Delete an R2 image by URL
app.post('/api/images/delete', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    await deleteByUrl(url);
    res.json({ success: true });
  } catch (err) {
    console.error('Image delete failed:', err);
    res.status(500).json({ error: 'Image delete failed: ' + err.message });
  }
});

// ═══════════════════════════════════════════════
// APP-SPECIFIC ROUTES
// ═══════════════════════════════════════════════
//
// GET  /api/items              — list items for user
// GET  /api/items/:id          — get single item
// POST /api/items              — create item
// PUT  /api/items/:id          — update item
// DELETE /api/items/:id        — delete item
// POST /api/items/:id/share    — share item
// POST /api/items/:id/share/confirm — replace or send new copy

// GET /api/items — list items for a user
app.get('/api/items', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const items = await query(
      `SELECT id, name, shared_by_email, shared_at, created_at, updated_at,
              JSON_UNQUOTE(JSON_EXTRACT(data, '$.images.logo')) AS logo_url
       FROM items WHERE user_id = ? ORDER BY updated_at DESC`,
      [user.id]
    );
    res.json({ items });
  } catch (err) {
    console.error('Failed to list items:', err);
    res.status(500).json({ error: 'Failed to list items' });
  }
});

// GET /api/items/:id — get single item with full data
app.get('/api/items/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const rows = await query(
      'SELECT * FROM items WHERE id = ? AND user_id = ?',
      [req.params.id, user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const item = rows[0];
    // Parse data if it's a string
    if (typeof item.data === 'string') {
      item.data = JSON.parse(item.data);
    }

    res.json({ item });
  } catch (err) {
    console.error('Failed to get item:', err);
    res.status(500).json({ error: 'Failed to get item' });
  }
});

// ─── Server-side image generation (background) ───
// Generates a single image with up to 2 retries on failure
async function generateSingleImage(brand, meta, imageType, itemId, opts = {}) {
  const { GoogleGenAI } = require('@google/genai');
  const sharp = require('sharp');
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const ai = new GoogleGenAI({ apiKey });

  const brandCtx = [];
  if (meta.brand_desc) brandCtx.push(`(${meta.brand_desc})`);
  if (meta.industry && meta.industry !== 'Other') brandCtx.push(`in the ${meta.industry} industry`);
  if (meta.tone) brandCtx.push(`Brand tone: ${meta.tone}.`);
  if (meta.visual_style) brandCtx.push(`Visual style: ${meta.visual_style}.`);
  if (meta.color_primary && meta.color_primary !== '#032D60') brandCtx.push(`Primary brand color: ${meta.color_primary}.`);
  if (meta.color_secondary && meta.color_secondary !== '#0176D3') brandCtx.push(`Secondary brand color: ${meta.color_secondary}.`);
  const brandInfo = brandCtx.join(' ');

  // Build image type definitions (same as in /api/images/generate)
  const imageTypes = {
    brand_01: { prompt: `Create a professional, wide site banner image for the brand "${brand}" ${brandInfo}. This is a cover image for a website — think sweeping, cinematic, aspirational. Show environments, landscapes, or abstract scenes that evoke the brand's industry and values. No text, no logos, no words. Ultra-wide aspect ratio. Photorealistic, high quality.`, w: 1984, h: 481 },
    brand_02: { prompt: `Create a professional site section background image for the brand "${brand}" ${brandInfo}. Subtle, atmospheric, slightly blurred or abstract. Could be a texture, gradient scene, or environmental shot that works well behind overlaid text. No text, no logos, no words. Photorealistic.`, w: 1134, h: 552 },
    brand_03: { prompt: `Create another professional site section background image for the brand "${brand}" ${brandInfo}. Different from the previous one — try a different color palette or subject. Subtle, atmospheric, works well as a background behind text content. No text, no logos, no words. Photorealistic.`, w: 1134, h: 552 },
    brand_hero: { prompt: `Create a stunning hero section background image for the brand "${brand}" ${brandInfo}. This is the main hero banner — it should be the most visually striking image. Show the essence of the brand through environment, activity, or lifestyle. Bold, aspirational, high impact. No text, no logos, no words. Photorealistic.`, w: 1134, h: 552 },
  };
  for (let i = 1; i <= 7; i++) {
    const num = String(i).padStart(2, '0');
    const variation = ['a lifestyle scene showing people using or enjoying the brand','a close-up detail shot related to the brand experience','an environment or location scene related to the brand','a group or social scene related to the brand lifestyle','an action or activity shot related to the brand','a behind-the-scenes or process shot related to the brand','an aspirational or inspirational scene related to the brand'][i - 1];
    imageTypes[`card_${num}`] = { prompt: `Create a professional lifestyle or product shot for the brand "${brand}" ${brandInfo}. This is card image ${i} of 7 for a website — ${variation}. High quality, editorial style photography. No text, no logos, no words. Photorealistic.${i === 1 ? ' This image will overlay on a background, so it should be vibrant and stand out.' : ''}`, w: 2551, h: 1524 };
  }
  for (let i = 1; i <= 4; i++) {
    const num = String(i).padStart(2, '0');
    imageTypes[`product_${num}`] = { prompt: `Create a clean, professional product photograph for the brand "${brand}" ${brandInfo}.${meta.brand_url ? ` The brand website is ${meta.brand_url} — generate a realistic product that this brand would sell.` : ''} This is product ${i} of 4. Show a single realistic product on a clean, minimal background. The product should look like something this brand actually sells. Studio lighting, high-end e-commerce photography style. No text, no logos, no watermarks. Clean white or light gradient background. 400x400 square crop.`, w: 400, h: 400 };
  }

  // Support custom prompt/dimensions via opts, or fall back to hardcoded types
  const typeDef = opts.customPrompt
    ? { prompt: opts.customPrompt, w: opts.w || 1024, h: opts.h || 1024 }
    : imageTypes[imageType];
  if (!typeDef) throw new Error(`Unknown imageType: ${imageType}`);

  // Retry up to 3 attempts
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[BgImageGen] Generating ${imageType} for "${brand}" (attempt ${attempt}/3)`);

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: [{ text: typeDef.prompt }],
        config: { responseModalities: ['TEXT', 'IMAGE'] },
      });

      let imageBase64 = null;
      let mimeType = 'image/png';
      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          imageBase64 = part.inlineData.data;
          mimeType = part.inlineData.mimeType || 'image/png';
          break;
        }
      }
      if (!imageBase64) throw new Error('Gemini did not return an image');

      // Resize to exact dimensions
      const rawBuffer = Buffer.from(imageBase64, 'base64');
      const metadata = await sharp(rawBuffer).metadata();
      const srcW = metadata.width || 1024;
      const srcH = metadata.height || 1024;
      const scaleX = typeDef.w / srcW;
      const scaleY = typeDef.h / srcH;
      const scale = Math.max(scaleX, scaleY);
      const scaledW = Math.round(srcW * scale);
      const scaledH = Math.round(srcH * scale);

      const resizedBuffer = await sharp(rawBuffer)
        .resize(scaledW, scaledH, { fit: 'fill' })
        .extract({
          left: Math.round((scaledW - typeDef.w) / 2),
          top: Math.round((scaledH - typeDef.h) / 2),
          width: typeDef.w,
          height: typeDef.h
        })
        .jpeg({ quality: 92 })
        .toBuffer();

      const folder = `views/${itemId}/generated`;
      const slug = brand.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      const filename = `${slug}-${imageType}`;
      const url = await uploadImage(resizedBuffer.toString('base64'), 'image/jpeg', folder, filename);

      console.log(`[BgImageGen] ${imageType} for "${brand}" uploaded: ${url}`);
      return url;
    } catch (err) {
      lastErr = err;
      console.warn(`[BgImageGen] ${imageType} attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) {
        // Wait before retry: 2s, then 5s
        await new Promise(r => setTimeout(r, attempt === 1 ? 2000 : 5000));
      }
    }
  }
  throw lastErr;
}

// Background job: generate all missing images for an item
async function backgroundGenerateImages(itemId, email) {
  try {
    // Fetch the item
    const items = await query('SELECT * FROM items WHERE id = ?', [itemId]);
    if (items.length === 0) return;
    const item = items[0];
    let data = typeof item.data === 'string' ? JSON.parse(item.data) : (item.data || {});
    const meta = data.metadata || {};
    const brand = meta.brand;
    if (!brand) { console.log(`[BgImageGen] Item ${itemId}: no brand, skipping`); return; }

    // Only auto-generate standard images for Retail industry
    const industry = (meta.industry || '').toLowerCase();
    if (industry !== 'retail') { console.log(`[BgImageGen] Item ${itemId}: industry "${meta.industry}" is not Retail, skipping standard image gen`); return; }

    const images = data.images || {};
    const allTypes = [
      'brand_01', 'brand_02', 'brand_03', 'brand_hero',
      'card_01', 'card_02', 'card_03', 'card_04', 'card_05', 'card_06', 'card_07',
      'product_01', 'product_02', 'product_03', 'product_04'
    ];
    const missing = allTypes.filter(t => !images[t] || !images[t].startsWith('http'));
    if (missing.length === 0) { console.log(`[BgImageGen] Item ${itemId}: all images present`); return; }

    console.log(`[BgImageGen] Item ${itemId}: generating ${missing.length} missing images for "${brand}"`);

    let generated = 0;
    let failed = 0;
    for (const imageType of missing) {
      try {
        const url = await generateSingleImage(brand, meta, imageType, itemId);
        if (!data.images) data.images = {};
        data.images[imageType] = url;
        generated++;

        // Save progress after each image
        await query('UPDATE items SET data = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(data), itemId]);
      } catch (err) {
        console.error(`[BgImageGen] Item ${itemId}: ${imageType} failed after retries: ${err.message}`);
        failed++;
      }
    }

    console.log(`[BgImageGen] Item ${itemId}: done — ${generated} generated, ${failed} failed`);
  } catch (err) {
    console.error(`[BgImageGen] Item ${itemId}: background generation error:`, err.message);
  }
}

// POST /api/images/interpret-prompt — AI interprets a prompt and returns a generation plan (fast, no image gen)
app.post('/api/images/interpret-prompt', async (req, res) => {
  try {
    const { prompt, brand, brandDesc, industry, tone, visualStyle, colorPrimary, colorSecondary, websiteUrl, existingCustomTypes } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });
    if (!brand) return res.status(400).json({ error: 'brand is required' });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const { GoogleGenAI } = require('@google/genai');
    const ai = new GoogleGenAI({ apiKey });

    // Build brand context
    const brandCtx = [];
    if (brandDesc) brandCtx.push(`(${brandDesc})`);
    if (industry && industry !== 'Other') brandCtx.push(`in the ${industry} industry`);
    if (tone) brandCtx.push(`Brand tone: ${tone}.`);
    if (visualStyle) brandCtx.push(`Visual style: ${visualStyle}.`);
    if (colorPrimary && colorPrimary !== '#032D60') brandCtx.push(`Primary brand color: ${colorPrimary}.`);
    if (colorSecondary && colorSecondary !== '#0176D3') brandCtx.push(`Secondary brand color: ${colorSecondary}.`);
    const brandInfo = brandCtx.join(' ');

    const existingGroups = ['brand', 'card', 'product'];
    const customGroups = (existingCustomTypes || []).map(t => t.group).filter((g, i, a) => a.indexOf(g) === i);
    const allGroups = [...existingGroups, ...customGroups];

    const interpretPrompt = `You are a helper that interprets image generation requests for a brand demo platform.

The brand is "${brand}" ${brandInfo}.
${websiteUrl ? `Brand website: ${websiteUrl}` : ''}

Existing image groups: ${allGroups.join(', ')}

The user says: "${prompt}"

The user may request MULTIPLE types of images in a single request (e.g. "4 product images, an email banner, and a mobile hero"). You MUST parse this into a JSON array where EACH distinct type of image is a separate object.

Return a JSON array (NOT an object, an ARRAY) of group objects, one per distinct image type. Each object has:
- count: number of images for this type (1-10, default 1)
- group_name: human-readable group name (e.g. "Email Banners", "Mobile App Heroes", "Product Images"). Use existing group names if the request matches (brand → "Brand Images", card → "Card Images", product → "Product Images").
- group_key: snake_case key for the group (e.g. "email_banner", "mobile_app_hero", "product"). Use existing group keys if the request matches.
- width: image width in pixels for this type
- height: image height in pixels for this type
- image_prompts: array of individual image generation prompts (one per count). Each should be a detailed, professional prompt for an AI image generator. Include the brand name and context. Always end with "No text, no logos, no words. Photorealistic, high quality." Each prompt should be different/varied.

If the user mentions specific dimensions like "600x300", use those. Otherwise use sensible defaults for the type (e.g. product images = 400x400, banners = 1200x400, email banners = 600x300, mobile heroes = 1080x1920, social posts = 1080x1080).

Examples:
- "Generate 4 more product images" → [{"count":4,"group_name":"Product Images","group_key":"product","width":400,"height":400,"image_prompts":["...", "...", "...", "..."]}]
- "Create an email banner at 600x300 and 2 social media posts" → [{"count":1,"group_name":"Email Banners","group_key":"email_banner","width":600,"height":300,"image_prompts":["..."]}, {"count":2,"group_name":"Social Media Posts","group_key":"social_media","width":1080,"height":1080,"image_prompts":["...", "..."]}]

Respond ONLY with a valid JSON array, no markdown, no explanation.`;

    console.log(`[CustomImageGen] Interpreting prompt: "${prompt}"`);
    const interpretResp = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ text: interpretPrompt }],
    });

    let groups;
    try {
      let text = interpretResp.candidates?.[0]?.content?.parts?.[0]?.text || '';
      console.log(`[CustomImageGen] Raw Gemini response: ${text.substring(0, 800)}`);
      text = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      const parsed = JSON.parse(text);
      // Normalize: if AI returned a single object instead of array, wrap it
      groups = Array.isArray(parsed) ? parsed : [parsed];
      console.log(`[CustomImageGen] Parsed ${groups.length} group(s): ${groups.map(g => `${g.count}x ${g.group_name}`).join(', ')}`);
    } catch (e) {
      console.error('[CustomImageGen] Failed to parse interpretation:', e.message);
      return res.status(500).json({ error: 'Failed to interpret prompt. Try rephrasing.' });
    }

    // Compute next available custom key number
    const existingKeys = (existingCustomTypes || []).map(t => t.key);
    let nextNum = 1;
    for (const k of existingKeys) {
      const m = k.match(/^custom_(\d+)$/);
      if (m) nextNum = Math.max(nextNum, parseInt(m[1]) + 1);
    }

    // Count existing items per group (standard + already-created custom)
    const standardGroupCounts = { brand: 4, card: 7, product: 4 };
    const existingGroupCounts = {};
    for (const [gk, cnt] of Object.entries(standardGroupCounts)) {
      existingGroupCounts[gk] = cnt;
    }
    for (const ct of (existingCustomTypes || [])) {
      existingGroupCounts[ct.group] = (existingGroupCounts[ct.group] || 0) + 1;
    }

    // Build the plan across all groups — client will generate images one at a time
    const plan = [];
    for (const group of groups) {
      const count = Math.min(Math.max(group.count || 1, 1), 10);
      const groupName = group.group_name || 'Custom Images';
      const groupKey = (group.group_key || 'custom').replace(/[^a-z0-9_]/g, '_');
      const w = group.width || 1024;
      const h = group.height || 1024;
      const imagePrompts = group.image_prompts || [];

      // Continue numbering from existing items in this group
      const startNum = (existingGroupCounts[groupKey] || 0) + 1;

      for (let i = 0; i < count; i++) {
        const key = `custom_${String(nextNum).padStart(3, '0')}`;
        nextNum++;
        const imgPrompt = imagePrompts[i] || imagePrompts[0] || `Create a professional image for the brand "${brand}" ${brandInfo}. No text, no logos, no words. Photorealistic, high quality.`;
        const num = String(startNum + i).padStart(2, '0');
        const label = `${groupName.toUpperCase().replace(/\s+IMAGES$/i, '')} ${num}`;
        plan.push({ key, label, group: groupKey, w, h, desc: groupName, prompt: imgPrompt });
      }

      // Update count so subsequent groups referencing same key continue correctly
      existingGroupCounts[groupKey] = (existingGroupCounts[groupKey] || 0) + count;
    }

    res.json({ plan });
  } catch (err) {
    console.error('[CustomImageGen] Error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to interpret prompt' });
  }
});

// POST /api/images/regenerate-custom — regenerate a single custom image
app.post('/api/images/regenerate-custom', async (req, res) => {
  try {
    const { key, prompt: imgPrompt, w, h, brand, brandDesc, industry, tone, visualStyle, colorPrimary, colorSecondary, websiteUrl, viewId } = req.body;
    if (!key || !imgPrompt || !brand) return res.status(400).json({ error: 'key, prompt, and brand are required' });

    const meta = { brand_desc: brandDesc, industry, tone, visual_style: visualStyle, color_primary: colorPrimary, color_secondary: colorSecondary, brand_url: websiteUrl };
    const url = await generateSingleImage(brand, meta, key, viewId, { customPrompt: imgPrompt, w: w || 1024, h: h || 1024 });
    res.json({ key, url });
  } catch (err) {
    console.error('[RegenCustom] Error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to regenerate image' });
  }
});

// POST /api/items — create a new item
app.post('/api/items', async (req, res) => {
  try {
    const { email, name, data } = req.body;
    if (!email || !name) {
      return res.status(400).json({ error: 'Missing required fields: email, name' });
    }

    const user = await getOrCreateUser(email);
    const result = await query(
      'INSERT INTO items (user_id, name, data) VALUES (?, ?, ?)',
      [user.id, name.trim(), data ? JSON.stringify(data) : null]
    );

    const itemId = result.insertId;

    // Respond immediately, then kick off background image generation
    res.status(201).json({
      item: {
        id: itemId,
        name: name.trim(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    });

    // Fire-and-forget: generate missing images in background
    const itemData = data || {};
    const meta = itemData.metadata || {};
    console.log(`[POST /api/items] Item ${itemId} created. Brand: "${meta.brand || 'NONE'}". Has metadata: ${!!itemData.metadata}. Keys: ${Object.keys(itemData).join(',')}`);
    if (meta.brand) {
      console.log(`[POST /api/items] Kicking off background image generation for item ${itemId} (brand: ${meta.brand})`);
      backgroundGenerateImages(itemId, email).catch(err => {
        console.error(`[BgImageGen] Uncaught error for item ${itemId}:`, err.message);
      });
    } else {
      console.log(`[POST /api/items] No brand in metadata, skipping background image generation. Data keys: ${Object.keys(itemData).join(',')}, metadata keys: ${Object.keys(meta).join(',')}`);
    }
  } catch (err) {
    console.error('Failed to create item:', err);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

// PUT /api/items/:id — update an item
app.put('/api/items/:id', async (req, res) => {
  try {
    const { email, data, name } = req.body;
    if (!email || !data) {
      return res.status(400).json({ error: 'Email and data required' });
    }

    const user = await getOrCreateUser(email);

    // Verify ownership
    const existing = await query('SELECT * FROM items WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    // Update data and optionally the name
    if (name && typeof name === 'string' && name.trim()) {
      await query(
        'UPDATE items SET name = ?, data = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
        [name.trim(), JSON.stringify(data), req.params.id, user.id]
      );
    } else {
      await query(
        'UPDATE items SET data = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
        [JSON.stringify(data), req.params.id, user.id]
      );
    }

    res.json({ success: true });

    // Check if this update added brand metadata — if so, generate missing images in background
    const meta = data?.metadata || {};
    const images = data?.images || {};
    const allTypes = ['brand_01','brand_02','brand_03','brand_hero','card_01','card_02','card_03','card_04','card_05','card_06','card_07','product_01','product_02','product_03','product_04'];
    const missing = allTypes.filter(t => !images[t] || !images[t].startsWith?.('http'));
    console.log(`[PUT /api/items/${req.params.id}] Brand: "${meta.brand || 'NONE'}". Images present: ${allTypes.length - missing.length}/${allTypes.length}. Missing: ${missing.length}`);

    if (meta.brand && missing.length > 0) {
      console.log(`[PUT /api/items/${req.params.id}] Kicking off background generation for ${missing.length} missing images`);
      backgroundGenerateImages(parseInt(req.params.id), email).catch(err => {
        console.error(`[BgImageGen] Uncaught error for item ${req.params.id}:`, err.message);
      });
    }
  } catch (err) {
    console.error('Failed to update item:', err);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// DELETE /api/items/:id — delete an item (with R2 image cleanup)
app.delete('/api/items/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);

    // Fetch item data first to find R2 images for cleanup
    const items = await query('SELECT * FROM items WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (items.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    // Extract and delete R2 assets from item data
    const itemData = typeof items[0].data === 'string' ? JSON.parse(items[0].data) : items[0].data;
    if (itemData) {
      const assetUrls = extractAssetUrls(itemData);
      if (assetUrls.length > 0) {
        deleteByUrls(assetUrls).catch(err => console.warn('[R2] Item cleanup error:', err.message));
      }
    }

    const result = await query(
      'DELETE FROM items WHERE id = ? AND user_id = ?',
      [req.params.id, user.id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete item:', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// ─── Share Items ───

// Helper: create a shared copy of an item for a recipient
async function createSharedCopy(sourceItem, senderEmail, recipientEmail) {
  const recipientUser = await getOrCreateUser(recipientEmail);

  const copyResult = await query(
    'INSERT INTO items (user_id, name, data, shared_by_email, shared_at) VALUES (?, ?, ?, ?, NOW())',
    [recipientUser.id, sourceItem.name, typeof sourceItem.data === 'string' ? sourceItem.data : JSON.stringify(sourceItem.data), senderEmail]
  );

  return copyResult.insertId;
}

// POST /api/items/:id/share — share an item with another user
app.post('/api/items/:id/share', async (req, res) => {
  try {
    const { email, recipientEmail } = req.body;
    if (!email || !recipientEmail) {
      return res.status(400).json({ error: 'Sender email and recipientEmail are required' });
    }

    if (email.toLowerCase() === recipientEmail.toLowerCase()) {
      return res.status(400).json({ error: 'You cannot share an item with yourself' });
    }

    const sender = await getOrCreateUser(email);

    // Verify sender owns the item
    const items = await query('SELECT * FROM items WHERE id = ? AND user_id = ?', [req.params.id, sender.id]);
    if (items.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const sourceItem = items[0];

    // Check if already shared to this recipient from this item
    const existing = await query(
      'SELECT id, copied_item_id, created_at FROM shared_items WHERE item_id = ? AND sender_user_id = ? AND recipient_email = ?',
      [req.params.id, sender.id, recipientEmail.toLowerCase()]
    );

    if (existing.length > 0) {
      return res.json({
        alreadyShared: true,
        sharedAt: existing[0].created_at,
        copiedItemId: existing[0].copied_item_id,
        shareRecordId: existing[0].id
      });
    }

    // First-time share: create copy and tracking record
    const copiedItemId = await createSharedCopy(sourceItem, email, recipientEmail);

    await query(
      'INSERT INTO shared_items (item_id, sender_user_id, sender_email, recipient_email, copied_item_id) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, sender.id, email.toLowerCase(), recipientEmail.toLowerCase(), copiedItemId]
    );

    res.status(201).json({ success: true, copiedItemId });
  } catch (err) {
    console.error('Failed to share item:', err);
    res.status(500).json({ error: 'Failed to share item' });
  }
});

// POST /api/items/:id/share/confirm — replace or send new copy
app.post('/api/items/:id/share/confirm', async (req, res) => {
  try {
    const { email, recipientEmail, action } = req.body;
    if (!email || !recipientEmail || !action) {
      return res.status(400).json({ error: 'email, recipientEmail, and action are required' });
    }
    if (!['replace', 'copy'].includes(action)) {
      return res.status(400).json({ error: 'action must be "replace" or "copy"' });
    }

    const sender = await getOrCreateUser(email);

    // Verify sender owns the item
    const items = await query('SELECT * FROM items WHERE id = ? AND user_id = ?', [req.params.id, sender.id]);
    if (items.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const sourceItem = items[0];

    if (action === 'replace') {
      // Find existing share record
      const existing = await query(
        'SELECT id, copied_item_id FROM shared_items WHERE item_id = ? AND sender_user_id = ? AND recipient_email = ?',
        [req.params.id, sender.id, recipientEmail.toLowerCase()]
      );

      if (existing.length === 0) {
        return res.status(404).json({ error: 'No previous share found' });
      }

      const copiedId = existing[0].copied_item_id;

      // Update the existing copy with current data
      if (copiedId) {
        await query(
          'UPDATE items SET name = ?, data = ?, shared_by_email = ?, shared_at = NOW(), updated_at = NOW() WHERE id = ?',
          [sourceItem.name, typeof sourceItem.data === 'string' ? sourceItem.data : JSON.stringify(sourceItem.data), email.toLowerCase(), copiedId]
        );
      }

      // Update tracking timestamp
      await query('UPDATE shared_items SET created_at = NOW() WHERE id = ?', [existing[0].id]);

      res.json({ success: true, action: 'replaced', copiedItemId: copiedId });
    } else {
      // Send a new copy
      const copiedItemId = await createSharedCopy(sourceItem, email, recipientEmail);

      await query(
        'INSERT INTO shared_items (item_id, sender_user_id, sender_email, recipient_email, copied_item_id) VALUES (?, ?, ?, ?, ?)',
        [req.params.id, sender.id, email.toLowerCase(), recipientEmail.toLowerCase(), copiedItemId]
      );

      res.status(201).json({ success: true, action: 'copied', copiedItemId });
    }
  } catch (err) {
    console.error('Failed to confirm share:', err);
    res.status(500).json({ error: 'Failed to complete share action' });
  }
});

// ═══════════════════════════════════════════════
// Brand Kit Builder Proxy
// ═══════════════════════════════════════════════

const BRANDKIT_API_URL = process.env.BRANDKIT_BUILDER_URL
  ? `${process.env.BRANDKIT_BUILDER_URL}/api`
  : 'https://brandkit-builder.aubreydemo.com/api';

// GET /api/brandkit-builder/items?email=<user-email> — List brand kits for a user
app.get('/api/brandkit-builder/items', async (req, res) => {
  const apiKey = process.env.BRANDKIT_BUILDER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Brand Kit Builder not configured' });

  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });

  try {
    const resp = await fetch(`${BRANDKIT_API_URL}/items?email=${encodeURIComponent(email)}`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!resp.ok) throw new Error(`Brand Kit Builder responded ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('Brand Kit Builder proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch brand kits' });
  }
});

// GET /api/brandkit-builder/items/:id?email=<user-email> — Get full brand kit data
app.get('/api/brandkit-builder/items/:id', async (req, res) => {
  const apiKey = process.env.BRANDKIT_BUILDER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Brand Kit Builder not configured' });

  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });

  try {
    const resp = await fetch(`${BRANDKIT_API_URL}/items/${req.params.id}?email=${encodeURIComponent(email)}`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!resp.ok) throw new Error(`Brand Kit Builder responded ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('Brand Kit Builder proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch brand kit' });
  }
});

// ═══════════════════════════════════════════════
// Script Builder Proxy
// ═══════════════════════════════════════════════

const SCRIPT_API_URL = process.env.SCRIPTWRITER_URL
  ? `${process.env.SCRIPTWRITER_URL}/api`
  : 'https://scriptwriter.aubreydemo.com/api';

// GET /api/scriptwriter/scripts?email=<user-email> — List scripts for a user
app.get('/api/scriptwriter/scripts', async (req, res) => {
  const apiKey = process.env.SCRIPTWRITER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Scriptwriter not configured' });

  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });

  try {
    const resp = await fetch(`${SCRIPT_API_URL}/scripts?email=${encodeURIComponent(email)}`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!resp.ok) throw new Error(`Scriptwriter responded ${resp.status}`);
    const data = await resp.json();
    // Log first script's keys for debugging name field
    const scripts = data.scripts || [];
    if (scripts.length > 0) {
      console.log('[Scriptwriter] First script keys:', Object.keys(scripts[0]).join(', '));
      console.log('[Scriptwriter] First script sample:', JSON.stringify(scripts[0]).substring(0, 500));
    }
    res.json(data);
  } catch (err) {
    console.error('Scriptwriter proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch scripts' });
  }
});

// GET /api/scriptwriter/scripts/:id?email=<user-email> — Get full script data
app.get('/api/scriptwriter/scripts/:id', async (req, res) => {
  const apiKey = process.env.SCRIPTWRITER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Scriptwriter not configured' });

  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });

  try {
    const resp = await fetch(`${SCRIPT_API_URL}/scripts/${req.params.id}?email=${encodeURIComponent(email)}`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!resp.ok) throw new Error(`Scriptwriter responded ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('Scriptwriter proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch script' });
  }
});

// SPA catch-all — serve index.html for any non-API route (enables /views/:id deep links)
app.get('/{*splat}', (req, res) => {
  if (spaHtml) {
    res.set('Content-Type', 'text/html');
    res.send(spaHtml);
  } else {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

// ═══════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════

async function start() {
  // Run database migrations
  try {
    await migrate();
    console.log('✓ Database ready');
  } catch (err) {
    console.error('⚠️  Database migration failed:', err.message);
    console.warn('  Features requiring a database will not work until JAWSDB_URL is configured');
  }

  const server = app.listen(PORT, () => {
    console.log(`Saleo Builder running on http://localhost:${PORT}`);
    if (!process.env.GEMINI_API_KEY) {
      console.warn('⚠️  GEMINI_API_KEY not set — AI features will not work');
    }
  });

  server.timeout = 300000;
  server.keepAliveTimeout = 300000;
}

start();
