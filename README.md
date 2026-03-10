# GLWW Inventory Scanner v3

Barcode inventory count tool with **direct NetSuite API** integration. No middleware, no per-query costs. Built for the Munbyn IPDA101 (5.5" screen).

## Architecture

```
Munbyn IPDA101 (Chrome PWA)
    │
    │  POST /api/suiteql { query: "SELECT ..." }
    ▼
Vercel Serverless Function (/api/suiteql.js)
    │
    │  OAuth 1.0 signed request
    ▼
NetSuite REST API (SuiteQL endpoint)
    https://9405258.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql
```

- **Frontend**: React PWA (scans, tallies, exports CSV)
- **Backend**: Single Vercel serverless function that signs requests with OAuth 1.0 TBA and proxies SuiteQL queries to NetSuite
- **Auth**: Consumer key/secret + Token ID/secret stored as Vercel env vars (never exposed to browser)
- **Cost**: $0 per query. Vercel free tier handles this easily.

---

## Step 1: NetSuite Setup (One-Time, ~15 min)

### 1A. Enable Required Features

Go to **Setup → Company → Enable Features**:

- **SuiteCloud** tab:
  - SuiteScript: ✅ Client SuiteScript, ✅ Server SuiteScript
  - SuiteTalk (Web Services): ✅ **REST Web Services**
  - Manage Authentication: ✅ **Token-Based Authentication**

### 1B. Create a Role

Go to **Setup → Users/Roles → Manage Roles → New**:

- **Name**: `Inventory Scanner API`
- **Permissions** tab — add these:

| Category | Permission | Level |
|---|---|---|
| Transactions | Inventory Adjustment | Full |
| Lists | Items | View |
| Lists | Bins | View |
| Lists | Locations | View |
| Lists | Classifications | View |
| Reports | SuiteAnalytics Workbook | Edit |
| Setup | Log in using Access Tokens | Full |
| Setup | User Access Tokens | Full |
| Setup | REST Web Services | Full |

Save the role.

### 1C. Assign the Role to a User

Go to **Lists → Employees → [select user] → Edit → Access tab → Roles**:

- Add the `Inventory Scanner API` role
- Save

### 1D. Create an Integration Record

Go to **Setup → Integration → Manage Integrations → New**:

- **Name**: `GLWW Inventory Scanner`
- **Authentication** tab:
  - ✅ Token-Based Authentication
  - ❌ TBA: Authorization Flow (uncheck)
  - ❌ Authorization Code Grant (uncheck)
- **Save**

⚠️ **IMPORTANT**: After saving, the page displays the **Consumer Key** and **Consumer Secret**. Copy both NOW — they are only shown once.

### 1E. Create an Access Token

Go to **Setup → Users/Roles → Access Tokens → New Access Token**:

- **Application Name**: Select `GLWW Inventory Scanner`
- **User**: Select the user from step 1C
- **Role**: Select `Inventory Scanner API`
- **Save**

⚠️ **IMPORTANT**: Copy the **Token ID** and **Token Secret** — only shown once.

### Summary of Credentials

You should now have 5 values:

| Credential | Where It Came From |
|---|---|
| Account ID | `9405258` (from Company Information) |
| Consumer Key | Integration Record (step 1D) |
| Consumer Secret | Integration Record (step 1D) |
| Token ID | Access Token (step 1E) |
| Token Secret | Access Token (step 1E) |

---

## Step 2: Deploy to Vercel

### 2A. Push to GitHub

```bash
cd glww-inventory-scanner
npm install
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USER/glww-inventory-scanner.git
git push -u origin main
```

### 2B. Deploy on Vercel

1. Go to [vercel.com](https://vercel.com) → New Project → Import your GitHub repo
2. Framework: **Vite**
3. Before deploying, go to **Settings → Environment Variables** and add:

| Key | Value |
|---|---|
| `NS_ACCOUNT_ID` | `9405258` |
| `NS_CONSUMER_KEY` | *(from step 1D)* |
| `NS_CONSUMER_SECRET` | *(from step 1D)* |
| `NS_TOKEN_ID` | *(from step 1E)* |
| `NS_TOKEN_SECRET` | *(from step 1E)* |

4. Click **Deploy**
5. You'll get a URL like `glww-scanner.vercel.app`

### 2C. Test It

Open the Vercel URL in a browser. Click "Connect to NetSuite" — if classes and locations load, you're connected.

---

## Step 3: Munbyn IPDA101 Setup

### 3A. InfoWedge Configuration

1. Open **InfoWedge** on the IPDA101
2. Tap **Profile0 (Default)**
3. Tap **Basic Data Formatting** → Enable **"Send ENTER key"**
4. Tap **Configure Scanner Settings** → confirm UPC-A and EAN-13 are enabled
5. Optional: Create a new profile associated with Chrome for dedicated scan settings

### 3B. Install as PWA

1. Open **Chrome** on the Munbyn
2. Go to your Vercel URL
3. Tap Chrome menu (⋮) → **"Add to Home screen"**
4. Name it "Scanner" → Add
5. Launches fullscreen from home screen

### 3C. Recommended Settings

- **Display → Wake on Scan**: Enable
- **Display → Screen timeout**: 5+ minutes
- **Wi-Fi**: Connect to warehouse network

---

## Usage Workflow

1. Open app → tap **"Connect to NetSuite"**
2. Drill into class hierarchy → e.g. **Men's → Pants**
3. Select location → e.g. **Sales Floor**
4. Tap **"Pull Inventory & Start Scanning"**
5. Scan a **bin barcode** (e.g. F-01-0001) → see expected items in that bin
6. **Scan items** — items cross off as counts match
7. **Switch Bin** → repeat for next bin
8. **Finalize** → review all results by status
9. **Export NS Import CSV** → import into NetSuite

---

## NetSuite CSV Import

After exporting:

1. **Setup → Import/Export → Import CSV Records**
2. Import Type: **Transactions** → Record Type: **Inventory Adjustment**
3. Select **"Add"**
4. Map fields across three levels:

**Header:** External ID, Account, Location
**Adjustments:** Item, Adjust Qty By, Bin Number
**Inventory Detail:** Quantity, Bin Number

5. Save mapping → Run

---

## Local Development

```bash
npm install
npm run dev
```

For the API route locally, you'll need a small Express server or use `vercel dev`:

```bash
npm i -g vercel
vercel dev
```

This runs both the Vite frontend and the serverless function locally.

---

## File Structure

```
├── api/
│   └── suiteql.js          # Vercel serverless function (OAuth 1.0 → NetSuite)
├── src/
│   ├── App.jsx              # Main React app
│   └── main.jsx             # Entry point
├── public/
│   ├── manifest.json        # PWA manifest
│   ├── sw.js                # Service worker
│   └── icon.svg             # App icon
├── .env.example             # Environment variables template
├── index.html               # HTML entry
├── package.json
├── vercel.json              # Vercel config
└── vite.config.js
```
