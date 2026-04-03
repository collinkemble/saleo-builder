require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { query } = require('./src/db/connection');
const { migrate } = require('./src/db/migrate');
const { uploadImage, deleteByUrl, deleteByUrls, extractAssetUrls } = require('./src/utils/r2');
const { fetchBrandLogo } = require('./src/utils/logoFetcher');

const app = express();
const PORT = process.env.PORT || 3000;

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
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buffer);
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

    // Download the logo image and re-upload to R2
    const https = require('https');
    const http = require('http');
    const imageBuffer = await new Promise((resolve, reject) => {
      const fetch = (url, redirects = 3) => {
        const protocol = url.startsWith('https') ? https : http;
        protocol.get(url, { timeout: 10000 }, (resp) => {
          if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location && redirects > 0) {
            const loc = resp.headers.location.startsWith('http') ? resp.headers.location : new URL(resp.headers.location, url).href;
            resp.resume();
            return fetch(loc, redirects - 1);
          }
          if (resp.statusCode !== 200) { resp.resume(); return reject(new Error(`HTTP ${resp.statusCode}`)); }
          const chunks = [];
          resp.on('data', c => chunks.push(c));
          resp.on('end', () => resolve({ buffer: Buffer.concat(chunks), contentType: resp.headers['content-type'] || 'image/png' }));
          resp.on('error', reject);
        }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
      };
      fetch(result.url);
    });

    const mimeType = imageBuffer.contentType.split(';')[0].trim();
    const folder = `views/${viewId || 'tmp'}/logo`;
    const slug = brand.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const filename = `${slug}-logo`;
    const r2Url = await uploadImage(imageBuffer.buffer.toString('base64'), mimeType, folder, filename);

    console.log(`[Logo] Copied ${result.source} logo for "${brand}" to R2: ${r2Url}`);
    res.json({ found: true, url: r2Url, source: result.source });
  } catch (err) {
    console.error('Logo fetch failed:', err);
    res.status(500).json({ error: 'Logo fetch failed: ' + err.message });
  }
});

// POST /api/images/generate — Generate AI image via Gemini and upload to R2
app.post('/api/images/generate', async (req, res) => {
  try {
    const { brand, brandDesc, industry, imageType, viewId } = req.body;
    if (!brand) return res.status(400).json({ error: 'brand is required' });

    const { GoogleGenAI } = require('@google/genai');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const ai = new GoogleGenAI({ apiKey });

    // Build image prompt based on type
    let prompt;
    if (imageType === 'hero') {
      prompt = `Create a professional, clean hero image for a ${industry || 'business'} brand called "${brand}"`;
      if (brandDesc) prompt += ` which is ${brandDesc}`;
      prompt += `. The image should be a wide banner-style photo suitable for a demo presentation. Modern, polished, aspirational. No text or logos in the image. Photorealistic style.`;
    } else {
      prompt = `Create a professional product or lifestyle image for the brand "${brand}"`;
      if (brandDesc) prompt += `, ${brandDesc}`;
      prompt += `. Clean, modern, photorealistic. No text or logos.`;
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [{ text: prompt }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });

    // Extract image from response
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
    const folder = `views/${viewId || 'tmp'}/generated`;
    const slug = brand.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
    const filename = `${slug}-${imageType || 'image'}`;
    const url = await uploadImage(imageBase64, mimeType, folder, filename);

    res.json({ url, mimeType, imageType: imageType || 'hero' });
  } catch (err) {
    console.error('Image generation failed:', err);
    res.status(500).json({ error: 'Image generation failed: ' + err.message });
  }
});

// POST /api/images/persona — Generate a persona headshot via Gemini
app.post('/api/images/persona', async (req, res) => {
  try {
    const { brand, brandDesc, industry, synopsis, viewId } = req.body;
    if (!brand) return res.status(400).json({ error: 'brand is required' });

    const { GoogleGenAI } = require('@google/genai');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

    const ai = new GoogleGenAI({ apiKey });

    // Step 1: Try to extract a persona from the synopsis using Gemini text
    let personaDesc = '';
    if (synopsis && synopsis.trim()) {
      try {
        const extractResp = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [{ text: `From this demo synopsis, extract the main persona/character being described. Return ONLY a brief physical description suitable for generating a headshot photo (age range, gender, professional appearance). If no specific person is mentioned, infer a likely customer persona for a ${industry || 'business'} brand called "${brand}"${brandDesc ? ` (${brandDesc})` : ''}. Return just the description, nothing else.\n\nSynopsis: ${synopsis}` }],
        });
        personaDesc = extractResp.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        console.log(`[Persona] Extracted persona desc: "${personaDesc}"`);
      } catch (extractErr) {
        console.warn('[Persona] Extraction failed, using fallback:', extractErr.message);
      }
    }

    // Fallback: generate a generic persona for the brand/industry
    if (!personaDesc) {
      personaDesc = `A professional-looking person who would be a typical customer of ${brand}`;
      if (brandDesc) personaDesc += `, ${brandDesc}`;
      if (industry && industry !== 'Other') personaDesc += `, in the ${industry} industry`;
    }

    // Step 2: Generate headshot image
    const imagePrompt = `Generate a professional headshot photo of ${personaDesc}. The person should look friendly, confident, and approachable. Clean background, professional lighting, business casual attire. Photorealistic portrait style, shoulders-up framing. No text or watermarks.`;

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
      'SELECT id, name, shared_by_email, shared_at, created_at, updated_at FROM items WHERE user_id = ? ORDER BY updated_at DESC',
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

    res.status(201).json({
      item: {
        id: result.insertId,
        name: name.trim(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
    });
  } catch (err) {
    console.error('Failed to create item:', err);
    res.status(500).json({ error: 'Failed to create item' });
  }
});

// PUT /api/items/:id — update an item
app.put('/api/items/:id', async (req, res) => {
  try {
    const { email, data } = req.body;
    if (!email || !data) {
      return res.status(400).json({ error: 'Email and data required' });
    }

    const user = await getOrCreateUser(email);

    // Verify ownership
    const existing = await query('SELECT id FROM items WHERE id = ? AND user_id = ?', [req.params.id, user.id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Item not found' });
    }

    await query(
      'UPDATE items SET data = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
      [JSON.stringify(data), req.params.id, user.id]
    );

    res.json({ success: true });
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
