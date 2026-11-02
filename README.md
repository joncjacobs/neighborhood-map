# Neighborhood Map

A small, private, mobile-friendly map for keeping track of the households around us.

The site itself is public (GitHub Pages) but contains **no data**: no addresses, no lot shapes, no names.
Everything is stored in a Supabase database that only two allowed accounts can read or write.
The database enforces this itself (row-level security), so nothing in the page's code can get around it.
Signed out, the page shows a sign-in screen over an empty country-wide map.

- **Tap** a lot (or hover on a computer) to see who lives there; tap to open details and edit.
- **Show full names / Show first names / Hide names** cycles the labels on every lot.
- **List** is searchable by name, address or notes.
- **⋯ → Export data** downloads everything as a JSON backup.
- When you switch back to the app, it re-fetches so you see each other's changes. If you both edit
  the same thing, the second save warns you instead of silently overwriting.

## Files

| File | What it is |
|---|---|
| `index.html`, `app.js`, `style.css` | The app |
| `config.js` | Supabase URL and publishable key (safe to publish) |
| `supabase/schema.sql` | Tables and security rules |
| `.github/workflows/keepalive.yml` | Pings the database twice a week so the free project doesn't pause |

The data itself (households, lot outlines, starting names) is loaded from SQL files kept
**only on our own computer**, never in this repo.

## One-time setup

### 1. Supabase project
1. Create a free project at supabase.com.
2. **Authentication → Sign In / Providers:** turn off *Allow new users to sign up*, *Allow manual linking* and *Anonymous sign-ins*.
3. **Authentication → Users → Add user:** create the two accounts with long passwords and *Auto Confirm User* checked.

### 2. Database
In **SQL Editor → New query**, run (paste, make sure nothing is highlighted, then **Run**):
1. `supabase/schema.sql`
2. The private seed file.
3. Allow the two accounts:
   ```sql
   insert into public.allowed_users (user_id)
   select id from auth.users where email in ('you@example.com', 'partner@example.com');
   ```

### 3. Connect the app
Put the **Project URL** and **publishable key** (Project Settings → API Keys) in `config.js`.
Never use a secret / `service_role` key anywhere in this project.

### 4. Publish
1. **Settings → Pages**: deploy from branch `main`, folder `/ (root)`.
2. **Settings → Secrets and variables → Actions**: add `SUPABASE_URL` and `SUPABASE_ANON_KEY` for the keep-alive job.
3. On a phone, open the site and use **Share → Add to Home Screen**.

### 5. Check it's locked down
Open the site in a private window without signing in: you should see only the sign-in screen and an empty map.

## Security notes
- Third-party scripts are pinned with integrity hashes, and a Content-Security-Policy limits the page to
  talking to the Supabase project and the map-tile servers.
- The app deliberately stores no photos.
- Turn on two-step verification for GitHub, Supabase and both email accounts: they are the real keys to this data.
- Exports contain everything in plain text; keep them out of shared folders.
