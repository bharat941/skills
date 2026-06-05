---
name: auth
description: Authenticate with AEM Edge Delivery Services. Opens browser for login and captures token. Works for admin.hlx.page, admin.da.live, and Config Service APIs regardless of content source (Document Authoring, SharePoint, or Google Drive).
license: Apache-2.0
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion
metadata:
  version: "3.0.0"
---

# AEM Edge Delivery Services Authentication

Authenticate to obtain a token for all Edge Delivery Services admin operations. Supports all content sources: SharePoint (Microsoft), Google Drive (Google), Document Authoring (Adobe), and Crosswalk (Adobe).

## Token Usage

The `auth_token` cookie works for all admin APIs:

| API | Header | Usage |
|-----|--------|-------|
| `admin.hlx.page` | `x-auth-token: ${AUTH_TOKEN}` | Preview, publish, status, code sync, jobs, logs, config |
| `admin.da.live` | `x-auth-token: ${AUTH_TOKEN}` | DA content operations (list, source, copy, move) |
| Config Service | `x-auth-token: ${AUTH_TOKEN}` | Sites, config, secrets, API keys, profiles |

## When to Use This Skill

- API returns 401 Unauthorized
- User says "login", "authenticate", "auth"
- Before any admin operation when token is missing/expired
- Before generating guides that need API access

## Prerequisites

- Node.js installed
- Playwright installed (`npx playwright install chromium`)

---

## Authentication Flow

### Step 1: Check Existing Token

Tokens are cached at the **user level** (`~/.aem/ims-token.json`), shared across all projects.

```bash
mkdir -p "${HOME}/.aem"

AUTH_TOKEN=$(node -e "
  const fs = require('fs');
  try {
    const t = JSON.parse(fs.readFileSync(process.env.HOME + '/.aem/ims-token.json', 'utf8'));
    if (t.authToken && t.authTokenExpiry > Math.floor(Date.now()/1000) + 60) {
      process.stdout.write(t.authToken);
    }
  } catch (e) {}
")

if [ -n "$AUTH_TOKEN" ]; then
  echo "Token valid"
  exit 0
fi

echo "Token missing or expired. Starting login..."
```

### Step 2: Install Playwright (if needed)

```bash
npx playwright --version 2>/dev/null || npm install -g playwright
npx playwright install chromium 2>/dev/null || true
```

### Step 2.5: Resolve Auth Provider

The login requires the identity provider. Check project config first (set by handover orchestrator), then ask user:

```bash
AUTH_PROVIDER=$(cat .claude-plugin/project-config.json 2>/dev/null | node -e "
  const d = require('fs').readFileSync(0,'utf8');
  try { process.stdout.write(JSON.parse(d).authProvider || ''); } catch(e) {}
")

echo "authProvider=${AUTH_PROVIDER:-NOT SET}"
```

**If `AUTH_PROVIDER` is empty**, ask the user for their content source:

> "What is your project's content source?
> 1. SharePoint
> 2. Google Drive
> 3. Document Authoring (DA)
> 4. Crosswalk
>
> Please enter 1/2/3/4."

Map the response:
- 1 (SharePoint) → `AUTH_PROVIDER=microsoft`
- 2 (Google Drive) → `AUTH_PROVIDER=google`
- 3 (DA) → `AUTH_PROVIDER=adobe`
- 4 (Crosswalk) → `AUTH_PROVIDER=adobe`

**Do NOT proceed until auth provider is available.**

### Step 3: Capture Token via Playwright

The `/login/{org}` endpoint does NOT auto-redirect — it returns a JSON with multiple provider links. Instead, navigate directly to `https://admin.hlx.page/auth/{provider}` which redirects to the correct identity provider login page.

| Content Source | Auth Provider | Login URL |
|---|---|---|
| SharePoint | microsoft | `https://admin.hlx.page/auth/microsoft` |
| Google Drive | google | `https://admin.hlx.page/auth/google` |
| DA | adobe | `https://admin.hlx.page/auth/adobe` |
| Crosswalk | adobe | `https://admin.hlx.page/auth/adobe` |

After login completes, the token is stored as the `auth_token` cookie on `admin.hlx.page`. Playwright reads this cookie, saves it to `~/.aem/ims-token.json`, then closes the browser automatically.

```bash
mkdir -p "${HOME}/.aem"

node -e "
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const TOKEN_PATH = path.join(process.env.HOME, '.aem', 'ims-token.json');
const AUTH_PROVIDER = '${AUTH_PROVIDER}';
const loginUrl = 'https://admin.hlx.page/auth/' + AUTH_PROVIDER;

(async () => {
  console.log('Opening browser for login...');
  console.log('Identity provider: ' + AUTH_PROVIDER);
  console.log('URL: ' + loginUrl);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(loginUrl);

  // Poll for auth_token cookie after login completes
  let token = null;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(5000);
    const cookies = await context.cookies('https://admin.hlx.page');
    const authCookie = cookies.find(c => c.name === 'auth_token');
    if (authCookie && authCookie.value) {
      token = authCookie.value;
      break;
    }
  }

  if (token) {
    const expiresAt = Math.floor(Date.now() / 1000) + 86400;
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch (e) {}
    existing.authToken = token;
    existing.authTokenExpiry = expiresAt;
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(existing, null, 2));
    try { fs.chmodSync(TOKEN_PATH, 0o600); } catch (e) {}
    console.log('Authentication successful');
    console.log('Token cached at: ' + TOKEN_PATH);
    console.log('Expires: ' + new Date(expiresAt * 1000).toISOString());
  } else {
    console.error('Login timed out - no auth_token cookie found after 5 minutes');
  }

  await browser.close();
  process.exit(token ? 0 : 1);
})();
"
```

---

## Token Storage

**User-level token cache** — `~/.aem/ims-token.json`:

```json
{
  "authToken": "eyJ...",
  "authTokenExpiry": 1780489855
}
```

| Field | Description |
|-------|-------------|
| `authToken` | Token from `auth_token` cookie after login |
| `authTokenExpiry` | Unix timestamp when token expires |

Shared across every project on this machine. File is written with `0600` permissions.

**Project-level config** — `.claude-plugin/project-config.json` (handover only, gitignored):

```json
{
  "org": "myorg",
  "contentSource": "sharepoint",
  "authProvider": "microsoft"
}
```

Holds project context for handover guides. **No token fields.**

---

## Using the Token

```bash
# Read token from user-level cache
AUTH_TOKEN=$(node -e "
  const fs = require('fs');
  try {
    const t = JSON.parse(fs.readFileSync(process.env.HOME + '/.aem/ims-token.json', 'utf8'));
    process.stdout.write(t.authToken || '');
  } catch (e) {}
")

# All APIs use the same header
curl -H "x-auth-token: ${AUTH_TOKEN}" "https://admin.hlx.page/status/{org}/{site}/main/"
curl -H "x-auth-token: ${AUTH_TOKEN}" "https://admin.hlx.page/config/{org}/sites.json"
curl -H "x-auth-token: ${AUTH_TOKEN}" "https://admin.da.live/list/{org}/{site}"
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `npx playwright` not found | Run `npm install -g playwright` |
| Browser doesn't open | Run `npx playwright install chromium` |
| Login page doesn't redirect | Check `authProvider` is correct for your content source |
| Token not captured | Ensure login completed before closing browser |
| 401 after login | Token expired, re-authenticate |
| 403 on API | User lacks permission for that org/site |

---

## Integration

Called by: `ops`, `handover-admin`, `handover-author`, `handover-developer`, `handover`

```
Skill({ skill: "aem-project-management:auth" })
```
