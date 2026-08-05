# 🚀 OFFICIAL DEPLOYMENT GUIDE — Make Fana Cafe a Real Live Website
# (No more localhost problems — deploy once, works forever)

This guide turns the code into an official website like **https://fanacafe.com**
with a real cloud database, admin dashboard, and 24/7 online orders.

You already opened these accounts — perfect:
✅ GitHub (your browser tab "Repository")
✅ Neon (your browser tab "Neon Console") — free cloud PostgreSQL
Need one more (free): Vercel — https://vercel.com (login with your GitHub account)

════════════════════════════════════════
STEP 1 — PUSH THE CODE TO GITHUB (5 minutes)
════════════════════════════════════════
1. Go to https://github.com/new — create a repository (e.g. "fana-cafe").
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
STEP 2 — CREATE THE CLOUD DATABASE (Neon) (5 minutes)
════════════════════════════════════════
1. Open https://console.neon.tech (you already have this tab open).
2. Create a new project → name it "fana-cafe".
3. After creation, copy the "Connection String" — it looks like:
   postgresql://user:password@ep-xxxx-region.aws.neon.tech/dbname?sslmode=require
   THIS IS YOUR OFFICIAL DATABASE_URL — keep it safe.

════════════════════════════════════════
STEP 3 — DEPLOY TO VERCEL (5 minutes)
════════════════════════════════════════
1. Go to https://vercel.com → Sign Up with GitHub.
2. Click "Add New Project" → Import your "fana-cafe" repository.
3. Before clicking Deploy, open "Environment Variables" and add:

   DATABASE_URL  =  <paste your Neon connection string from Step 2>
   ADMIN_PASSWORD = <choose a STRONG secret password, e.g. Fana#Owner2026>

4. Click "Deploy". Wait ~2 minutes. Done!

5. ⭐ IMPORTANT — One-time database setup:
   Open this URL once in your browser:
     https://<your-vercel-site>.vercel.app/api/setup
   It will reply with JSON saying "Database is fully initialized"
   (it creates orders/menu/reservations tables and fixes any old broken ones).

🎉 Your OFFICIAL website is now live at:
   https://fana-cafe.vercel.app   (free Vercel address)

✅ No localhost needed ever again.
✅ Tables auto-create & auto-repair on every request (self-healing schema).
✅ Orders & reservations save into the Neon cloud database.
✅ Admin dashboard: https://fana-cafe.vercel.app/admin
   (log in with the ADMIN_PASSWORD you set in Step 3)
✅ Customers never see raw errors — just a friendly "call us" message.

════════════════════════════════════════
STEP 4 — CONNECT YOUR OWN DOMAIN (fanacafe.com) (optional, ~$10/year)
════════════════════════════════════════
1. Buy "fanacafe.com" from Namecheap, GoDaddy, or any registrar.
2. In Vercel → Project → Settings → Domains → Add "fanacafe.com".
3. Vercel shows you DNS records (1 A-record + 1 CNAME).
4. Copy those into your Namecheap/GoDaddy DNS page.
5. Wait 5–30 minutes → https://fanacafe.com is LIVE with free HTTPS.

════════════════════════════════════════
HOW THE CAFE RUNS IT DAILY (owner manual)
════════════════════════════════════════
• Site manager opens  https://fanacafe.com/admin  on any phone/computer.
  Password = the ADMIN_PASSWORD from Vercel env (changeable in Settings tab).
• Edit menu / prices / photos (upload from phone!) → Menu & Food Photos tab.
• Edit hero background → Website Copy & Hero Photo tab.
• Edit gallery photos → Gallery Manager tab.
• New orders & table reservations ring a DESKTOP POPUP alert in the admin tab.
• Google Maps info already filled: 2Q7Q+W2, 0911 065 022, 22 Square Golagul Bldg.

════════════════════════════════════════
WHY IT BROKE ON YOUR LAPTOP (and never will again)
════════════════════════════════════════
- Localhost needed a local PostgreSQL; cloud uses Neon instead (always online).
- Old downloaded files mixed with new code; Vercel always builds fresh from GitHub.
- Cookie showed the admin dashboard at "/"; now "/" is ALWAYS the public site.
- Raw SQL errors shown to customers; now replaced with friendly phone-number messages.
