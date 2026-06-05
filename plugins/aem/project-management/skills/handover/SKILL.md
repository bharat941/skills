---
name: handover
description: Generate project handover documentation for AEM Edge Delivery Services projects. Creates comprehensive guides for content authors, developers, and administrators. Use for "handover docs", "project documentation", "generate handover", "create guides".
license: Apache-2.0
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion, Skill, Agent
metadata:
  version: "1.1.0"
---

# Project Handover Documentation

Generate comprehensive handover documentation for Edge Delivery Services projects. This skill orchestrates the creation of guides for different audiences.

## When to Use This Skill

- "Generate project handover docs"
- "Create handover documentation"
- "Generate project guides"
- "Handover package"
- "Project documentation"

---

## Available Documentation Types

| Guide | Audience | Skill |
|-------|----------|-------|
| **Authoring Guide** | Content authors and content managers | `handover-author` |
| **Developer Guide** | Developers and technical team | `handover-developer` |
| **Admin Guide** | Site administrators and operations | `handover-admin` |

---

## Execution Flow

### Step 0: Navigate to Project Root and Verify Edge Delivery Services Project (MANDATORY FIRST STEP)

**CRITICAL: You MUST execute this `cd` command before anything else. Do NOT use absolute paths — actually change directory.**

```bash
# Navigate to git project root (works from any subdirectory)
cd "$(git rev-parse --show-toplevel)"

# Verify it's an Edge Delivery Services project
ls scripts/aem.js
```

**IMPORTANT:**
- You MUST run the `cd` command above using the Bash tool
- All subsequent steps operate from project root
- Do NOT use absolute paths to verify — actually navigate
- Guides will be created at `project-root/project-guides/`

**If `scripts/aem.js` does NOT exist**, respond:

> "This skill is designed for AEM Edge Delivery Services projects. The current directory does not appear to be an Edge Delivery Services project (`scripts/aem.js` not found).
>
> Please navigate to an Edge Delivery Services project and try again."

**STOP if check fails. Otherwise proceed — you are now at project root.**

---

### Step 0.5: Clean Up Stale Config

Remove any existing config to ensure fresh org and authentication for this project:

```bash
rm -f .claude-plugin/project-config.json
```

---

### Step 1: Ask User for Documentation Type

**MANDATORY:** Use the `AskUserQuestion` tool with EXACTLY these 4 options:

```json
AskUserQuestion({
  "questions": [{
    "question": "Which type of handover documentation would you like me to generate?",
    "header": "Guide Type",
    "options": [
      {"label": "All (Recommended)", "description": "Generate all three guides: Authoring, Developer, and Admin"},
      {"label": "Authoring Guide", "description": "For content authors and managers - blocks, templates, publishing"},
      {"label": "Developer Guide", "description": "For developers - codebase, implementations, design tokens"},
      {"label": "Admin Guide", "description": "For site administrators - permissions, API operations, cache"}
    ],
    "multiSelect": false
  }]
})
```

**DO NOT omit any option. All 4 options MUST be presented.**

### Step 1.5: Get Organization Name (Required Before Generating Guides)

**AFTER the user selects guide type(s), but BEFORE invoking any sub-skills**, ensure the organization name is available.

#### 1.5.1 Check for Saved Organization

```bash
# Check if org name is already saved
cat .claude-plugin/project-config.json 2>/dev/null | node -e "
  const d = require('fs').readFileSync(0,'utf8');
  try { const o = JSON.parse(d).org; if(o) console.log('org: ' + o); } catch(e) {}
"
```

#### 1.5.2 Prompt for Organization Name and Content Source (If Not Saved)

**If no org name is saved**, you MUST pause and ask the user directly:

> "What is your Config Service organization name? This is the `{org}` part of your Edge Delivery Services URLs (e.g., `https://main--site--{org}.aem.page`). The org name may differ from your GitHub organization.
>
> Also, what is your project's content source?
> 1. SharePoint
> 2. Google Drive
> 3. Document Authoring (DA)
> 4. Crosswalk
>
> Please provide the org name and enter 1/2/3/4 for the content source."

**IMPORTANT RULES:**
- **DO NOT use `AskUserQuestion` with predefined options** — ask as a plain text question
- **Organization name is MANDATORY** — do not offer a "skip" option
- **Content source is MANDATORY** — needed to determine the correct identity provider for authentication
- **Wait for user to provide both values** before proceeding
- If user doesn't provide a valid org name or content source, ask again

**Content source to identity provider mapping:**

| Content Source | Identity Provider | Auth URL |
|---|---|---|
| 1. SharePoint | Microsoft | `https://admin.hlx.page/auth/microsoft` |
| 2. Google Drive | Google | `https://admin.hlx.page/auth/google` |
| 3. DA (Document Authoring) | Adobe | `https://admin.hlx.page/auth/adobe` |
| 4. Crosswalk | Adobe | `https://admin.hlx.page/auth/adobe` |

#### 1.5.3 Save Organization Name and Content Source

Once you have both values, save them so sub-skills can use them:

```bash
# Create config directory if needed
mkdir -p .claude-plugin
# Ensure .claude-plugin is in .gitignore (contains project config)
grep -qxF '.claude-plugin/' .gitignore 2>/dev/null || echo '.claude-plugin/' >> .gitignore

# Save org name and content source to config file
# contentSource values: "sharepoint", "google", "da", "crosswalk"
# authProvider values: "microsoft", "google", "adobe"
# If "All" was selected, include allGuides flag to skip step 0 in sub-skills
echo '{"org": "{ORG_NAME}", "contentSource": "{CONTENT_SOURCE}", "authProvider": "{AUTH_PROVIDER}"}' > .claude-plugin/project-config.json
# OR if "All (Recommended)" was selected:
echo '{"org": "{ORG_NAME}", "contentSource": "{CONTENT_SOURCE}", "authProvider": "{AUTH_PROVIDER}", "allGuides": true}' > .claude-plugin/project-config.json
```

**Note:** Include `"allGuides": true` ONLY when user selected "All (Recommended)". This signals sub-skills to skip step 0 validation (orchestrator already validated).

Replace `{ORG_NAME}` with the actual organization name, `{CONTENT_SOURCE}` with one of `sharepoint|google|da|crosswalk`, and `{AUTH_PROVIDER}` with the mapped provider (`microsoft|google|adobe`).

**Why this matters:** The organization name is required by the Helix Admin API to determine if the project is repoless (multi-site). The content source determines which identity provider to use during authentication. By gathering both once in the orchestrator, sub-skills running in parallel don't each need to prompt the user separately.

### Step 1.6: Authenticate with Edge Delivery Services

**AFTER saving the organization name and content source, authenticate to obtain an auth token.**

#### 1.6.1 Check for Existing Auth Token

```bash
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
else
  echo "Token missing or expired. Need to authenticate."
fi
```

#### 1.6.2 Authenticate (If No Valid Token)

If no valid token exists, invoke the auth skill:

```
Skill({ skill: "aem-project-management:auth" })
```

This will:
1. Read `authProvider` from `.claude-plugin/project-config.json` to determine identity provider
2. Open a browser at `https://admin.hlx.page/auth/{provider}` (Microsoft, Google, or Adobe)
3. Capture the `auth_token` cookie after login completes
4. Save token to `~/.aem/ims-token.json` (user-level, shared across projects)
5. Auto-close the browser when complete

**Why authenticate in orchestrator:** By authenticating once here, all sub-skills running in parallel can use the saved token without each prompting for login separately.

### Step 1.7: Validate Organization Name

**AFTER authentication succeeds, verify the org name by hitting the Config Service.**

```bash
AUTH_TOKEN=$(node -e "
  const fs = require('fs');
  try {
    const t = JSON.parse(fs.readFileSync(process.env.HOME + '/.aem/ims-token.json', 'utf8'));
    process.stdout.write(t.authToken || '');
  } catch (e) {}
")
ORG=$(cat .claude-plugin/project-config.json | node -e "
  const d = require('fs').readFileSync(0,'utf8');
  process.stdout.write(JSON.parse(d).org || '');
")
curl -s -w "\nHTTP: %{http_code}" -H "x-auth-token: ${AUTH_TOKEN}" "https://admin.hlx.page/config/${ORG}/sites.json"
```

**If HTTP 200:** Org is valid. Proceed to Step 2.

**If HTTP 403 or non-200:** The org name is likely incorrect. Respond to the user:

> "Unable to verify organization '{org}' (HTTP 403). Please check the spelling and try again. The org name is the `{org}` part of your site URL: `https://main--site--{org}.aem.page`. Please enter the correct org name."

Then update the org in `.claude-plugin/project-config.json` with the corrected value and **retry this validation step**. Loop until HTTP 200.

### Step 2: Invoke Appropriate Skill(s)

Based on user selection:

| Selection | Action |
|-----------|--------|
| **All** | Invoke all three skills **in parallel** (see Step 3) |
| **Authoring Guide** | `Skill({ skill: "aem-project-management:handover-author" })` |
| **Developer Guide** | `Skill({ skill: "aem-project-management:handover-developer" })` |
| **Admin Guide** | `Skill({ skill: "aem-project-management:handover-admin" })` |

**For single-guide selections**, invoke the skill directly from the main conversation (not via Agent) so permission prompts reach the user.

### Step 3: For "All" Selection

**Execute all three guides in PARALLEL using Agent tool with inline instructions.**

**IMPORTANT:** Provide immediate feedback to user before starting parallel execution:

```
"Starting parallel generation of all 3 handover guides:
  📄 Authoring Guide - analyzing blocks, templates, configurations...
  📄 Developer Guide - analyzing code, patterns, architecture...
  📄 Admin Guide - analyzing deployment, security, operations...

You'll see progress updates as each guide moves through its phases."
```

**Launch all three agents simultaneously in a SINGLE message (foreground mode).**

**CRITICAL RULES:**
- Do NOT use `run_in_background: true` — agents MUST run in foreground so permission prompts reach the user
- Do NOT tell agents to invoke the Skill tool — instead, tell each agent to **read the sub-skill SKILL.md file and follow its instructions directly** using only Bash, Read, and Write tools

```javascript
// All three in ONE message - runs in parallel with full permissions
Agent({
  description: "Generate authoring guide",
  prompt: "You are generating an authoring guide for an AEM Edge Delivery Services project at {PROJECT_ROOT}. Read the skill instructions at {PLUGIN_ROOT}/skills/handover-author/SKILL.md and follow them to generate the guide. The project config is at .claude-plugin/project-config.json (org, allGuides are already set — skip Phase 0 and authentication). Auth token is at ~/.aem/ims-token.json. Start from Phase 1. For PDF conversion, read {PLUGIN_ROOT}/skills/whitepaper/SKILL.md and follow its instructions. Do NOT use the Skill tool — execute all steps directly with Bash, Read, and Write tools."
})

Agent({
  description: "Generate developer guide",
  prompt: "You are generating a developer guide for an AEM Edge Delivery Services project at {PROJECT_ROOT}. Read the skill instructions at {PLUGIN_ROOT}/skills/handover-developer/SKILL.md and follow them to generate the guide. The project config is at .claude-plugin/project-config.json (org, allGuides are already set — skip Phase 0 and authentication). Auth token is at ~/.aem/ims-token.json. Start from Phase 1. For PDF conversion, read {PLUGIN_ROOT}/skills/whitepaper/SKILL.md and follow its instructions. Do NOT use the Skill tool — execute all steps directly with Bash, Read, and Write tools."
})

Agent({
  description: "Generate admin guide",
  prompt: "You are generating an admin guide for an AEM Edge Delivery Services project at {PROJECT_ROOT}. Read the skill instructions at {PLUGIN_ROOT}/skills/handover-admin/SKILL.md and follow them to generate the guide. The project config is at .claude-plugin/project-config.json (org, allGuides are already set — skip Phase 0 and authentication). Auth token is at ~/.aem/ims-token.json. Start from Phase 1. For PDF conversion, read {PLUGIN_ROOT}/skills/whitepaper/SKILL.md and follow its instructions. Do NOT use the Skill tool — execute all steps directly with Bash, Read, and Write tools."
})
```

**Replace `{PROJECT_ROOT}` with the actual project root path** (output of `git rev-parse --show-toplevel`).

**Replace `{PLUGIN_ROOT}` with the plugin root path.** Determine it with:
```bash
PLUGIN_ROOT=$([ -d ".claude/plugins/aem-project-management" ] && echo ".claude/plugins/aem-project-management" || echo "$CLAUDE_PLUGIN_ROOT")
```
If neither resolves, use the skill source at the path shown in the skill's "Base directory" header (strip `/skills/{name}` to get the plugin root).

**Why this approach:**
- Background agents cannot receive permission prompts for Skill tool calls
- Reading the SKILL.md and executing its instructions directly uses only Bash/Read/Write tools which are pre-authorized
- Agents get the same instructions they would from the Skill tool, just loaded via Read instead
- Runs all 3 in parallel (~3x faster than sequential)

**When all three complete, report final summary:**

```
"Handover documentation complete:

project-guides/
├── AUTHOR-GUIDE.pdf (full guide for content authors)
├── DEVELOPER-GUIDE.pdf (full guide for developers)
└── ADMIN-GUIDE.pdf (full guide for administrators)

All PDFs generated. Source files cleaned up."
```

**Benefits of parallel execution:**
- ~3x faster than sequential execution
- User sees continuous progress updates
- Each guide generates independently

---

## Output Files

| Selection | Output Files |
|-----------|--------------|
| All | `project-guides/AUTHOR-GUIDE.pdf`, `project-guides/DEVELOPER-GUIDE.pdf`, `project-guides/ADMIN-GUIDE.pdf` |
| Authoring Guide | `project-guides/AUTHOR-GUIDE.pdf` |
| Developer Guide | `project-guides/DEVELOPER-GUIDE.pdf` |
| Admin Guide | `project-guides/ADMIN-GUIDE.pdf` |

**Note:** Each sub-skill generates a PDF only. All source files (.md, .html, .plain.html) are cleaned up after PDF generation.

---

## ⚠️ CRITICAL PATH REQUIREMENT

**ALL FILES MUST BE SAVED TO `project-guides/` FOLDER:**

```
project-guides/AUTHOR-GUIDE.md
project-guides/DEVELOPER-GUIDE.md
project-guides/ADMIN-GUIDE.md
```

**WHY THIS MATTERS:** Files must be in `project-guides/` for proper organization and PDF conversion.

**BEFORE WRITING ANY FILE:** Run `mkdir -p project-guides` first.

---

## MANDATORY RULES

**STRICTLY FORBIDDEN:**
- ❌ Do NOT read or analyze `fstab.yaml` — it does NOT exist in most projects and does NOT show all sites
- ❌ Do NOT create `.plain.html` files
- ❌ Do NOT use `convert_markdown_to_html` tool
- ❌ Do NOT tell user to "convert markdown to PDF manually"
- ❌ Do NOT say "PDF will be generated later" — each sub-skill generates PDF immediately
- ❌ Do NOT save markdown to root directory or any path other than `project-guides/`

**REQUIRED:**
- ✅ Run `mkdir -p project-guides` before writing any files
- ✅ Each sub-skill MUST save markdown to `project-guides/` folder (EXACT PATH)
- ✅ Markdown files MUST have `title` and `date` fields in frontmatter
- ✅ Each sub-skill MUST invoke `project-management:whitepaper` to generate PDF immediately after saving markdown
- ✅ Each sub-skill MUST cleanup ALL source files (.md, .html, .plain.html) after PDF generation
- ✅ Final output is `.pdf` files ONLY in `project-guides/` folder

---

## Related Skills

This skill invokes:
- `aem-project-management:handover-author` - Author/content manager guide (generates PDF immediately)
- `aem-project-management:handover-developer` - Developer technical guide (generates PDF immediately)
- `aem-project-management:handover-admin` - Admin operations guide (generates PDF immediately)
- `aem-project-management:whitepaper` - PDF generation (invoked by each sub-skill after saving markdown)

