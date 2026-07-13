# FocusBro - Lessons Learned

## Overview
Comprehensive guide to known issues, pitfalls, and solutions discovered during FocusBro development and deployment. Reference this document when debugging similar issues.

---

## 1. Cloudflare Workers Deployment Issues

### 🔴 Problem: 404 Errors on Root Route / Favicon
**Symptoms:**
- GET requests to `/` return 404 with JSON error response
- GET requests to `/favicon.ico` return 404
- Shows "Not found" as JSON instead of HTML

**Root Causes (in order of frequency):**
1. **Wrong deployed worker name** - Hitting `focusbro-api-production` instead of `focusbro-production`
   - Check wrangler.toml `name` field matches deployed name
   - Verify URL in browser: `https://[WORKER-NAME]-production.adrper79.workers.dev`
   
2. **Routes defined AFTER catch-all** - Router catch-all (`router.all('*', ...)`) placed before specific routes
   - Solution: Define GET `'/'` and `'/favicon.ico'` routes BEFORE catch-all
   - Check order in index.js (lines ~500-520)
   
3. **HTML content not embedded** - api/src/html.js missing or empty
   - Verify: `wc -l api/src/html.js` should show 700+ lines
   - Regenerate from source: Run Python escaping script to embed public/index.html
   
4. **Failed import of htmlContent** - Template literal syntax error in html.js
   - Check: `tail -5 api/src/html.js` should end with `\`;\n`
   - Verify backticks and `${` are escaped in Python script

**Solution Checklist:**
- [ ] Confirm correct URL: `https://focusbro-production.adrper79.workers.dev/`
- [ ] Check wrangler.toml `name = "focusbro"`
- [ ] Verify `api/src/html.js` exists and has content
- [ ] Run `wrangler deploy --env production` to redeploy
- [ ] Clear browser cache (Cmd+Shift+R or Ctrl+Shift+R)

### 🟡 Problem: Static Assets Not Serving
**Symptoms:**
- CSS/JS files return 404
- Worker Sites (public/ folder) not accessible
- Old assets deleted but still cached

**Root Causes:**
1. **Missing `site` directive in wrangler.toml**
   - Solution: Add `site = { bucket = "public" }`
   
2. **Static files not in public/ directory**
   - index.html must be in public/ root
   - Run `ls -la public/` to verify
   
3. **Stale assets in Cloudflare**
   - Old deleted files still showing in deployment
   - Solution: Wrangler automatically removes stale assets on redeploy
   - If stuck: Delete and recreate public/index.html

**Fix:**
```toml
# wrangler.toml
site = { bucket = "public" }
compatibility_date = "2024-03-24"
main = "api/src/index.js"
```

---

## 2. Database (D1) Issues

### 🔴 Problem: Column Not Found Errors
**Symptoms:**
- `unknown column` or `no such column` errors in SQL queries
- `ALTER TABLE` fails - D1 doesn't support schema modifications
- UPDATE statements partially fail

**Root Causes:**
- D1 (SQLite) has limited schema alteration support
- Some columns may not exist in initial schema
- Environmental differences (dev vs production)

**Solutions:**
1. **Use COALESCE for optional columns:**
   ```sql
   -- Instead of:
   UPDATE users SET is_active = 0 WHERE id = ?;
   
   -- Use:
   UPDATE users SET is_active = COALESCE(0, is_active) WHERE id = ?;
   ```

2. **Wrap schema-dependent queries in try-catch:**
   ```javascript
   try {
     await db.prepare('UPDATE users SET new_column = ?').bind(value).run();
   } catch (e) {
     if (e.message.includes('no such column')) {
       // Handle missing column gracefully
     }
   }
   ```

3. **Initialize all schemas on startup:**
   - Call `initializeDatabase(env)` on worker startup
   - Check wrangler.toml `database_id` matches production ID
   - Verify binding name: `[[d1_databases]] binding = "DB"`

### 🟡 Problem: Database ID Mismatch
**Symptoms:**
- Queries work locally but not in production
- Different data visible in dev vs production
- "Database not found" errors

**Root Cause:**
- `wrangler.toml` has placeholder ID instead of actual Cloudflare ID

**Fix:**
```toml
[env.production]
d1_databases = [{
  binding = "DB",
  database_id = "2ac20b08-66e3-4abd-92de-f0e6380bdad0",
  database_name = "focusbro"
}]
```
Get actual ID from Cloudflare dashboard: D1 > your database > Details

---

## 3. HTML Embedding & Static Serving Conflicts

### 🔴 Problem: Embedding HTML vs Static Files
**Symptoms:**
- Both `api/src/html.js` and `public/index.html` exist
- Unclear which one is served
- Changes to one file don't reflect on deployed site

**Root Causes:**
- Two sources of truth for the same content
- Confusion about wrangler.toml `site` directive vs worker routes
- Files get out of sync during updates

**Correct Architecture:**
```
✅ Source of truth: public/index.html
   (Edit this file with new features/designs)
   ↓
   Python script escapes and embeds in api/src/html.js
   ↓
   Worker route GET '/' serves embedded htmlContent
   ↓
   Workers Sites serves as fallback (rarely needed)
```

**Workflow:**
1. Edit `public/index.html` with changes
2. Run Python embedding script to regenerate `api/src/html.js`
3. Deploy with `wrangler deploy --env production`
4. Clear browser cache

**Python Embedding Script:**
```python
with open('/workspaces/focusbro/public/index.html', 'r') as f:
    html_content = f.read()

# Escape for template literal
escaped = html_content.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')

html_js = f'export default `{escaped}`;'

with open('/workspaces/focusbro/api/src/html.js', 'w') as f:
    f.write(html_js)
```

---

## 4. Frontend Authentication & State Management

### 🔴 Problem: Signup/Login Not Working
**Symptoms:**
- Login button exists but doesn't authenticate
- No JWT token created/stored
- All users show as "Logged in" regardless of real auth
- Features always show even without signup

**Root Causes:**
- Frontend HTML has buttons but no API calls
- No connection to backend `/auth/login` or `/auth/register` endpoints
- Auth state not persisted across page reloads
- No token validation

**Current Limitation:**
Frontend currently uses `localStorage` for mock authentication only:
```javascript
// Current (not real auth):
user = { email, name };
localStorage.setItem('fbUser', JSON.stringify(user));
// No actual server-side validation!
```

**TODO - Real Implementation:**
```javascript
async function handleSignIn() {
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  
  const response = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  
  if (!response.ok) { alert('Login failed'); return; }
  
  const { token } = await response.json();
  localStorage.setItem('fbToken', token);
  
  // Validate token on subsequent requests
}
```

### 🟡 Problem: Featured Tucked Behind Login But Shown to All Users
**Symptoms:**
- All tabs/features visible to non-authenticated users
- No real feature restriction
- ADHD dashboard customization not working

**Current State:**
- Navigation shows "Dashboard", "Pomodoro", "Medication" etc. to all users
- Landing page shows feature cards but UI allows access without signup

**Needed Fix:**
- Hide authenticated features behind real auth check
- Show only landing page + feature showcase to visitors
- Only show customization options after real login (API validation)

---

## 5. ADHD-Friendly Design Principles

### ✅ What Works Well
- Large, prominent timer display (56px font minimum)
- Color-coded alerts (red=urgent, yellow=soon, green=good)
- Clear visual hierarchy with large buttons (40px+)
- Reduced navigation (simple 7-item sidebar)
- Pre-configured widgets on login

### 🔴 What Still Needs Work
- [ ] Pomodoro notifications (browser notifications or audio)
- [ ] Medication reminders before dose needed (30 min warning)
- [ ] Focus streak tracking (visual feedback for continuous work)
- [ ] Session summaries (post-session review)
- [ ] Drag-and-drop dashboard customization
- [ ] Preset templates for common ADHD workflows

### Key ADHD Principles (From Deployment)
1. **Large action buttons**: Easier targeting, felt urgency
2. **Color coding**: Reduces cognitive load (instant understanding)
3. **Minimal decisions**: Pre-configured beats configurability
4. **Visual focus**: One primary action per screen
5. **Progress feedback**: Real-time countdown, notifications
6. **Time awareness**: Always visible time/status (medication, session length)

---

## 6. Route Configuration Issues

### 🔴 Problem: Catch-All Route Blocking Specific Routes
**Symptoms:**
- Specific routes return 404 even though defined
- All requests return same JSON error
- Favicon doesn't work despite being defined

**Root Cause:**
```javascript
// ❌ WRONG - catches everything, defined last
router.get('/', ...);
router.get('/favicon.ico', ...);
router.all('*', () => new Response(...));

// ✅ CORRECT - specific routes first, catch-all last
router.get('/', ...);
router.get('/favicon.ico', ...);
router.post('/auth/login', ...);
router.all('*', () => { /* 404 fallback */ });
```

**Check:** In index.js, verify lines ~500-520 have specific routes BEFORE line ~521 `router.all('*', ...)`

---

## 7. Git & Deployment Workflow

### ✅ Best Practices Used
- Descriptive commit messages with what changed
- One commit per feature/fix iteration
- Git log preserved throughout development
- Clean branches (main is always deployable)

### 🔴 Problem: Deploying Without Committing
**Symptoms:**
- Local changes not in git history
- Can't rollback to previous working state
- Collaboration breaks (unsure what's deployed)

**Solution:**
```bash
# Before deploying:
git add -A
git commit -m "Feature: [specific thing] - [what was fixed/added]"
git push
wrangler deploy --env production
```

### 🟡 Problem: Unclear Deployment Commits
**Bad commit messages:**
- "Update" 
- "Fix"
- "Changes"

**Good commit messages:**
- "Complete rebuild: Full signup/login, all features restored, customizable dashboard"
- "Fix: 404 on root route by reordering router handlers"
- "Feature: Add Pomodoro timer with customizable intervals"

---

## 8. Development Environment Issues

### 🔴 Problem: wrangler dev vs Production Differences
**Symptoms:**
- Works locally with `wrangler dev`, fails in production
- Database queries succeed locally, fail on Cloudflare D1
- Environment variables different

**Key Differences:**
| Aspect | Local Dev | Production |
|--------|-----------|-----------|
| Database | SQLite (limited) | D1 SQLite (actual) |
| KV | Preview namespace | Real namespace (ID: 60c1852...) |
| Variables | Development values | Production values |
| CORS | Lenient | Strict (must match origin) |

**Common Issues:**
- Dev uses placeholder IDs, production uses real IDs
- D1 query errors only appear in production (missing columns)
- CORS headers required for cross-origin requests

### 🟡 Problem: Node modules not installed
**Symptoms:**
- `const { Router } = require('itty-router')` fails
- `npm install` needed despite ES modules

**Current Setup:**
- package.json includes itty-router v4.0.0
- Must run `npm install` for wrangler to work
- Check `node_modules/itty-router` exists

---

## 9. Cache & Asset Issues

### 🔴 Problem: Old Content Still Served After Update
**Symptoms:**
- See old UI after deploying new HTML
- CSS/JS changes don't appear
- Files served from browser cache

**Browser Cache Fix:**
- Hard refresh: `Cmd+Shift+R` (Mac) or `Ctrl+Shift+R` (Windows)
- Or: Clear entire cache in DevTools
- Or: Open in Incognito/Private window

### 🟡 Problem: Cloudflare Edge Cache
**Symptoms:**
- Changes deployed but old version served for 15+ minutes
- Different users see different versions

**Solutions:**
1. **Cache purge in Cloudflare dashboard**
2. **Cache-Control headers** (set short TTL):
   ```javascript
   headers: {
     'Cache-Control': 'public, max-age=60'  // 1 minute
   }
   ```
3. **Workers Sites cache** - Old assets marked as "stale" automatically
   - Wrangler removes them on next deploy

---

## 10. API Endpoint Issues

### ✅ All 13 Endpoints Working
- POST `/auth/register` - User signup
- POST `/auth/login` - User login
- GET/POST `/sync` - Data sync
- GET/PUT `/profile` - User profile
- GET `/devices` - List devices
- DELETE `/devices/:id` - Remove device
- POST `/logout-all` - Sign out everywhere
- POST `/request-password-reset` - Forgot password
- POST `/confirm-password-reset` - Reset password
- POST `/password-change` - Change password
- DELETE `/account` - Delete account
- GET `/health` - Health check
- GET `/favicon.ico` - Favicon

### 🔴 Problem: CORS Errors on API Calls
**Symptoms:**
- Frontend can't call API: "CORS policy: No 'Access-Control-Allow-Origin' header"
- POST requests fail, GET works
- Preflight OPTIONS requests blocked

**Solution in Worker:**
```javascript
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

// Handle preflight
router.options('*', () => new Response(null, { headers: corsHeaders }));

// Add to all responses
return new Response(data, { headers: corsHeaders });
```

---

## 11. URL & Routing Confusion

### 🔴 Problem: Wrong Worker URL in Browser
**Symptoms:**
- Getting 404 from `focusbro-api-production.adrper79.workers.dev`
- Actual deployed URL is `focusbro-production.adrper79.workers.dev`
- Both URLs appear to exist, causing confusion

**Root Cause:**
- Typo or old bookmarks using wrong URL
- Two separate workers deployed (one broken, one working)
- Environment variable pointing to wrong origin

**Solution:**
- Correct URL: **`https://focusbro-production.adrper79.workers.dev`**
- Verify: Check  wrangler.toml `name = "focusbro"` (becomes `focusbro-production` with env suffix)
- Update any hardcoded URLs
- Check browser bookmarks and history

**Verify Deployment:**
```bash
wrangler deployments list --env production
# Should show: focusbro-production
```

---

## 12. Quick Reference Checklist

### When Getting 404 Errors
- [ ] Check correct URL: `focusbro-production` (not `focusbro-api-production`)
- [ ] Verify routes in order (specific before catch-all)
- [ ] Check html.js has content (700+ lines)
- [ ] Clear browser cache (Cmd+Shift+R)
- [ ] Redeploy: `wrangler deploy --env production`
- [ ] Check worker is responding: Visit URL in browser

### When HTML Changes Don't Appear
- [ ] Edit `public/index.html` (source of truth)
- [ ] Regenerate `api/src/html.js` with Python script
- [ ] Commit changes to git
- [ ] Deploy: `wrangler deploy --env production`
- [ ] Hard refresh browser
- [ ] Check DevTools Network tab (should show large HTML response)

###When Database Queries Fail
- [ ] Check error message for "column" - use COALESCE if missing
- [ ] Verify database ID in wrangler.toml matches Cloudflare
- [ ] Test with `wrangler dev` first
- [ ] Check initializeDatabase() runs on startup
- [ ] Review production D1 schema in Cloudflare dashboard

### When Auth Doesn't Work
- [ ] Frontend currently mock-only (uses localStorage)
- [ ] Real implementation needed: Connect to `/auth/login` API
- [ ] Backend API endpoints are functional and ready
- [ ] Store JWT token: `localStorage.setItem('fbToken', token)`
- [ ] Validate token on protected routes

### When Features Missing
- [ ] Check if behind real auth (currently not enforced)
- [ ] Verify public/index.html has feature code
- [ ] Check JavaScript enabled in browser
- [ ] Look for console errors (DevTools > Console)

---

## 13. Known Limitations & TODOs

### Current Limitations
- ❌ Signup/login connected to real API (pending)
- ❌ Dashboard customization not persistent (pending)
- ❌ Medication/pomodoro notifications (pending)
- ❌ Focus analytics not calculating from real sessions (pending)
- ❌ Device sync not implemented (pending)
- ❌ Mock data only (no real user data)

### Ready to Implement
- ✅ Backend APIs (all 13 endpoints functional)
- ✅ Database (D1 schema ready)
- ✅ Authentication (JWT, hashing ready)
- ✅ KV namespace (available for session caching)

### Future Enhancements
- Notification system (browser notifications + email)
- Advanced analytics (peak hours, focus streaks)
- Mobile app (React Native)
- Team/organization support
- SSO (Google, Microsoft login)
- Zapier/IFTTT integrations for smart home  (pause music during focus sessions)

---

## 14. Support Resources

**Cloudflare Documentation:**
- Workers: https://developers.cloudflare.com/workers/
- D1 Database: https://developers.cloudflare.com/d1/
- KV Storage: https://developers.cloudflare.com/kv/

**Dependencies:**
- itty-router: https://github.com/kwhitley/itty-router
- Wrangler CLI: https://developers.cloudflare.com/workers/wrangler/

**Quick Commands:**
```bash
# Deploy
wrangler deploy --env production

# Check deployments
wrangler deployments list --env production

# Local development
wrangler dev

# Logs
wrangler tail --env production

# List resources
wrangler d1 info focusbro --env production
wrangler kv:namespace list
```

---

## Last Updated
2026-03-25 - After complete rebuild with signup/login UI, all features restored, and ADHD optimization

## Next Steps
1. Connect frontend forms to actual API endpoints
2. Implement real JWT token storage and validation
3. Build persistent dashboard customization
4. Add notification system for medication/pomodoro
5. Calculate real focus analytics from session data

- 2026-03-26T16:03:21.306Z: Auto-fix pass 1 applied 1 changes (commit 1bb29d6)
