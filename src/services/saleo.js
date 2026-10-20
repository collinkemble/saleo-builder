/**
 * Saleo Public API client.
 *
 * All calls use a single admin SALEO_API_KEY from env.
 * Views are created under the admin account and shared with users.
 *
 * API docs: https://help.saleo.io/articles/8365713751-saleo-public-api
 */

const SALEO_API_BASE = process.env.SALEO_API_BASE || 'https://api.platform.saleo.io';

/**
 * Make an RPC call to the Saleo API with retry on 429/5xx.
 */
async function saleoRpc(method, body, retries = 3) {
  const key = process.env.SALEO_API_KEY;
  if (!key) throw new Error('SALEO_API_KEY not configured');

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await Promise.race([
        fetch(`${SALEO_API_BASE}/v1/${method}`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Saleo API timeout')), 30000)
        ),
      ]);

      if (resp.ok) {
        return resp.json();
      }

      const status = resp.status;

      // Retry on transient errors
      if ((status === 429 || status >= 500) && attempt < retries) {
        console.warn(`[Saleo] ${method} attempt ${attempt}/${retries} got ${status}, retrying...`);
        await new Promise(r => setTimeout(r, attempt * 2000));
        continue;
      }

      // Non-retryable or last attempt
      let errMsg = `Saleo API ${method} failed (${status})`;
      try {
        const errData = await resp.json();
        if (errData.message) errMsg = errData.message;
        if (errData.error) errMsg = typeof errData.error === 'string' ? errData.error : JSON.stringify(errData.error);
      } catch (_) {}

      const err = new Error(errMsg);
      err.status = status;
      throw err;
    } catch (err) {
      if (err.name === 'TimeoutError' || err.message === 'Saleo API timeout') {
        if (attempt < retries) {
          console.warn(`[Saleo] ${method} attempt ${attempt}/${retries} timed out, retrying...`);
          await new Promise(r => setTimeout(r, attempt * 2000));
          continue;
        }
      }
      throw err;
    }
  }
}

// ─── Golden Demo Cache (5 min) ───
let _goldenDemoCache = null;
let _goldenDemoCacheAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

module.exports = {
  /**
   * Find the golden demo template by name.
   * Results cached for 5 minutes.
   */
  async findGoldenDemo() {
    if (_goldenDemoCache && Date.now() - _goldenDemoCacheAt < CACHE_TTL) {
      return _goldenDemoCache;
    }

    const result = await saleoRpc('get_live_demos', {
      search: 'Aubrey Demo - Product C360 Golden Demo',
      personalizableOnly: true,
      limit: 10,
    });

    const demos = result.demos || result.data || result;
    const list = Array.isArray(demos) ? demos : [];
    const demo = list.find(d =>
      d.name === 'Aubrey Demo - Product C360 Golden Demo'
    );

    if (!demo) {
      throw new Error(
        'Golden demo template "Aubrey Demo - Product C360 Golden Demo" not found. ' +
        `Search returned ${list.length} result(s): ${list.map(d => d.name).join(', ') || '(none)'}`
      );
    }

    _goldenDemoCache = demo;
    _goldenDemoCacheAt = Date.now();
    return demo;
  },

  /**
   * Get all text tokens for a demo template.
   */
  async getTokens(demoId) {
    return saleoRpc('get_demo_tokens', { demoId });
  },

  /**
   * Create a personalized view from the golden demo.
   * Retries with name suffix on duplicate-name errors.
   */
  async createView(demoId, name, tokenValues) {
    for (let suffix = 0; suffix <= 5; suffix++) {
      const viewName = suffix === 0 ? name : `${name} (${suffix + 1})`;
      try {
        return await saleoRpc('create_personalized_view', {
          demoId,
          name: viewName,
          tokenValues,
        });
      } catch (err) {
        // Duplicate name — retry with suffix
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('duplicate') || msg.includes('already exists') || msg.includes('unique')) {
          if (suffix < 5) {
            console.warn(`[Saleo] View name "${viewName}" already exists, trying suffix (${suffix + 2})...`);
            continue;
          }
        }
        throw err;
      }
    }
  },

  /**
   * Share a view with users (add or upgrade access, never remove).
   */
  async shareView(viewId, users) {
    return saleoRpc('update_personalized_view', {
      viewId,
      sharedWith: users,
    });
  },

  /**
   * Update token values on an existing view.
   */
  async updateViewTokens(viewId, tokenValues) {
    return saleoRpc('update_personalized_view', {
      viewId,
      tokenValues,
    });
  },

  /**
   * Resolve a Saleo user email to their user ID.
   * Returns { userId } or throws 404 if user not on team.
   */
  async getUserId(email) {
    return saleoRpc('get_user_id', { email });
  },

  /**
   * Check if the Saleo API key is configured.
   */
  isConfigured() {
    return !!process.env.SALEO_API_KEY;
  },
};
