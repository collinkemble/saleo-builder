require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { query, getPool, isPostgres } = require('./src/db/connection');
const { migrate } = require('./src/db/migrate');
const { uploadImage, deleteByUrl, deleteByUrls, extractAssetUrls, urlToKey, assertNoEmbeddedImages } = require('./src/utils/storage');
const saleo = require('./src/services/saleo');

// Only delete our own (views/) files that no OTHER item still references.
// Shared copies point at the same image URLs, so deleting blindly would break the recipient's copy.
async function unreferencedUrls(urls, excludeItemId) {
  const out = [];
  for (const url of urls) {
    const key = urlToKey(url);
    if (!key) continue;
    const textCol = isPostgres ? 'data::text' : 'CAST(data AS CHAR)';
    const rows = await query(`SELECT id FROM items WHERE id <> ? AND ${textCol} LIKE ? LIMIT 1`, [excludeItemId || 0, `%${key}%`]);
    if (rows.length === 0) out.push(url);
  }
  return out;
}
const { fetchBrandLogo } = require('./src/utils/logoFetcher');

const fs = require('fs');

// ─── Gemini API: Retry + Fallback Model Chain ───
// Primary model from env var, with automatic fallback to alternate models on 503/429/500
const GEMINI_FALLBACK_MODELS = ['gemini-3.6-flash', 'gemini-3.5-flash'];

/**
 * Call Gemini API with retry + model fallback (non-streaming, direct HTTP).
 * Use this for simple text generation calls.
 */
async function callGeminiWithRetry({ prompt, generationConfig = {}, timeoutMs = 270000, maxRetries = 3 }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const primaryModel = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
  const modelsToTry = [primaryModel, ...GEMINI_FALLBACK_MODELS.filter(m => m !== primaryModel)];

  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig,
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (resp.ok) {
          const data = await resp.json();
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          return { text, model };
        }

        if (resp.status !== 503 && resp.status !== 429 && resp.status !== 500) {
          const errData = await resp.json().catch(() => ({}));
          throw new Error(errData.error?.message || `Gemini API returned ${resp.status}`);
        }

        console.warn(`[Gemini] ${model} attempt ${attempt}/${maxRetries} got ${resp.status}, retrying...`);
        if (attempt < maxRetries) {
          await new Promise(r => setTimeout(r, attempt * 2000));
        }
      } catch (err) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
          console.warn(`[Gemini] ${model} attempt ${attempt}/${maxRetries} timed out`);
          if (attempt < maxRetries) await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }
        throw err;
      }
    }
    console.warn(`[Gemini] ${model} exhausted ${maxRetries} retries, trying next model...`);
  }
  throw new Error('All Gemini models failed after retries');
}

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Staging Banner ───
const STAGING_BANNER_HTML = '<div style="background:#f59e0b;color:#000;text-align:center;padding:4px;font-size:12px;font-weight:700;position:fixed;top:0;left:0;right:0;z-index:99999;">\u26a0\ufe0f STAGING ENVIRONMENT</div><div style="height:28px;"></div>';
let spaHtml = '';
try {
  spaHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
  if (process.env.STAGING_BANNER === 'true') {
    spaHtml = spaHtml.replace(/<body([^>]*)>/, '<body$1>' + STAGING_BANNER_HTML);
  }
} catch (e) { /* index.html loaded later via sendFile fallback */ }

// Browser-facing links need .herokuapp-internal.com so users can reach them via VPN/SSO proxy.
function toBrowserUrl(url) {
  if (!url) return url;
  return url.replace(/\.herokuapp\.com\b/, '.herokuapp-internal.com');
}

// ─── Dynamic App URLs (env-driven for staging/prod) ───
const APP_URL_MAP = {
  'https://demoforge.aubreydemo.com':        toBrowserUrl(process.env.DEMOFORGE_URL)        || 'https://demoforge.aubreydemo.com',
  'https://brandkit-builder.aubreydemo.com': toBrowserUrl(process.env.BRANDKIT_BUILDER_URL) || 'https://brandkit-builder.aubreydemo.com',
  'https://deep-research.aubreydemo.com':     toBrowserUrl(process.env.DEEP_RESEARCH_URL)    || 'https://deep-research.aubreydemo.com',
  'https://scriptwriter.aubreydemo.com':     toBrowserUrl(process.env.SCRIPTWRITER_URL)     || 'https://scriptwriter.aubreydemo.com',
  'https://org-builder.aubreydemo.com':      toBrowserUrl(process.env.ORGBUILDER_URL)       || 'https://org-builder.aubreydemo.com',
  'https://slide-generator.aubreydemo.com':  toBrowserUrl(process.env.SLIDE_GENERATOR_URL)  || 'https://slide-generator.aubreydemo.com',
  'https://installer.aubreydemo.com':        toBrowserUrl(process.env.INSTALLER_URL)        || 'https://installer.aubreydemo.com',
  'https://pocketsic.aubreydemo.com':        toBrowserUrl(process.env.POCKETSIC_URL)        || 'https://pocketsic.aubreydemo.com',
  'https://saleo-builder.aubreydemo.com':    toBrowserUrl(process.env.SALEOBUILDER_URL)     || 'https://saleo-builder.aubreydemo.com',
  'https://video-builder.aubreydemo.com':    toBrowserUrl(process.env.VIDEO_BUILDER_URL)    || 'https://video-builder.aubreydemo.com',
  'https://leave-behind-generator.aubreydemo.com': toBrowserUrl(process.env.LEAVE_BEHIND_URL) || 'https://leave-behind-generator.aubreydemo.com',
};
if (spaHtml) {
  for (const [prodUrl, envUrl] of Object.entries(APP_URL_MAP)) {
    spaHtml = spaHtml.replaceAll(prodUrl, envUrl);
  }
}

// ─── JWT Session Tokens ───
const JWT_SECRET = process.env.JWT_SECRET || (process.env.SESSION_SECRET
  ? crypto.createHash('sha256').update('saleo-session:' + process.env.SESSION_SECRET).digest('hex')
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

// Force HTTPS in production (Heroku sets x-forwarded-proto)
app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// File upload config (in-memory, 10MB max)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Serve static files (index.html, etc.)
app.use(express.static(path.join(__dirname), { index: false }));

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
  // Normalize email to lowercase — PostgreSQL string comparisons are case-sensitive
  const normalizedEmail = (email || '').trim().toLowerCase();
  let users = await query('SELECT * FROM users WHERE email = ?', [normalizedEmail]);
  if (users.length === 0) {
    const result = await query(
      'INSERT INTO users (email, is_admin) VALUES (?, ?)',
      [normalizedEmail, isAdmin(normalizedEmail)]
    );
    return { id: result.insertId, email: normalizedEmail, is_admin: isAdmin(normalizedEmail) };
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

app.get('/api/auth/config', async (req, res) => {
  const rawSsoEmail = req.headers['x-forwarded-user'];
  const ssoEmail = rawSsoEmail ? rawSsoEmail.trim().toLowerCase() : null;
  let ssoSessionToken = null;
  if (ssoEmail) {
    let users = await query('SELECT * FROM users WHERE email = ?', [ssoEmail]);
    let user;
    if (users.length === 0) {
      const result = await query('INSERT INTO users (email, name) VALUES (?, ?)', [ssoEmail, ssoEmail.split('@')[0]]);
      user = { id: result.insertId, email: ssoEmail };
    } else {
      user = users[0];
    }
    const secret = process.env.JWT_SECRET || 'dev-secret';
    ssoSessionToken = jwt.sign(
      { userId: user.id, email: ssoEmail },
      secret,
      { expiresIn: '7d', subject: `saleobuilder-session:${user.id}` }
    );
  }
  res.json({
    cookieDomain: process.env.COOKIE_DOMAIN || null,
    ssoSessionToken: ssoSessionToken || null,
    ssoEmail: ssoEmail || null,
  });
});

app.get('/api/is-admin', (req, res) => {
  const email = req.query.email;
  res.json({ isAdmin: isAdmin(email) });
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — Session Auth
// ═══════════════════════════════════════════════

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
        id: result.insertId, name: name.trim(), email: email.trim(),
        subject: subject.trim(), body: body.trim(), created_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('Failed to submit feedback:', err);
    res.status(500).json({ error: 'Failed to submit feedback' });
  }
});

app.get('/api/feedback', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) return res.status(403).json({ error: 'Admin access required' });
    const rows = await query('SELECT * FROM feedback ORDER BY created_at DESC');
    res.json({ feedback: rows });
  } catch (err) {
    console.error('Failed to fetch feedback:', err);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

app.delete('/api/feedback/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) return res.status(403).json({ error: 'Admin access required' });
    const result = await query('DELETE FROM feedback WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Feedback not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete feedback:', err);
    res.status(500).json({ error: 'Failed to delete feedback' });
  }
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — API Keys
// ═══════════════════════════════════════════════

const API_KEY_PREFIX = 'sleo';

function generateApiKeyToken() {
  const raw = crypto.randomBytes(32).toString('hex');
  return `${API_KEY_PREFIX}${raw}`;
}

function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

app.get('/api/api-keys', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!isAdmin(email)) return res.status(403).json({ error: 'Admin access required' });
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

app.post('/api/api-keys', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email || !name || !name.trim()) return res.status(400).json({ error: 'Email and key name are required' });
    if (!isAdmin(email)) return res.status(403).json({ error: 'Admin access required' });
    const user = await getOrCreateUser(email);
    const rawKey = generateApiKeyToken();
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = rawKey.substring(0, API_KEY_PREFIX.length + 4);
    await query(
      'INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)',
      [user.id, name.trim(), keyPrefix, keyHash]
    );
    res.status(201).json({
      success: true, apiKey: rawKey, name: name.trim(), keyPrefix,
      message: 'Save this key \u2014 it will not be shown again.'
    });
  } catch (err) {
    console.error('Failed to create API key:', err);
    res.status(500).json({ error: 'Failed to create API key' });
  }
});

app.delete('/api/api-keys/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });
    if (!isAdmin(email)) return res.status(403).json({ error: 'Admin access required' });
    const user = await getOrCreateUser(email);
    const result = await query('DELETE FROM api_keys WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'API key not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to revoke API key:', err);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

// ═══════════════════════════════════════════════
// SHARED ROUTES — Users (admin only)
// ═══════════════════════════════════════════════

app.get('/api/users', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) return res.status(403).json({ error: 'Admin access required' });
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

app.get('/api/users/:userId/items', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email || !isAdmin(email)) return res.status(403).json({ error: 'Admin access required' });
    const rows = await query(
      'SELECT id, name, created_at, updated_at FROM items WHERE user_id = ? ORDER BY created_at DESC',
      [req.params.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error listing user items:', err);
    res.status(500).json({ error: 'Failed to list user items' });
  }
});

// ═══════════════════════════════════════════════
// APP-SPECIFIC: Version
// ═══════════════════════════════════════════════

app.get('/api/version', (req, res) => {
  res.json({ version: '2.2.0', app: 'saleo-builder', mode: 'saleo-api' });
});

// ═══════════════════════════════════════════════
// APP-SPECIFIC: File Upload & Document Extraction
// ═══════════════════════════════════════════════

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

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
      return res.status(400).json({ error: 'Could not extract any text from the file.' });
    }

    if (extractedText.length > 50000) {
      extractedText = extractedText.substring(0, 50000) + '\n\n[Document truncated]';
    }

    const trimmedText = extractedText.trim();

    // Try to find an existing synopsis in the document
    let synopsis = null;
    const topSection = trimmedText.substring(0, 5000);
    const lines = topSection.split('\n');
    let synopsisStartIdx = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (/\bsynopsis[\s:;\-\u2013\u2014]*$/i.test(line)) { synopsisStartIdx = i + 1; break; }
      if (/\bsynopsis[\s:;\-\u2013\u2014]+\S/i.test(line)) {
        const afterLabel = line.replace(/^.*?\bsynopsis[\s:;\-\u2013\u2014]*/i, '').trim();
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

    if (!synopsis && synopsisStartIdx >= 0) {
      const parts = [];
      let hitContent = false;
      for (let j = synopsisStartIdx; j < lines.length; j++) {
        const line = lines[j].trim();
        if (!line) { if (hitContent) break; continue; }
        hitContent = true;
        parts.push(line);
      }
      if (parts.length > 0) synopsis = parts.join(' ');
    }

    if (!synopsis) {
      try {
        const result = await callGeminiWithRetry({
          prompt: `Read this demo script and write a 1 to 3 sentence synopsis of the demo story. Return ONLY the synopsis text, nothing else.\n\n${trimmedText.substring(0, 30000)}`,
          generationConfig: { maxOutputTokens: 200, temperature: 0.3 }
        });
        if (result.text?.trim()) synopsis = result.text.trim();
      } catch (e) {
        console.warn('Synopsis generation failed, continuing without:', e.message);
      }
    }

    res.json({ text: trimmedText, synopsis: synopsis || null, filename: originalname, charCount: trimmedText.length });
  } catch (err) {
    console.error('File upload failed:', err);
    res.status(500).json({ error: 'Failed to process file: ' + (err.message || 'Unknown error') });
  }
});

// ═══════════════════════════════════════════════
// APP-SPECIFIC: Logo & Persona Image Routes
// ═══════════════════════════════════════════════

// POST /api/images/logo — Fetch brand logo, upload to S3, return URL
app.post('/api/images/logo', async (req, res) => {
  try {
    const { brand, websiteUrl, viewId } = req.body;
    if (!brand) return res.status(400).json({ error: 'brand is required' });

    const result = await fetchBrandLogo(brand, websiteUrl);
    if (!result.found || !result.url) return res.json(result);

    // Try to download and re-upload to storage
    const { getR2Client } = require('./src/utils/storage');
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
        const storageUrl = await uploadImage(imageBuffer.buffer.toString('base64'), mimeType, folder, filename);

        console.log(`[Logo] Copied ${result.source} logo for "${brand}" to storage: ${storageUrl}`);
        return res.json({ found: true, url: storageUrl, source: result.source });
      } catch (storageErr) {
        console.warn(`[Logo] Storage upload failed for "${brand}", using original URL:`, storageErr.message);
      }
    }

    console.log(`[Logo] Returning ${result.source} logo for "${brand}" directly: ${result.url}`);
    res.json({ found: true, url: result.url, source: result.source });
  } catch (err) {
    console.error('Logo fetch failed:', err);
    res.status(500).json({ error: 'Logo fetch failed: ' + err.message });
  }
});

// POST /api/images/persona — Generate a persona headshot via Gemini
app.post('/api/images/persona', async (req, res) => {
  try {
    const { brand, brandDesc, industry, synopsis, personaName: inputPersonaName, viewId, personaImageUrl } = req.body;
    if (!brand) return res.status(400).json({ error: 'brand is required' });

    // If DemoForge passed a persona image URL, use it directly
    if (personaImageUrl) {
      console.log(`[Persona] Using provided persona image URL for "${brand}": ${personaImageUrl}`);
      return res.json({ url: personaImageUrl, source: 'provided' });
    }

    const { GoogleGenAI } = require('@google/genai');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const ai = new GoogleGenAI({ apiKey });

    // Step 1: Extract persona from synopsis
    let personaDesc = '';
    let extractedName = '';
    if (synopsis && synopsis.trim()) {
      try {
        const extractResp = await ai.models.generateContent({
          model: process.env.GEMINI_MODEL || 'gemini-3.7-flash',
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
      } catch (extractErr) {
        console.warn('[Persona] Extraction failed, using fallback:', extractErr.message);
      }
    }

    const finalName = inputPersonaName || extractedName || 'Rachel Morris';
    const inferredGender = inferPersonaGender(finalName);
    const genderDesc = inferredGender === 'female' ? 'woman' : 'man';

    if (!personaDesc) {
      personaDesc = `A professional-looking ${genderDesc} named ${finalName} who would be a typical customer of ${brand}`;
      if (brandDesc) personaDesc += `, ${brandDesc}`;
      if (industry && industry !== 'Other') personaDesc += `, in the ${industry} industry`;
    }

    const imagePrompt = `Generate a professional headshot photo of a ${genderDesc} named ${finalName}. ${personaDesc}. The person should look friendly, confident, and approachable. Clean background, professional lighting, business casual attire. Photorealistic portrait style, shoulders-up framing. No text or watermarks.`;

    const response = await ai.models.generateContent({
      model: process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
      contents: [{ text: imagePrompt }],
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

    if (!imageBase64) return res.status(500).json({ error: 'Gemini did not return an image. Try again.' });

    // Upload to storage
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

// GET /api/images/proxy — Proxy-fetch an image to avoid CORS issues
app.get('/api/images/proxy', async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'url query param is required' });

    const { getPublicUrl } = require('./src/utils/storage');
    const storageBase = getPublicUrl();
    if (!storageBase || !url.startsWith(storageBase)) {
      return res.status(403).json({ error: 'Only storage asset URLs can be proxied' });
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

// POST /api/images/delete — Delete a storage image by URL
app.post('/api/images/delete', async (req, res) => {
  try {
    const { url, itemId } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    const [safe] = await unreferencedUrls([url], itemId);
    if (safe) await deleteByUrl(safe);
    res.json({ success: true, deleted: !!safe });
  } catch (err) {
    console.error('Image delete failed:', err);
    res.status(500).json({ error: 'Image delete failed: ' + err.message });
  }
});

// ═══════════════════════════════════════════════
// APP-SPECIFIC: Saleo API Routes
// ═══════════════════════════════════════════════

// GET /api/saleo/status — Check if Saleo API is configured + test connection
app.get('/api/saleo/status', async (req, res) => {
  const configured = saleo.isConfigured();
  if (!configured) return res.json({ configured: false });

  // Quick diagnostic: try to call the API
  if (req.query.test === 'true') {
    try {
      const demo = await saleo.findGoldenDemo();
      return res.json({ configured: true, connected: true, goldenDemo: demo.name, demoId: demo.id });
    } catch (err) {
      console.error('[Saleo] Connection test failed:', err.message);
      return res.json({ configured: true, connected: false, error: err.message });
    }
  }

  res.json({ configured: true });
});

// GET /api/saleo/templates — Find the golden demo template
app.get('/api/saleo/templates', async (req, res) => {
  try {
    const demo = await saleo.findGoldenDemo();
    res.json({ demo: { id: demo.id, name: demo.name } });
  } catch (err) {
    console.error('Failed to find golden demo:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/saleo/tokens/:demoId — Get text tokens for a demo
app.get('/api/saleo/tokens/:demoId', async (req, res) => {
  try {
    const result = await saleo.getTokens(req.params.demoId);
    // Saleo API returns a flat array of tokens, wrap it for the frontend
    const tokens = Array.isArray(result) ? result : (result.tokens || result.data || []);
    console.log(`[Saleo] get_demo_tokens returned ${tokens.length} tokens for ${req.params.demoId}`);
    res.json({ tokens });
  } catch (err) {
    console.error('Failed to get tokens:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/saleo/generate-values — Use Gemini to fill token values (SSE to avoid Heroku timeout)
app.post('/api/saleo/generate-values', async (req, res) => {
  // Use SSE to keep connection alive while Gemini processes 102 tokens
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': keepalive\n\n');

  // Send keepalive every 10s to prevent Heroku H12 timeout
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 10000);

  try {
    const { brand, industry, brandDesc, synopsis, tokens, language } = req.body;
    if (!brand || !tokens || !Array.isArray(tokens)) {
      res.write(`data: ${JSON.stringify({ error: 'brand and tokens[] are required' })}\n\n`);
      res.write('data: [DONE]\n\n');
      clearInterval(keepalive);
      return res.end();
    }

    // Build compact prompt
    const tokenList = tokens.map(t => {
      const id = t.tokenId || t.id;
      const label = (t.name || t.label || id || '').replace(/"/g, '');
      return `{"id":"${id}","label":"${label.substring(0, 60)}"}`;
    }).join(',');

    const langInstr = language && language !== 'English' ? `\nIMPORTANT: Generate ALL values in ${language}.` : '';

    const prompt = `Generate personalized Saleo demo token values for "${brand}" (${industry || 'General'}${brandDesc ? ', ' + brandDesc.substring(0, 100) : ''}).

For each token, generate a realistic value matching the label's implied type. Company names → "${brand}", currency → realistic figures, percentages → realistic metrics, person names → realistic names, etc.${langInstr}
${synopsis ? 'Synopsis: ' + synopsis.substring(0, 300) : ''}

Tokens: [${tokenList}]

Return ONLY: {"tokenValues":[{"tokenId":"...","value":"..."},...]}`

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) throw new Error('GEMINI_API_KEY not configured');
    const model = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

    console.log(`[Saleo] Calling Gemini (${model}) with ${tokens.length} tokens for "${brand}"...`);

    const geminiResp = await Promise.race([
      fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
        }),
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini timed out (120s)')), 120000)),
    ]);

    if (!geminiResp.ok) {
      const errBody = await geminiResp.text().catch(() => '');
      throw new Error(`Gemini API returned ${geminiResp.status}: ${errBody.substring(0, 200)}`);
    }

    let geminiData = await geminiResp.json();
    let rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    console.log(`[Saleo] Gemini returned ${rawText.length} chars`);

    // Retry once if empty response
    if (!rawText.trim()) {
      console.log('[Saleo] Empty response from Gemini, retrying...');
      res.write(': retrying empty response\n\n');
      const retryResp = await Promise.race([
        fetch(geminiUrl, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 8192 } }),
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini retry timed out')), 120000)),
      ]);
      if (retryResp.ok) {
        geminiData = await retryResp.json();
        rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        console.log(`[Saleo] Retry returned ${rawText.length} chars`);
      }
      if (!rawText.trim()) throw new Error('No response from AI after retry. Please try again.');
    }

    let parsed;
    try {
      let text = rawText.trim().replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      const jsonStart = text.indexOf('{');
      const jsonEnd = text.lastIndexOf('}');
      if (jsonStart >= 0 && jsonEnd > jsonStart) text = text.substring(jsonStart, jsonEnd + 1);
      parsed = JSON.parse(text);
    } catch (e) {
      console.error('[Saleo] Parse error:', e.message, 'Raw:', rawText.substring(0, 1000));
      throw new Error('Failed to parse AI response. Raw preview: ' + rawText.substring(0, 300));
    }

    // Validate and clean
    const validTokenIds = new Set(tokens.map(t => t.tokenId || t.id));
    const tokenValues = (parsed.tokenValues || [])
      .filter(tv => validTokenIds.has(tv.tokenId || tv.id))
      .map(tv => ({ tokenId: tv.tokenId || tv.id, value: String(tv.value || '').substring(0, 1000) }));

    for (const t of tokens) {
      const tid = t.tokenId || t.id;
      if (!tokenValues.find(tv => tv.tokenId === tid)) {
        tokenValues.push({ tokenId: tid, value: t.value || t.currentValue || '' });
      }
    }

    console.log(`[Saleo] Generated ${tokenValues.length} token values for "${brand}"`);
    res.write(`data: ${JSON.stringify({ tokenValues })}\n\n`);
    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('Token value generation failed:', err.message);
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.write('data: [DONE]\n\n');
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

// POST /api/saleo/views — Create a Saleo view and share with user
app.post('/api/saleo/views', async (req, res) => {
  try {
    const { email, itemId, demoId, projectName, tokenValues } = req.body;
    if (!email || !demoId || !projectName) {
      return res.status(400).json({ error: 'email, demoId, and projectName are required' });
    }

    // Build view name: "Aubrey Demo - <Project Name> - [dd/mm/yyyy]"
    const now = new Date();
    const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    const viewName = `Aubrey Demo - ${projectName} - ${dateStr}`;

    console.log(`[Saleo] Creating view "${viewName}" for ${email}`);

    // Step 1: Create the view
    const viewResult = await saleo.createView(demoId, viewName, tokenValues || []);
    const viewId = viewResult.viewId || viewResult.id || viewResult.view?.id;

    if (!viewId) {
      console.error('[Saleo] create_personalized_view returned no viewId:', JSON.stringify(viewResult));
      return res.status(500).json({ error: 'View created but no viewId returned', result: viewResult });
    }

    console.log(`[Saleo] View created: ${viewId}`);

    // Step 2: Resolve user's Saleo ID
    let saleoUserId = null;
    let shareStatus = 'pending';
    let shareError = null;

    try {
      const userResult = await saleo.getUserId(email);
      saleoUserId = userResult.userId || userResult.id || userResult.user?.id;

      if (saleoUserId) {
        // Step 3: Share with user (edit access)
        await saleo.shareView(viewId, [{ userId: saleoUserId, canEdit: true }]);
        shareStatus = 'shared';
        console.log(`[Saleo] View ${viewId} shared with ${email} (userId: ${saleoUserId})`);
      } else {
        shareStatus = 'share_failed';
        shareError = 'Could not resolve your Saleo user ID. You may not be on the Saleo team.';
      }
    } catch (shareErr) {
      shareStatus = 'share_failed';
      shareError = shareErr.message;
      console.warn(`[Saleo] Failed to share view with ${email}:`, shareErr.message);
    }

    // Step 4: Save Saleo data to the item's JSONB
    if (itemId) {
      try {
        const items = await query('SELECT data FROM items WHERE id = ?', [itemId]);
        if (items.length > 0) {
          let data = typeof items[0].data === 'string' ? JSON.parse(items[0].data) : (items[0].data || {});
          data.saleo = {
            demoId,
            viewId,
            viewName,
            tokenValues: tokenValues || [],
            sharedWith: saleoUserId ? [{ email, userId: saleoUserId, canEdit: true, sharedAt: new Date().toISOString() }] : [],
            status: shareStatus,
            error: shareError,
            createdAt: new Date().toISOString(),
          };
          await query('UPDATE items SET data = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(data), itemId]);
        }
      } catch (dbErr) {
        console.warn('[Saleo] Failed to save view data to item:', dbErr.message);
      }
    }

    res.json({
      viewId,
      viewName,
      shareStatus,
      shareError,
      saleoUserId,
    });
  } catch (err) {
    console.error('Saleo view creation failed:', err);
    res.status(500).json({ error: 'Failed to create Saleo view: ' + err.message });
  }
});

// POST /api/saleo/views/:viewId/tokens — Re-push edited token values
app.post('/api/saleo/views/:viewId/tokens', async (req, res) => {
  try {
    const { email, itemId, tokenValues } = req.body;
    if (!email || !tokenValues) {
      return res.status(400).json({ error: 'email and tokenValues are required' });
    }

    // Verify ownership
    if (itemId) {
      const user = await getOrCreateUser(email);
      const items = await query('SELECT id FROM items WHERE id = ? AND user_id = ?', [itemId, user.id]);
      if (items.length === 0) return res.status(404).json({ error: 'Item not found' });
    }

    await saleo.updateViewTokens(req.params.viewId, tokenValues);

    // Update stored token values
    if (itemId) {
      try {
        const items = await query('SELECT data FROM items WHERE id = ?', [itemId]);
        if (items.length > 0) {
          let data = typeof items[0].data === 'string' ? JSON.parse(items[0].data) : (items[0].data || {});
          if (data.saleo) {
            data.saleo.tokenValues = tokenValues;
          }
          await query('UPDATE items SET data = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(data), itemId]);
        }
      } catch (dbErr) {
        console.warn('[Saleo] Failed to update token values in DB:', dbErr.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Token update failed:', err);
    res.status(500).json({ error: 'Failed to update tokens: ' + err.message });
  }
});

// POST /api/saleo/views/:viewId/share — Share view with additional colleagues
app.post('/api/saleo/views/:viewId/share', async (req, res) => {
  try {
    const { emails, canEdit = false } = req.body;
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'emails[] is required' });
    }

    const results = [];
    const usersToShare = [];

    for (const email of emails) {
      try {
        const userResult = await saleo.getUserId(email);
        const userId = userResult.userId || userResult.id;
        if (userId) {
          usersToShare.push({ userId, canEdit });
          results.push({ email, status: 'resolved', userId });
        } else {
          results.push({ email, status: 'not_found', error: 'User not on Saleo team' });
        }
      } catch (err) {
        results.push({ email, status: 'error', error: err.message });
      }
    }

    if (usersToShare.length > 0) {
      await saleo.shareView(req.params.viewId, usersToShare);
    }

    res.json({ results, shared: usersToShare.length });
  } catch (err) {
    console.error('Share failed:', err);
    res.status(500).json({ error: 'Failed to share view: ' + err.message });
  }
});

// ═══════════════════════════════════════════════
// APP-SPECIFIC: Items CRUD
// ═══════════════════════════════════════════════

// GET /api/items — list items for a user
app.get('/api/items', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const logoCol = isPostgres
      ? "data #>> '{images,logo}' AS logo_url"
      : "JSON_UNQUOTE(JSON_EXTRACT(data, '$.images.logo')) AS logo_url";
    const saleoStatusCol = isPostgres
      ? "data #>> '{saleo,status}' AS saleo_status"
      : "JSON_UNQUOTE(JSON_EXTRACT(data, '$.saleo.status')) AS saleo_status";
    const items = await query(
      `SELECT id, name, shared_by_email, shared_at, created_at, updated_at,
              ${logoCol}, ${saleoStatusCol}
       FROM items WHERE user_id = ? ORDER BY COALESCE(updated_at, created_at, '1970-01-01') DESC`,
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
    let rows;
    if (isAdmin(email)) {
      rows = await query(
        'SELECT i.*, u.email AS owner_email, u.name AS owner_name FROM items i JOIN users u ON u.id = i.user_id WHERE i.id = ?',
        [req.params.id]
      );
    } else {
      rows = await query('SELECT * FROM items WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    }

    if (rows.length === 0) return res.status(404).json({ error: 'Item not found' });

    const item = rows[0];
    if (typeof item.data === 'string') item.data = JSON.parse(item.data);

    res.json({ item });
  } catch (err) {
    console.error('Failed to get item:', err);
    res.status(500).json({ error: 'Failed to get item' });
  }
});

// POST /api/items — create a new item
app.post('/api/items', async (req, res) => {
  try {
    const { email, name, data } = req.body;
    if (!email || !name) return res.status(400).json({ error: 'Missing required fields: email, name' });
    try { assertNoEmbeddedImages(data); } catch (e) { return res.status(400).json({ error: e.message }); }

    const user = await getOrCreateUser(email);
    const result = await query(
      'INSERT INTO items (user_id, name, data) VALUES (?, ?, ?)',
      [user.id, name.trim(), data ? JSON.stringify(data) : null]
    );

    const itemId = result.insertId;
    res.status(201).json({
      item: { id: itemId, name: name.trim(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }
    });
  } catch (err) {
    console.error('Failed to create item:', err);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

// PUT /api/items/:id — update an item
app.put('/api/items/:id', async (req, res) => {
  try {
    const { email, data, name } = req.body;
    if (!email || !data) return res.status(400).json({ error: 'Email and data required' });
    try { assertNoEmbeddedImages(data); } catch (e) { return res.status(400).json({ error: e.message }); }

    const user = await getOrCreateUser(email);
    const existing = await query('SELECT * FROM items WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Item not found' });

    if (name && typeof name === 'string' && name.trim()) {
      await query('UPDATE items SET name = ?, data = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
        [name.trim(), JSON.stringify(data), req.params.id, user.id]);
    } else {
      await query('UPDATE items SET data = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
        [JSON.stringify(data), req.params.id, user.id]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update item:', err);
    res.status(500).json({ error: 'Failed to update item' });
  }
});

// DELETE /api/items/:id — delete an item
app.delete('/api/items/:id', async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await getOrCreateUser(email);
    const items = await query('SELECT * FROM items WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (items.length === 0) return res.status(404).json({ error: 'Item not found' });

    // Clean up storage assets
    const itemData = typeof items[0].data === 'string' ? JSON.parse(items[0].data) : items[0].data;
    if (itemData) {
      const ownUrls = extractAssetUrls(itemData, { ownOnly: true });
      if (ownUrls.length > 0) {
        unreferencedUrls(ownUrls, items[0].id)
          .then(urls => urls.length && deleteByUrls(urls))
          .catch(err => console.warn('[storage] Item cleanup error:', err.message));
      }
    }

    await query('DELETE FROM items WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete item:', err);
    res.status(500).json({ error: 'Failed to delete item' });
  }
});

// ─── Share Items ───

async function createSharedCopy(sourceItem, senderEmail, recipientEmail) {
  const recipientUser = await getOrCreateUser(recipientEmail);
  const copyResult = await query(
    'INSERT INTO items (user_id, name, data, shared_by_email, shared_at) VALUES (?, ?, ?, ?, NOW())',
    [recipientUser.id, sourceItem.name, typeof sourceItem.data === 'string' ? sourceItem.data : JSON.stringify(sourceItem.data), senderEmail]
  );
  return copyResult.insertId;
}

app.post('/api/items/:id/share', async (req, res) => {
  try {
    const { email, recipientEmail } = req.body;
    if (!email || !recipientEmail) return res.status(400).json({ error: 'Sender email and recipientEmail are required' });
    if (email.toLowerCase() === recipientEmail.toLowerCase()) return res.status(400).json({ error: 'You cannot share an item with yourself' });

    const sender = await getOrCreateUser(email);
    const items = await query('SELECT * FROM items WHERE id = ? AND user_id = ?', [req.params.id, sender.id]);
    if (items.length === 0) return res.status(404).json({ error: 'Item not found' });
    const sourceItem = items[0];

    const existing = await query(
      'SELECT id, copied_item_id, created_at FROM shared_items WHERE item_id = ? AND sender_user_id = ? AND recipient_email = ?',
      [req.params.id, sender.id, recipientEmail.toLowerCase()]
    );

    if (existing.length > 0) {
      return res.json({ alreadyShared: true, sharedAt: existing[0].created_at, copiedItemId: existing[0].copied_item_id, shareRecordId: existing[0].id });
    }

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

app.post('/api/items/:id/share/confirm', async (req, res) => {
  try {
    const { email, recipientEmail, action } = req.body;
    if (!email || !recipientEmail || !action) return res.status(400).json({ error: 'email, recipientEmail, and action are required' });
    if (!['replace', 'copy'].includes(action)) return res.status(400).json({ error: 'action must be "replace" or "copy"' });

    const sender = await getOrCreateUser(email);
    const items = await query('SELECT * FROM items WHERE id = ? AND user_id = ?', [req.params.id, sender.id]);
    if (items.length === 0) return res.status(404).json({ error: 'Item not found' });
    const sourceItem = items[0];

    if (action === 'replace') {
      const existing = await query(
        'SELECT id, copied_item_id FROM shared_items WHERE item_id = ? AND sender_user_id = ? AND recipient_email = ?',
        [req.params.id, sender.id, recipientEmail.toLowerCase()]
      );
      if (existing.length === 0) return res.status(404).json({ error: 'No previous share found' });
      const copiedId = existing[0].copied_item_id;
      if (copiedId) {
        await query('UPDATE items SET name = ?, data = ?, shared_by_email = ?, shared_at = NOW(), updated_at = NOW() WHERE id = ?',
          [sourceItem.name, typeof sourceItem.data === 'string' ? sourceItem.data : JSON.stringify(sourceItem.data), email.toLowerCase(), copiedId]);
      }
      await query('UPDATE shared_items SET created_at = NOW() WHERE id = ?', [existing[0].id]);
      res.json({ success: true, action: 'replaced', copiedItemId: copiedId });
    } else {
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

app.get('/api/brandkit-builder/items', async (req, res) => {
  const apiKey = process.env.BRANDKIT_BUILDER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Brand Kit Builder not configured' });
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });
  try {
    const resp = await fetch(`${BRANDKIT_API_URL}/items?email=${encodeURIComponent(email)}`, { headers: { 'x-api-key': apiKey } });
    if (!resp.ok) throw new Error(`Brand Kit Builder responded ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('Brand Kit Builder proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch brand kits' });
  }
});

app.get('/api/brandkit-builder/items/:id', async (req, res) => {
  const apiKey = process.env.BRANDKIT_BUILDER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Brand Kit Builder not configured' });
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });
  try {
    const resp = await fetch(`${BRANDKIT_API_URL}/items/${req.params.id}?email=${encodeURIComponent(email)}`, { headers: { 'x-api-key': apiKey } });
    if (!resp.ok) throw new Error(`Brand Kit Builder responded ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('Brand Kit Builder proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch brand kit' });
  }
});

app.post('/api/brandkit-builder/create', async (req, res) => {
  const apiKey = process.env.BRANDKIT_BUILDER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Brand Kit Builder not configured' });
  try {
    const resp = await fetch(`${BRANDKIT_API_URL}/items`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(req.body)
    });
    if (!resp.ok) throw new Error(`Brand Kit Builder responded ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('Brand Kit Builder create error:', err.message);
    res.status(502).json({ error: 'Failed to create brand kit' });
  }
});

app.post('/api/brandkit-builder/generate/:id', async (req, res) => {
  const apiKey = process.env.BRANDKIT_BUILDER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Brand Kit Builder not configured' });
  try {
    const resp = await fetch(`${BRANDKIT_API_URL}/items/${req.params.id}/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(req.body)
    });
    if (!resp.ok) throw new Error(`Brand Kit Builder responded ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('Brand Kit Builder generate error:', err.message);
    res.status(502).json({ error: 'Failed to generate brand kit' });
  }
});

app.post('/api/detect-industry', async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Gemini not configured' });
  const { brand_name } = req.body || {};
  if (!brand_name) return res.status(400).json({ error: 'brand_name required' });
  const supportedIndustries = ['Retail', 'Consumer Goods', 'Manufacturing', 'Auto', 'Energy'];
  try {
    const prompt = `What industry does the brand "${brand_name}" belong to? Pick ONLY ONE from this exact list: ${supportedIndustries.join(', ')}. If none fit well, respond with one of those that fits best. Respond with ONLY the industry name, nothing else.`;
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 20 } })
    });
    if (!resp.ok) throw new Error(`Gemini responded ${resp.status}`);
    const data = await resp.json();
    const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    const matched = supportedIndustries.find(i => text.toLowerCase().includes(i.toLowerCase()));
    res.json({ industry: matched || text, raw: text });
  } catch (err) {
    console.error('Industry detection error:', err.message);
    res.status(500).json({ error: 'Failed to detect industry' });
  }
});

// ═══════════════════════════════════════════════
// Script Builder Proxy
// ═══════════════════════════════════════════════

const SCRIPT_API_URL = process.env.SCRIPTWRITER_URL
  ? `${process.env.SCRIPTWRITER_URL}/api`
  : 'https://scriptwriter.aubreydemo.com/api';

app.get('/api/scriptwriter/scripts', async (req, res) => {
  const apiKey = process.env.SCRIPTWRITER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Scriptwriter not configured' });
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });
  try {
    const resp = await fetch(`${SCRIPT_API_URL}/scripts?email=${encodeURIComponent(email)}`, { headers: { 'x-api-key': apiKey } });
    if (!resp.ok) throw new Error(`Scriptwriter responded ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('Scriptwriter proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch scripts' });
  }
});

app.get('/api/scriptwriter/scripts/:id', async (req, res) => {
  const apiKey = process.env.SCRIPTWRITER_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Scriptwriter not configured' });
  const email = req.query.email;
  if (!email) return res.status(400).json({ error: 'email query parameter required' });
  try {
    const resp = await fetch(`${SCRIPT_API_URL}/scripts/${req.params.id}?email=${encodeURIComponent(email)}`, { headers: { 'x-api-key': apiKey } });
    if (!resp.ok) throw new Error(`Scriptwriter responded ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch (err) {
    console.error('Scriptwriter proxy error:', err.message);
    res.status(502).json({ error: 'Failed to fetch script' });
  }
});

// Global error handler — always return JSON for API routes
app.use('/api', (err, req, res, next) => {
  console.error(`[API Error] ${req.method} ${req.path}:`, err.message || err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// SPA catch-all
app.get('/{*splat}', (req, res) => {
  if (spaHtml) {
    res.set('Content-Type', 'text/html');
    res.send(spaHtml);
  } else {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

// Seed API key from environment variable on startup
async function seedApiKey() {
  const seedKey = process.env.SEED_API_KEY;
  if (!seedKey) return;
  try {
    const keyHash = hashApiKey(seedKey);
    const existing = await query('SELECT id FROM api_keys WHERE key_hash = ?', [keyHash]);
    if (existing.length > 0) return;
    let adminRows = await query('SELECT id FROM users WHERE is_admin = true LIMIT 1');
    let userId;
    if (adminRows.length > 0) {
      userId = adminRows[0].id;
    } else {
      const adminEmail = (process.env.ADMIN_EMAILS || '').split(',')[0]?.trim() || 'admin@salesforce.com';
      const result = await query('INSERT INTO users (email, name, is_admin) VALUES (?, ?, true)', [adminEmail, 'Admin']);
      userId = result.insertId;
    }
    await query('INSERT INTO api_keys (user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?)',
      [userId, 'DemoForge Integration', seedKey.substring(0, 8), keyHash]);
    console.log('\u2713 SEED_API_KEY registered');
  } catch (e) {
    console.warn('\u26a0\ufe0f  Failed to seed API key:', e.message);
  }
}

// ═══════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════

async function start() {
  try {
    await migrate();
    console.log('\u2713 Database ready');
    await seedApiKey();
  } catch (err) {
    console.error('\u26a0\ufe0f  Database migration failed:', err.message);
    console.warn('  Features requiring a database will not work until DATABASE_URL is configured');
  }

  if (isPostgres && process.env.RUN_DATA_MIGRATION === 'true') {
    console.log('Starting MySQL \u2192 PostgreSQL data migration...');
    try {
      const mysql = require('mysql2/promise');
      const srcUrl = process.env.JAWSDB_URL;
      if (srcUrl) {
        const src = await mysql.createConnection(srcUrl);
        const pgPool = getPool();
        const tables = ['users', 'api_keys', 'items', 'feedback', 'shared_items'];
        for (const table of tables) {
          try {
            const [rows] = await src.query(`SELECT * FROM ${table}`);
            console.log(`Migrating ${table}: ${rows.length} rows`);
            for (const row of rows) {
              const cols = Object.keys(row);
              const vals = Object.values(row);
              const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
              const colList = cols.map(c => `"${c}"`).join(',');
              try {
                const onConflict = (table === 'users') ? ' ON CONFLICT (email) DO NOTHING' :
                                   (table === 'api_keys') ? ' ON CONFLICT (key_hash) DO NOTHING' : '';
                await pgPool.query(`INSERT INTO ${table} (${colList}) VALUES (${placeholders})${onConflict}`, vals);
              } catch (e) {
                if (e.code !== '23505') console.error(`  Row error in ${table}:`, e.message);
              }
            }
          } catch (e) {
            console.error(`  Table ${table} migration error:`, e.message);
          }
        }
        for (const table of tables) {
          try {
            await pgPool.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`);
          } catch (e) { /* ignore */ }
        }
        await src.end();
        console.log('\u2713 Data migration completed');
      }
    } catch (e) {
      console.error('Data migration error:', e.message);
    }
  }

  const server = app.listen(PORT, () => {
    console.log(`Saleo Builder v2.0.0 running on http://localhost:${PORT}`);
    if (!process.env.GEMINI_API_KEY) console.warn('\u26a0\ufe0f  GEMINI_API_KEY not set \u2014 AI features will not work');
    if (!saleo.isConfigured()) console.warn('\u26a0\ufe0f  SALEO_API_KEY not set \u2014 Saleo view creation will not work');
  });

  server.timeout = 300000;
  server.keepAliveTimeout = 300000;
}

start();
