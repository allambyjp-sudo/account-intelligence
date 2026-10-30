# Entra ID sign-in setup

**Goal:** sign in to the app with a Microsoft work account. Until this is done, the local
development sign-in (`AUTH_DEV_BYPASS=true`) works without it.

**Time:** about 10 minutes. **Steps checked against Microsoft Learn on 30 Oct 2026.**

## Ground rules

- **Which tenant.** Use a tenant you control for development (the personal test tenant from the
  LIP work is fine). Don't register this app in Datacom's production tenant until IT has approved
  it (brief, phase 7).
- **Sign-in only for now.** The only permission is `User.Read`, which Entra grants by default.
  Phase 6 adds delegated `Mail.Read` to the same registration, with consent at that point.
- **Secrets never go in chat or git.** They go in `.env` locally, or in the environment's secret
  settings when hosted.

## 1. Register the app

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com) as at least an
   **Application Developer**.
2. If you have several tenants, switch to the right one with the **Settings** icon in the top menu.
3. Go to **Entra ID → App registrations → New registration**.
4. **Name:** `Account Intelligence (dev)`.
5. **Supported account types:** **Single tenant only**. The app rejects sign-ins from other
   tenants anyway, and refuses `common` or `organizations` as a tenant ID.
6. **Redirect URI:** platform **Web**, value `http://localhost:3000/api/auth/callback`.
7. Select **Register**.
8. From **Overview**, copy the **Application (client) ID** and the **Directory (tenant) ID**.

## 2. Add a client secret (development only)

1. **Certificates & secrets → Client secrets → New client secret.** Description `dev`, expiry
   90 days.
2. Copy the secret **Value** straight away. It is shown only once.

Microsoft's guidance is not to use client secrets in production. Use a certificate or a federated
credential (managed identity) in the hosted environment. The code change is confined to the
`ConfidentialClientApplication` setup in `src/lib/auth/entra.ts`.

## 3. Optional: email claim

Sign-in reads the user's address from the `email` claim, falling back to `preferred_username`,
which is usually the UPN. To send `email` explicitly, add it under **Token configuration → Add
optional claim → ID → email**.

## 4. Configure the app

In `.env`:

```bash
ENTRA_TENANT_ID=<Directory (tenant) ID>
ENTRA_CLIENT_ID=<Application (client) ID>
ENTRA_CLIENT_SECRET=<secret value>
ENTRA_REDIRECT_URI=http://localhost:3000/api/auth/callback
```

Set all four or none; the app refuses a half-configured setup. Restart `npm run dev`. The sign-in
page now shows **Sign in with Microsoft**.

To load the fictional demo accounts for your Entra user, sign in once, then run:

```bash
npm run db:seed -- --owner you@yourtenant.onmicrosoft.com
```

## How sign-in works

- Authorization code flow with PKCE (MSAL Node). The PKCE verifier and `state` travel in a short-lived,
  encrypted, HttpOnly cookie scoped to `/api/auth`.
- The callback checks `state`, exchanges the code, and checks that the token's tenant (`tid`)
  matches `ENTRA_TENANT_ID`.
- The session is an encrypted (AES-256-GCM) HttpOnly cookie holding only the user's ID, and lasts
  8 hours. Every page that shows account data checks it on the server.
- Sign-out and dev sign-in are POST-only and reject cross-origin requests.
