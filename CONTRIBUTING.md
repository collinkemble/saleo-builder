# Contributing to the Aubrey Demo Template

This template is the foundation for all `aubreydemo.com` subdomain apps. Changes here affect every new app created from it.

## When to Update the Template

**Update the template** when you want the change available to all future apps:

- Bug fixes in shared infrastructure (auth, feedback, API keys, users, sharing)
- New shared features that every app should have
- Security patches or dependency updates
- UI improvements to shared components (login, navbar, footer, dialogs)

**Don't update the template** for app-specific changes:

- Your app's unique tables, routes, or pages
- Custom AI prompts or workflows
- App-specific styling tweaks

## Template Conventions

### Placeholder Tokens

All app-specific values use `{{DOUBLE_BRACE}}` tokens:

- `Saleo Builder` — Display name
- `saleo-builder` — URL-safe identifier
- `Build Instant Saleo Demos` — Short description
- `Saleo Views` — Plural asset name (e.g., "Scripts")
- `Saleo View` — Singular asset name (e.g., "Script")
- `sleo` — 4-character API key prefix

### Code Section Labels

Sections are marked with `═══` separator comments:

```
// ═══════════════════════════════════════════════════════════════
// SHARED — Description (do not modify in your app)
// ═══════════════════════════════════════════════════════════════
```

```
// ═══════════════════════════════════════════════════════════════
// APP-SPECIFIC — Description (replace with your app's logic)
// ═══════════════════════════════════════════════════════════════
```

### Database Schema

- **Shared tables** (`users`, `feedback`, `api_keys`): Do not rename or remove columns
- **App-specific tables** (`items`, `shared_items`): Rename and restructure freely
- **Migrations**: Use the `appAlters` array in `migrate.js` for new columns

## Syncing Template Updates to Existing Apps

If the template gets a shared infrastructure update, you can pull it into an existing app:

```bash
# Add template as a remote (one-time)
git remote add template https://github.com/YOUR_ORG/aubreydemo-template.git

# Fetch and merge template changes
git fetch template
git merge template/main --allow-unrelated-histories
```

Resolve any conflicts in the APP-SPECIFIC sections (keep your app's code), and keep the template's changes in SHARED sections.
