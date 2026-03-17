# Solo Venture Intelligence

**A deep research tool that helps you identify the right solo business to start — based on who you actually are.**

Most business advice is generic. This tool isn't. It runs 44 targeted AI research calls against your specific profile — your skills, network, capital, location, risk tolerance, and constraints — and produces a full strategic report tailored to you.

→ **[Launch the app](https://nikastashinsky.github.io/solo-venture-intelligence/)**

---

## What it does

You fill out a 5-step profile. The tool then runs parallel AI research across four phases:

| Phase | What's happening |
|---|---|
| **Profiling** | Assesses your readiness, maps genuine strengths, surfaces blind spots, diagnoses your network gaps |
| **Market Analysis** | Scans macro signals, identifies high-opportunity sectors beyond tech, surfaces hidden market gaps specific to your location and background |
| **Opportunity Analysis** | Generates 3 tailored business opportunities ranked by fit — each with revenue projections, failure modes, and a 7-day validation checklist |
| **Playbooks** | For each opportunity: a positioning script, week-by-week launch plan, client acquisition channels, pricing tiers, and the specific mistakes to avoid |

The final **Synthesis** tab gives you a definitive recommendation, a Q1–Q4 Year 1 roadmap, and a pricing psychology diagnosis based on your history.

---

## How to use it

### Option A — Claude.ai (no setup required)

If you have a Claude account, you can run this directly as an artifact inside Claude. No API key needed — auth is handled automatically.

1. Open [Claude.ai](https://claude.ai)
2. Start a new conversation
3. Paste the full contents of `src/App.jsx` into the message
4. Claude will render it as an interactive artifact — click **Run Deep Research**

### Option B — GitHub Pages (hosted, bring your own key)

The live version is hosted at:

**[https://nikastashinsky.github.io/solo-venture-intelligence/](https://nikastashinsky.github.io/solo-venture-intelligence/)**

On first visit, you'll be asked how you're running the app:
- Select **GitHub Pages / Standalone**
- Enter your Anthropic API key (get one free at [console.anthropic.com](https://console.anthropic.com))

Your key is stored only in your browser's local storage. It is never sent to any server — all API calls go directly from your browser to Anthropic.

---

## The 5-step profile

The more honest and specific you are, the better the output.

| Step | What you're filling in |
|---|---|
| **Your Situation** | Location, current role, employment status, runway, dependents |
| **Background & Skills** | Industries, skills, technical level, previous business attempts, proof of work |
| **Network & Assets** | Who you know, social following, capital, languages, energy type |
| **Positioning & Constraints** | Unfair advantages, highest price ever charged, deal-breakers, work style |
| **Goals & Timeline** | Risk tolerance, time commitment, target income, timeline to revenue |

---

## Understanding your report

### Profile tab
- **Readiness Assessment** — honest verdict on whether you should go solo now or prep first
- **Genuine Strengths** — defensible advantages specific to your background, not generic
- **Blind Spots** — the self-deceptions most likely to trip you up
- **Network & Distribution Gap** — what relationships you're missing and what that means for getting clients

### Market tab
- **Timing Verdict** — given your specific constraints, is now the right time?
- **Macro Signals** — tailwinds and headwinds relevant to your industry background
- **High-Opportunity Sectors** — beyond tech, what's hot in your location right now
- **Hidden Market Gaps** — non-obvious opportunities based on your specific profile

### Opportunities tab
Three business options are presented:
- **Best Fit** — highest probability of success given your profile
- **Alternative** — a different industry or model
- **High Upside** — more ambitious, higher risk/reward

Each includes revenue projections (Year 1–3), margin, time to first dollar, failure modes, and a **7-day validation checklist** — 5 specific things you can do this week to test if the opportunity is real before committing.

### Playbooks tab
For each opportunity:
- **Positioning script** — what to say when someone asks what you do
- **Launch timeline** — week-by-week actions with milestones
- **Client acquisition** — real platforms named, with effort ratings
- **Pricing tiers** — entry, core, and premium anchored to your pricing history
- **AI as accelerator** — how to use AI tools even if your business isn't AI-focused
- **Fatal mistakes** — the specific errors most likely given your profile

### Synthesis tab
- **Final Recommendation** — a definitive pick, no hedging
- **Year 1 Roadmap** — Q1 through Q4 with measurable outcomes
- **What You'll Get Wrong** — the 3 most likely failure modes specific to you
- **Pricing Psychology Diagnosis** — why you might undercharge and the mindset shift required

---

## Downloading your report

Once the research completes, click **⬇ Download Report** to save a self-contained HTML file. Open it in any browser and use **Print / Save PDF** to keep a formatted copy.

Reports also auto-save to your browser so you can restore them on return visits without re-running all the research calls.

---

## Cost

Each full research run makes approximately 44 API calls to Claude Sonnet. At current Anthropic pricing, one complete report costs roughly **$0.10–0.20**.

---

## Running locally

```bash
git clone https://github.com/nikastashinsky/solo-venture-intelligence
cd solo-venture-intelligence
npm install
npm run dev
```

Open `http://localhost:5173`. For local dev you'll need an API key in `.env`:

```
VITE_ANTHROPIC_API_KEY=sk-ant-...
```

---

## Contributing

Issues and pull requests welcome. The entire app lives in `src/App.jsx`.
