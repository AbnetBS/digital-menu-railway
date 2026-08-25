# 🚀 OFFICIAL DEPLOYMENT GUIDE — Make Fana Cafe a Real Live Website
# (No more localhost problems — deploy once, works forever)

This guide turns the code into an official website like **https://fanacafe.com**
with a real cloud database, admin dashboard, and 24/7 online orders.

Recommended stack (current plan):
✅ GitHub — the repository
✅ Railway — the app host (https://railway.app)
✅ Supabase — the PostgreSQL database (https://supabase.com)
   (Any Postgres host works — Neon, Railway Postgres, Supabase. You only need
    the DATABASE_URL connection string.)

════════════════════════════════════════
STEP 1 — PUSH THE CODE TO GITHUB (5 minutes)
════════════════════════════════════════
1. Create a repository on GitHub (e.g. "fana-cafe").
2. In this project folder, open a terminal and run:

   git init
   git add .
   git commit -m "Fana Cafe official website"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/fana-cafe.git
   git push -u origin main

IF THIS STEP ALREADY FAILED BEFORE: delete the old "node_modules" and ".next"
folders from the repo on GitHub (they should never be uploaded; .gitignore handles it).

════════════════════════════════════════
STEP 2 — CREATE THE CLOUD DATABASE (Supabase) (5 minutes)
════════════════════════════════════════
1. Go to https://supabase.com → create a new project → name it "fana-cafe".
2. In Project Settings → Database, copy the "Connection string" (URI). It looks like:
   postgresql://postgres.YOUR_PROJECT:YOUR_PASSWORD@aws-0-region.pooler.supabase.com:6543/postgres
   THIS IS YOUR OFFICIAL DATABASE_URL — keep it safe.

   (If you prefer Railway's own Postgres, create a "PostgreSQL" plugin in your
    Railway project and copy its DATABASE_URL instead.)

════════════════════════════════════════
STEP 3 — DEPLOY TO RAILWAY (5 minutes)
════════════════════════════════════════
1. Go to https://railway.app → New Project → Deploy from GitHub → import "fana-cafe".
2. Before (or right after) deploying, open the service's "Variables" and add ALL THREE:

   DATABASE_URL  =  <paste your Supabase/Postgres connection string from Step 2>
   ADMIN_PASSWORD = <choose a STRONG secret password, e.g. Fana#Owner2026>
   SESSION_SECRET = <a long random string, e.g. run:  openssl rand -base64 32>

   ⚠️ ALL THREE ARE REQUIRED IN PRODUCTION.
      - DATABASE_URL  → where your data lives.
      - ADMIN_PASSWORD → your admin login (used the FIRST time you sign in).
      - SESSION_SECRET → signs the admin/staff login cookies. If this is missing,
        the admin and staff logins are refused (on purpose, for security).

3. Deploy. Wait ~2 minutes.

4. ⭐ IMPORTANT — One-time database setup (do it IN THIS ORDER):
   a. Open  https://<your-railway-app>.up.railway.app/admin
   b. Log in with the ADMIN_PASSWORD you set above.
   c. THEN open this URL once (while logged in):
        https://<your-railway-app>.up.railway.app/api/setup
      It replies with JSON saying "Database is fully initialized".
      This seeds the default menu, categories, staff accounts, and tables.

   (The setup/seed endpoints are admin-only, so you must log in first — this is
    intentional, so strangers on the internet cannot initialize or reset your data.)

🎉 Your OFFICIAL website is now live at:
   https://<your-railway-app>.up.railway.app

✅ No localhost needed ever again.
✅ Tables auto-create & auto-repair on every request (self-healing schema).
✅ Orders & reviews save into the cloud database.
✅ Admin dashboard: /admin (log in with ADMIN_PASSWORD; changeable in Settings tab).
✅ Customers never see raw errors — just a friendly "call us" message.

════════════════════════════════════════
STEP 4 — CONNECT YOUR OWN DOMAIN (fanacafe.com) (optional, ~$10/year)
════════════════════════════════════════
1. Buy "fanacafe.com" from Namecheap, GoDaddy, or any registrar.
2. In Railway → your service → Settings → Networking → "Custom Domain" → add "fanacafe.com".
3. Railway shows the DNS records (CNAME + verification). Copy them into your
   registrar's DNS page.
4. Wait 5–30 minutes → https://fanacafe.com is LIVE with free HTTPS.

   Then also set  NEXT_PUBLIC_SITE_URL = https://fanacafe.com  so the sitemap
   and robots.txt use your real domain.

════════════════════════════════════════
HOW THE CAFE RUNS IT DAILY (owner manual)
════════════════════════════════════════
• Site manager opens  https://fanacafe.com/admin  on any phone/computer.
  Password = the ADMIN_PASSWORD from Railway env (changeable in Settings tab).
• Edit menu / prices / photos (upload from phone!) → Menu & Food Photos tab.
• Edit hero background → Website Copy & Hero Photo tab.
• Edit gallery photos → Gallery Manager tab.
• New orders & table reservations ring a DESKTOP POPUP alert in the admin tab.
• Google Maps info already filled: 2Q7Q+W2, 0911 065 022, 22 Square Town Square Bldg.
• Old receipt photos are cleared automatically every 24h (30+ days old) to save
  database space — no action needed.

════════════════════════════════════════
ENGLISH ⇄ አማርኛ LANGUAGE SYSTEM (how it works now)
════════════════════════════════════════
The 🌐 floating button switches the ENTIRE site instantly:
• All buttons, labels and messages → built-in dictionaries (instant, offline).
• Menu items, categories, announcements and texts YOU add later → translated
  automatically by Google Translate, but safely:
   - Google's engine runs on YOUR SERVER (/api/translate), never in the guest's
     browser. That means: NO Google banner popping over the menu, and the
     ordering system can never crash because of translation.
   - Every translated string is cached in the database (table "translations"),
     so each item is translated once — repeat loads are instant.
   - Orders, receipts and kitchen tickets always keep the original English
     item names, so staff never see mixed/broken text.
• Optional env var (only if your server blocks Google): TRANSLATE_API_BASE
  (default https://translate.googleapis.com) — point it at a proxy if needed.

════════════════════════════════════════
WHY IT BROKE ON YOUR LAPTOP (and never will again)
════════════════════════════════════════
- Localhost needed a local PostgreSQL; cloud uses Supabase/Railway Postgres instead (always online).
- Old downloaded files mixed with new code; Railway always builds fresh from GitHub.
- Cookie showed the admin dashboard at "/"; now "/" is ALWAYS the public site.
- Raw SQL errors shown to customers; now replaced with friendly phone-number messages.
