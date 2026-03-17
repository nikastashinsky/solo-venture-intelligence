import { useState, useEffect, useRef } from "react";

// ─── TOKENS ───────────────────────────────────────────────────────────────────
const T = {
  bg:"#07080f", panel:"#0c0e1a", panel2:"#101320", border:"#1a1d30",
  accent:"#6471f5", accentDim:"#6471f522", gold:"#e9c96b", goldDim:"#e9c96b18",
  green:"#34d399", greenDim:"#34d39918", red:"#f87171", redDim:"#f8717110",
  amber:"#fbbf24", purple:"#a78bfa",
  text:"#e8eaf6", muted:"#5a6080", faint:"#2e3355",
  font:"'DM Sans',system-ui,sans-serif",
  serif:"'Playfair Display',Georgia,serif",
  mono:"'JetBrains Mono','Fira Mono',monospace",
};
const CONF_COLOR = { high: T.green, medium: T.amber, low: T.red };

// ─── API KEY STORAGE ──────────────────────────────────────────────────────────
const API_KEY_STORAGE = "svi_api_key";
function getApiKey() { try { return localStorage.getItem(API_KEY_STORAGE) || ""; } catch { return ""; } }
function setApiKey(k) { try { localStorage.setItem(API_KEY_STORAGE, k); } catch {} }
function clearApiKey() { try { localStorage.removeItem(API_KEY_STORAGE); } catch {} }

// ─── API ──────────────────────────────────────────────────────────────────────
async function ask(sys, user, tokens = 420) {
  const key = getApiKey();
  const headers = { "Content-Type": "application/json" };
  if (key) {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: tokens,
      system: sys,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.content?.[0]?.text?.trim() ?? "";
}

// ─── PARALLEL BATCH RUNNER ────────────────────────────────────────────────────
// Runs up to `limit` tasks concurrently, calls onResult after each completes
async function runBatch(tasks, onResult, limit = 5) {
  const queue = [...tasks];
  const active = new Set();
  await new Promise((resolve) => {
    const next = () => {
      while (active.size < limit && queue.length > 0) {
        const task = queue.shift();
        const p = task().then(onResult).finally(() => { active.delete(p); next(); });
        active.add(p);
      }
      if (active.size === 0 && queue.length === 0) resolve();
    };
    next();
  });
}

// ─── PARSERS ──────────────────────────────────────────────────────────────────
const grabLine = (text, label) => {
  const m = text.match(new RegExp(label + "[:\\s]+([^\\n|]+)", "i"));
  return m ? m[1].trim() : "";
};
const grabNum = (text, label) => {
  const m = text.match(new RegExp(label + "[:\\s]+\\$?([\\d,KkMm\\.]+)", "i"));
  return m ? m[1] : "—";
};
const parseRevenue = (t = "") => ({
  y1: grabNum(t, "Y1"), y2: grabNum(t, "Y2"), y3: grabNum(t, "Y3"),
  margin: (t.match(/MARGIN[:\s]+(\d+)/i) || [])[1] || "—",
  ttf: grabLine(t, "TIME_TO_FIRST_\\$"),
  confidence: (t.match(/CONFIDENCE[:\s]+(high|medium|low)/i) || [, "medium"])[1],
});
const parsePricing = (t = "") => ({
  entry: grabLine(t, "ENTRY"), core: grabLine(t, "CORE"),
  premium: grabLine(t, "PREMIUM"), rationale: grabLine(t, "RATIONALE"),
});
const parseMacro = (t = "") => t.split("\n").filter(l => l.includes("|")).map(l => {
  const p = l.split("|").map(s => s.trim());
  return { signal: p[0] || "", direction: (p[1] || "").toLowerCase(), implication: p[2] || "" };
}).filter(r => r.signal);
const parseWeeks = (t = "") => t.split(/\|\|/).map(chunk => {
  const wm = chunk.match(/WEEK\s+([\d\-–]+)[:\s]/i);
  const mm = chunk.match(/MILESTONE[:\s]+([^|]+)/i);
  const acts = chunk.replace(/WEEK[^:]+:/i, "").replace(/MILESTONE[^\n|]*/gi, "")
    .split("\n").map(l => l.replace(/^[-•→\d.]+\s*/, "").trim()).filter(l => l.length > 8);
  return wm ? { week: wm[1], milestone: mm ? mm[1].trim() : "", actions: acts.slice(0, 3) } : null;
}).filter(Boolean);
const parseAcq = (t = "") => t.split("\n").filter(l => l.trim().length > 12 && l.includes(":")).map(l => {
  const em = l.match(/effort:\s*(low|medium|high)/i);
  const effort = em ? em[1].toLowerCase() : "medium";
  const ci = l.lastIndexOf(":");
  return { channel: l.slice(0, ci).replace(/\(effort:[^)]+\)/i, "").trim(), tactic: l.slice(ci + 1).trim(), effort };
}).filter(a => a.channel && a.tactic.length > 5).slice(0, 3);
const parseLeverage = (t = "") => ({
  leadMagnet: grabLine(t, "LEAD MAGNET"),
  aiLeverage: grabLine(t, "AI LEVERAGE"),
  scalePath: grabLine(t, "SCALE PATH"),
  mistakes: [...t.matchAll(/\d+\.\s+([^\n]+)/g)].map(m => m[1].trim()).slice(0, 3),
});
const parseQs = (t = "") => [...t.matchAll(/Q(\d)[:\s]+([^|Q\n][^\n]+)/gi)]
  .map(m => ({ q: m[1], content: m[2].trim() })).slice(0, 4);
const parseValidation = (t = "") => t.split("\n")
  .filter(l => /^\d+\./.test(l.trim()))
  .map(l => l.replace(/^\d+\.\s*/, "").trim()).filter(l => l.length > 10).slice(0, 5);

// ─── STORAGE ──────────────────────────────────────────────────────────────────
const STORAGE_KEY = "svi_last_report";
function saveReport(profile, results) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ profile, results, savedAt: Date.now() })); } catch (e) {}
}
function loadReport() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return null;
}

// ─── HTML REPORT ──────────────────────────────────────────────────────────────
function generateReport(profile, results) {
  const R = results;
  const name = profile.name || "Founder";
  const date = new Date().toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
  const o1Name = R.o1_title || "Best-Fit Opportunity";
  const o2Name = R.o2_title || "Alternative Opportunity";
  const o3Name = R.o3_title || "High-Upside Opportunity";

  const box = (label, text, color = "#1a1d30") => text ? `
    <div class="box" style="border-left:4px solid ${color}">
      <div class="label">${label}</div><p>${text.replace(/\n/g, "<br/>")}</p>
    </div>` : "";

  const revRow = (key) => {
    const t = R[key] || "";
    const g = (l) => { const m = t.match(new RegExp(l + "[:\\s]+\\$?([\\d,KkMm\\.]+)", "i")); return m ? m[1] : "—"; };
    const conf = (t.match(/CONFIDENCE[:\s]+(high|medium|low)/i) || [, "medium"])[1];
    const ttf = (t.match(/TIME_TO_FIRST_\$[:\s]+([^\n|]+)/i) || [])[1] || "—";
    const margin = (t.match(/MARGIN[:\s]+(\d+)/i) || [])[1];
    const r = { y1: g("Y1"), y2: g("Y2"), y3: g("Y3"), margin: margin ? margin + "%" : "—", ttf: ttf.trim(), conf };
    return r.y1 === "—" ? "" : `<table class="rev-table">
      <tr><th>Year 1</th><th>Year 2</th><th>Year 3</th><th>Margin</th><th>Time to First $</th><th>Confidence</th></tr>
      <tr><td><strong>${r.y1}</strong></td><td><strong>${r.y2}</strong></td><td><strong>${r.y3}</strong></td>
          <td>${r.margin}</td><td>${r.ttf}</td><td class="conf-${r.conf}">${r.conf}</td></tr>
    </table>`;
  };

  const validate = (key) => {
    const lines = (R[key] || "").split("\n").filter(l => /^\d+\./.test(l.trim())).map(l => l.replace(/^\d+\.\s*/, "").trim()).filter(l => l.length > 10);
    return lines.length ? "<ol>" + lines.map(l => `<li>${l}</li>`).join("") + "</ol>" : (R[key] ? `<p>${R[key]}</p>` : "");
  };

  const oppBlock = (n, name, cKey, mKey, rKey, riskKey, vKey) => `
    <div class="opp-block">
      <h3>Opportunity ${n}: ${name}</h3>
      ${revRow(rKey)}
      ${box("Business Concept", R[cKey], "#34d399")}
      ${box("Market & Comparables", R[mKey], "#6471f5")}
      ${box("Failure Modes", R[riskKey], "#f87171")}
      ${R[vKey] ? `<div class="box" style="border-left:4px solid #34d399"><div class="label">7-Day Validation Checklist</div>${validate(vKey)}</div>` : ""}
    </div>`;

  const pbBlock = (n, name, pitchKey, launchKey, clientKey, pricingKey, leverageKey) => {
    const pricing = parsePricing(R[pricingKey] || "");
    const lev = parseLeverage(R[leverageKey] || "");
    return `
    <div class="opp-block">
      <h3>Playbook ${n}: ${name}</h3>
      ${R[pitchKey] ? `<div class="pitch-box"><em>"${R[pitchKey]}"</em></div>` : ""}
      ${box("Launch Timeline", R[launchKey], "#6471f5")}
      ${box("Client Acquisition", R[clientKey], "#e9c96b")}
      <div class="pricing-grid">
        <div class="pricing-tier"><div class="label">Entry</div><p>${pricing.entry || "—"}</p></div>
        <div class="pricing-tier"><div class="label">Core</div><p>${pricing.core || "—"}</p></div>
        <div class="pricing-tier"><div class="label">Premium</div><p>${pricing.premium || "—"}</p></div>
      </div>
      ${lev.leadMagnet ? box("Lead Magnet", lev.leadMagnet, "#6471f5") : ""}
      ${lev.aiLeverage ? box("AI as Accelerator", lev.aiLeverage, "#a78bfa") : ""}
      ${lev.mistakes.length ? `<div class="box danger"><div class="label">Fatal Mistakes</div><ol>${lev.mistakes.map(m => `<li>${m}</li>`).join("")}</ol></div>` : ""}
    </div>`;
  };

  const yqs = parseQs(R.yearone || "");

  const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SVI Report — ${name}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;1,400&family=DM+Sans:wght@400;500;600&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'DM Sans',sans-serif;font-size:13px;color:#1a1a2e;background:#fff;line-height:1.7}
  @media print{.no-print{display:none!important}@page{margin:2cm;size:A4}}
  .cover{background:linear-gradient(135deg,#07080f,#0d1035);color:#fff;padding:60px;min-height:200px}
  .cover h1{font-family:'Playfair Display',serif;font-size:34px;font-weight:700;line-height:1.2;margin-bottom:10px}
  .cover h1 em{color:#6471f5;font-style:italic}
  .cover-meta{font-size:11px;color:#5a6080;margin-top:16px}
  .cover-tag{display:inline-block;background:#6471f522;border:1px solid #6471f544;border-radius:3px;padding:2px 10px;font-size:9px;letter-spacing:2px;color:#8891f8;text-transform:uppercase;margin-right:6px;margin-top:6px}
  .content{max-width:820px;margin:0 auto;padding:40px}
  h2{font-family:'Playfair Display',serif;font-size:20px;font-weight:700;color:#07080f;margin:36px 0 14px;padding-bottom:8px;border-bottom:2px solid #e8e8f0}
  h3{font-family:'Playfair Display',serif;font-size:16px;font-weight:700;color:#07080f;margin:22px 0 10px}
  p{color:#2a2a3e;margin-bottom:10px;font-size:13px}
  ol{padding-left:20px;color:#2a2a3e;margin-bottom:10px}li{margin-bottom:6px;font-size:13px}
  .label{font-size:8px;letter-spacing:3px;text-transform:uppercase;color:#5a6080;margin-bottom:5px;font-weight:600}
  .box{background:#f8f8fc;border-left:4px solid #6471f5;padding:14px 16px;border-radius:0 6px 6px 0;margin-bottom:12px}
  .box.danger{background:#fff5f5;border-left-color:#f87171}
  .pitch-box{background:#f0f1ff;border-left:4px solid #6471f5;padding:14px 18px;border-radius:0 6px 6px 0;margin-bottom:16px;font-style:italic;font-size:14px}
  .rev-table{width:100%;border-collapse:collapse;margin-bottom:16px;font-size:12px}
  .rev-table th{background:#07080f;color:#fff;padding:8px 12px;text-align:left;font-size:9px;letter-spacing:2px;text-transform:uppercase}
  .rev-table td{padding:10px 12px;border-bottom:1px solid #e8e8f0;font-weight:600;font-size:14px}
  .conf-high{color:#059669}.conf-medium{color:#b45309}.conf-low{color:#dc2626}
  .opp-block{background:#fafafa;border:1px solid #e8e8f0;border-radius:8px;padding:24px;margin-bottom:20px}
  .opp-block h3{margin-top:0;border-bottom:1px solid #e8e8f0;padding-bottom:10px;margin-bottom:16px}
  .pricing-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px}
  .pricing-tier{background:#fff;border:1px solid #e8e8f0;border-radius:6px;padding:12px}
  .footer{margin-top:60px;padding-top:20px;border-top:1px solid #e8e8f0;display:flex;justify-content:space-between;font-size:10px;color:#9090a0}
  .print-btn{position:fixed;bottom:24px;right:24px;background:#6471f5;color:#fff;border:none;padding:12px 22px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:0 4px 20px #6471f544}
</style></head><body>
<button class="print-btn no-print" onclick="window.print()">Print / Save PDF</button>
<div class="cover">
  <div style="font-size:9px;letter-spacing:5px;color:#6471f5;text-transform:uppercase;margin-bottom:14px">Solo Venture Intelligence · Confidential</div>
  <h1>Business Opportunity<br/>Report for <em>${name}</em></h1>
  <div>${[profile.currentRole, profile.location, profile.yearsExperience ? profile.yearsExperience + "yr exp" : ""].filter(Boolean).map(t => `<span class="cover-tag">${t}</span>`).join("")}</div>
  <div class="cover-meta">Generated ${date} &nbsp;·&nbsp; ${profile.location || "—"} &nbsp;·&nbsp; Target: ${profile.targetIncome ? "$" + profile.targetIncome : "—"}/yr</div>
</div>
<div class="content">
  <h2>1. Profile Assessment</h2>
  ${box("Readiness Assessment", R.readiness, "#fbbf24")}
  ${box("Genuine Strengths", R.strengths, "#34d399")}
  ${box("Blind Spots", R.blindspots, "#f87171")}
  ${box("Network & Distribution Gap", R.networkgap, "#a78bfa")}

  <h2>2. Market Intelligence</h2>
  ${box("Timing Verdict", R.timing, "#e9c96b")}
  ${R.sectors ? `<h3>High-Opportunity Sectors</h3>${box("", R.sectors)}` : ""}
  ${R.hidden ? `<h3>Hidden Market Gaps</h3>${box("", R.hidden)}` : ""}

  <h2>3. Opportunity Analysis</h2>
  ${oppBlock(1, o1Name, "o1_concept", "o1_market", "o1_revenue", "o1_risks", "o1_validate")}
  ${oppBlock(2, o2Name, "o2_concept", "o2_market", "o2_revenue", "o2_risks", "o2_validate")}
  ${oppBlock(3, o3Name, "o3_concept", "o3_market", "o3_revenue", "o3_risks", "o3_validate")}

  <h2>4. Launch Playbooks</h2>
  ${pbBlock(1, o1Name, "p1_pitch", "p1_launch", "p1_clients", "p1_pricing", "p1_leverage")}
  ${pbBlock(2, o2Name, "p2_pitch", "p2_launch", "p2_clients", "p2_pricing", "p2_leverage")}
  ${pbBlock(3, o3Name, "p3_pitch", "p3_launch", "p3_clients", "p3_pricing", "p3_leverage")}

  <h2>5. Synthesis & Recommendation</h2>
  ${R.recommendation ? `<div class="box" style="border-left:4px solid #34d399"><div class="label">Final Recommendation</div><p style="font-size:15px;font-family:'Playfair Display',serif">${R.recommendation}</p></div>` : ""}
  ${yqs.length ? `<h3>Year 1 Roadmap</h3><ol>${yqs.map(q => `<li><strong>Q${q.q}:</strong> ${q.content}</li>`).join("")}</ol>` : (R.yearone ? box("Year 1 Roadmap", R.yearone) : "")}
  ${box("What You'll Get Wrong", R.redflags, "#f87171")}
  ${box("Pricing Psychology Diagnosis", R.pricingpsych, "#fbbf24")}

  <div class="footer"><span>Solo Venture Intelligence · ${date} · ${name}</span><span>Confidential</span></div>
</div></body></html>`;

  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `SVI-Report-${name.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.html`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── PROFILE DEFAULTS ─────────────────────────────────────────────────────────
const BLANK = {
  name: "", location: "", age: "",
  employmentStatus: "employed", monthlyRunway: "", dependents: "none",
  currentRole: "", yearsExperience: "", industries: "", skills: "",
  technicalLevel: "moderate", prevBizAttempts: "none",
  executionTrack: "", proofOfWork: "",
  networkQuality: "", socialFollowing: "none",
  marketingBudget: "", capitalAvailable: "",
  languages: "", energyType: "ambi",
  unfairAdvantages: "", interestedSectors: "", mustAvoid: "",
  highestCharged: "", workStyle: "",
  riskTolerance: "medium", timeCommitment: "fulltime",
  targetIncome: "", timelineToRevenue: "6months",
};

// ─── RESEARCH QUESTIONS ───────────────────────────────────────────────────────
function buildQuestions(p) {
  const ctx = `FOUNDER PROFILE (early 2026):
Name: ${p.name || "Founder"} | Location: ${p.location} | Age: ${p.age}
Employment: ${p.employmentStatus} | Monthly Runway: ${p.monthlyRunway || "unknown"} months | Dependents: ${p.dependents}
Role: ${p.currentRole} | Experience: ${p.yearsExperience} years
Industries: ${p.industries} | Skills: ${p.skills}
Technical level: ${p.technicalLevel} | Previous business attempts: ${p.prevBizAttempts}
Execution track record: ${p.executionTrack || "not specified"}
Proof of work: ${p.proofOfWork || "not specified"}
Network: ${p.networkQuality || "not specified"}
Social following: ${p.socialFollowing} | Marketing budget: ${p.marketingBudget || 0}/mo | Capital: ${p.capitalAvailable || 0}
Languages: ${p.languages || "English only"} | Energy type: ${p.energyType}
Unfair advantages: ${p.unfairAdvantages || "not specified"}
Highest ever charged: ${p.highestCharged || "not specified"}
Sectors of interest: ${p.interestedSectors || "open"} | Must avoid: ${p.mustAvoid || "nothing"}
Work style: ${p.workStyle || "flexible"} | Risk tolerance: ${p.riskTolerance}
Time commitment: ${p.timeCommitment} | Target income: ${p.targetIncome}/yr | Timeline: ${p.timelineToRevenue}`;

  const SYS = `You are a senior partner at a top-tier strategy firm. Deep expertise across all industries — consumer, healthcare, finance, real estate, media, education, professional services, manufacturing, technology. Brutally honest, hyper-specific, never generic. Plain prose or numbered lists. No bullet symbols, asterisks, or markdown headers. Early 2026.`;

  return [
    { key: "readiness", label: "Assessing solo business readiness", prompt: `${ctx}\n\nHonest readiness assessment for going solo. Consider runway (${p.monthlyRunway || "unknown"} months), employment status (${p.employmentStatus}), dependents (${p.dependents}), execution track record. Ready now or not? 3-4 sentences. No flattery.` },
    { key: "strengths", label: "Mapping genuine strengths", prompt: `${ctx}\n\n3 most defensible strengths for building a solo business — specific to their actual background, not generic. Number 1-3. One concrete sentence each.` },
    { key: "blindspots", label: "Identifying blind spots", prompt: `${ctx}\n\n3 most likely blind spots or self-deceptions about starting a business. Consider pricing history (${p.highestCharged || "unknown"}), energy type (${p.energyType}), previous attempts (${p.prevBizAttempts}). Specific and honest. Number 1-3.` },
    { key: "networkgap", label: "Analyzing network & distribution gaps", prompt: `${ctx}\n\nBiggest distribution and network gaps. Following: ${p.socialFollowing}, network: "${p.networkQuality || "unspecified"}". What specific relationships are missing? 3-4 sentences.` },
    { key: "macro", label: "Scanning macro economic signals", prompt: `${ctx}\n\n4 macro signals most relevant to this person's background in ${p.industries} launching in ${p.location} in early 2026. Format each line: SIGNAL | tailwind or headwind | what this means for this person specifically. One per line. No other text.` },
    { key: "sectors", label: "Identifying high-opportunity sectors", prompt: `${ctx}\n\n5 highest-opportunity sectors for a solo in ${p.location} in early 2026. Beyond technology. Weight demographic shifts, regulatory changes, underserved markets. Number 1-5. Format: SECTOR NAME: why hot + how it fits this person.` },
    { key: "timing", label: "Assessing personal market timing", prompt: `${ctx}\n\nBlunt 3-sentence verdict: given runway (${p.monthlyRunway || "unknown"} months), capital (${p.capitalAvailable || 0}), dependents (${p.dependents}), risk tolerance (${p.riskTolerance}) — is now the right time? If not, when and what needs to change?` },
    { key: "hidden", label: "Surfacing non-obvious market gaps", prompt: `${ctx}\n\n4 hidden market gaps this person can fill that they probably haven't thought of. Based on background in ${p.industries}, location ${p.location}, languages (${p.languages || "English"}), energy type (${p.energyType}). Surprising. Number 1-4. Format: GAP: why underserved + why this person.` },
    { key: "o1_title", label: "Identifying best-fit opportunity", prompt: `${ctx}\n\nSingle best solo business opportunity for this person. Highest probability of success. Do NOT default to AI consulting unless genuinely best fit. Consider all industries. Just the title in 4-8 words. Nothing else.` },
    { key: "o1_concept", label: "Defining Opportunity 1", prompt: `${ctx}\n\nBest-fit solo opportunity: what it is, exact customer, revenue model, why this person specifically. Account for energy type (${p.energyType}), highest price charged (${p.highestCharged || "unknown"}), proof of work (${p.proofOfWork || "none"}). 3-4 sentences.` },
    { key: "o1_market", label: "Sizing Opportunity 1", prompt: `${ctx}\n\nBest-fit opportunity: realistic market for a solo in ${p.location}. What do customers pay? 2-3 real analogues. 3-4 sentences.` },
    { key: "o1_revenue", label: "Modeling Opportunity 1 revenue", prompt: `${ctx}\n\nConservative revenue for best-fit opportunity. One line exactly: Y1: $X | Y2: $X | Y3: $X | MARGIN: X% | TIME_TO_FIRST_$: X | CONFIDENCE: high/medium/low` },
    { key: "o1_risks", label: "Stress-testing Opportunity 1", prompt: `${ctx}\n\nBest-fit opportunity: 3 most likely failure modes given this founder's profile. One sentence on wild success condition. Number 1-3.` },
    { key: "o1_validate", label: "Building Opportunity 1 validation checklist", prompt: `${ctx}\n\nBest-fit opportunity: 5 specific things to do in the next 7 days to test if it's real. Name who to talk to, what to ask, positive signal. Number 1-5.` },
    { key: "o2_title", label: "Identifying alternative opportunity", prompt: `${ctx}\n\nSecond solo business opportunity — genuinely different industry or model. Just the title in 4-8 words.` },
    { key: "o2_concept", label: "Defining Opportunity 2", prompt: `${ctx}\n\nSecond opportunity: what it is, exact customer, model, why this person. 3-4 sentences.` },
    { key: "o2_market", label: "Sizing Opportunity 2", prompt: `${ctx}\n\nSecond opportunity: market in ${p.location}. Customer pricing, 2-3 analogues. 3-4 sentences.` },
    { key: "o2_revenue", label: "Modeling Opportunity 2 revenue", prompt: `${ctx}\n\nRevenue for second opportunity. One line: Y1: $X | Y2: $X | Y3: $X | MARGIN: X% | TIME_TO_FIRST_$: X | CONFIDENCE: high/medium/low` },
    { key: "o2_risks", label: "Stress-testing Opportunity 2", prompt: `${ctx}\n\n3 failure modes for second opportunity. Wild-success condition. Number 1-3.` },
    { key: "o2_validate", label: "Building Opportunity 2 validation checklist", prompt: `${ctx}\n\nSecond opportunity: 5 specific 7-day validation actions. Number 1-5.` },
    { key: "o3_title", label: "Identifying high-upside opportunity", prompt: `${ctx}\n\nThird, highest-upside opportunity — ambitious, unconventional, high risk/reward. Just the title in 4-8 words.` },
    { key: "o3_concept", label: "Defining Opportunity 3", prompt: `${ctx}\n\nHigh-upside opportunity: ambitious, unconventional, large ceiling. What, exact customer, model, why this person. 3-4 sentences.` },
    { key: "o3_market", label: "Sizing Opportunity 3", prompt: `${ctx}\n\nHigh-upside opportunity: market in ${p.location}. Pricing, 2-3 analogues. 3-4 sentences.` },
    { key: "o3_revenue", label: "Modeling Opportunity 3 revenue", prompt: `${ctx}\n\nRevenue for high-upside opportunity. One line: Y1: $X | Y2: $X | Y3: $X | MARGIN: X% | TIME_TO_FIRST_$: X | CONFIDENCE: high/medium/low` },
    { key: "o3_risks", label: "Stress-testing Opportunity 3", prompt: `${ctx}\n\n3 failure modes for high-upside opportunity. Wild-success condition. Number 1-3.` },
    { key: "o3_validate", label: "Building Opportunity 3 validation checklist", prompt: `${ctx}\n\nHigh-upside opportunity: 5 specific 7-day validation actions. Number 1-5.` },
    { key: "compare", label: "Comparing all three opportunities", prompt: `${ctx}\n\nCompare all 3 opportunities. One line per dimension: DIMENSION: Opp1 vs Opp2 vs Opp3. Dimensions: REVENUE CEILING, TIME TO FIRST CLIENT, CAPITAL REQUIRED, FITS ENERGY TYPE, NETWORK LEVERAGE, SKILL FIT, BIGGEST RISK, BEST FOR PROFILE TYPE` },
    { key: "p1_pitch", label: "Writing Playbook 1: positioning", prompt: `${ctx}\n\nBest-fit opportunity: 2-sentence positioning statement for when asked "what do you do?" Specific to their background. No jargon.` },
    { key: "p1_launch", label: "Writing Playbook 1: launch plan", prompt: `${ctx}\n\nBest-fit opportunity with ${p.capitalAvailable || 0} capital and ${p.socialFollowing} following: WEEK 1-2: [3 specific actions] | MILESTONE: [outcome] || WEEK 3-6: [3 actions] | MILESTONE: [outcome] || WEEK 7-12: [3 actions] | MILESTONE: [outcome]` },
    { key: "p1_clients", label: "Writing Playbook 1: client acquisition", prompt: `${ctx}\n\nBest-fit opportunity: 3 client acquisition strategies. Name real platforms/communities. CHANNEL NAME (effort: low/medium/high): [exact steps]` },
    { key: "p1_pricing", label: "Writing Playbook 1: pricing", prompt: `${ctx}\n\nBest-fit pricing. ENTRY: [price — included] | CORE: [price — included] | PREMIUM: [price — included] | RATIONALE: [one sentence]` },
    { key: "p1_leverage", label: "Writing Playbook 1: leverage & mistakes", prompt: `${ctx}\n\nBest-fit: LEAD MAGNET: [specific asset] | AI LEVERAGE: [how AI tools accelerate] | SCALE PATH: [beyond solo] | FATAL MISTAKES: 1. [specific] 2. [mistake] 3. [mistake]` },
    { key: "p2_pitch", label: "Writing Playbook 2: positioning", prompt: `${ctx}\n\nSecond opportunity: 2-sentence positioning statement. Specific, no jargon.` },
    { key: "p2_launch", label: "Writing Playbook 2: launch plan", prompt: `${ctx}\n\nSecond opportunity: WEEK 1-2: [3 actions] | MILESTONE: [outcome] || WEEK 3-6: [3 actions] | MILESTONE: [outcome] || WEEK 7-12: [3 actions] | MILESTONE: [outcome]` },
    { key: "p2_clients", label: "Writing Playbook 2: client acquisition", prompt: `${ctx}\n\nSecond opportunity: 3 acquisition strategies. CHANNEL NAME (effort: low/medium/high): [exact steps]` },
    { key: "p2_pricing", label: "Writing Playbook 2: pricing", prompt: `${ctx}\n\nSecond opportunity: ENTRY: [price — included] | CORE: [price — included] | PREMIUM: [price — included] | RATIONALE: [one sentence]` },
    { key: "p2_leverage", label: "Writing Playbook 2: leverage & mistakes", prompt: `${ctx}\n\nSecond opportunity: LEAD MAGNET: [specific] | AI LEVERAGE: [how AI helps] | SCALE PATH: [growth] | FATAL MISTAKES: 1. [specific] 2. [mistake] 3. [mistake]` },
    { key: "p3_pitch", label: "Writing Playbook 3: positioning", prompt: `${ctx}\n\nHigh-upside opportunity: 2-sentence positioning statement.` },
    { key: "p3_launch", label: "Writing Playbook 3: launch plan", prompt: `${ctx}\n\nHigh-upside: WEEK 1-2: [3 actions] | MILESTONE: [outcome] || WEEK 3-6: [3 actions] | MILESTONE: [outcome] || WEEK 7-12: [3 actions] | MILESTONE: [outcome]` },
    { key: "p3_clients", label: "Writing Playbook 3: client acquisition", prompt: `${ctx}\n\nHigh-upside: CHANNEL NAME (effort: low/medium/high): [exact steps] x3` },
    { key: "p3_pricing", label: "Writing Playbook 3: pricing", prompt: `${ctx}\n\nHigh-upside: ENTRY: [price — included] | CORE: [price — included] | PREMIUM: [price — included] | RATIONALE: [one sentence]` },
    { key: "p3_leverage", label: "Writing Playbook 3: leverage & mistakes", prompt: `${ctx}\n\nHigh-upside: LEAD MAGNET: [specific] | AI LEVERAGE: [accelerates how] | SCALE PATH: [growth] | FATAL MISTAKES: 1. [specific] 2. [mistake] 3. [mistake]` },
    { key: "recommendation", label: "Synthesizing final recommendation", prompt: `${ctx}\n\nWhich ONE opportunity should this founder pursue first? Definitive. Weight runway, capital, dependents, energy type, risk tolerance. 3-4 sentences. No hedging.` },
    { key: "yearone", label: "Mapping Year 1 quarter by quarter", prompt: `${ctx}\n\nRecommended opportunity Year 1: Q1: [priority + measurable outcome] | Q2: [priority + outcome] | Q3: [priority + outcome] | Q4: [priority + outcome]` },
    { key: "redflags", label: "Flagging likely failure modes", prompt: `${ctx}\n\n3 things this founder is most likely to get wrong going solo. Not generic — specific to their profile. Number 1-3.` },
    { key: "pricingpsych", label: "Diagnosing pricing psychology", prompt: `${ctx}\n\nHighest charge: ${p.highestCharged || "unknown"}. Target income: ${p.targetIncome || 0}/yr. Diagnose the pricing psychology gap and specific mindset shift required. 3-4 sentences.` },
  ];
}

// ─── DESIGN COMPONENTS ────────────────────────────────────────────────────────
const globalCSS = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;0,700;1,400&family=DM+Sans:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  ::-webkit-scrollbar{width:3px}::-webkit-scrollbar-thumb{background:#22253a;border-radius:2px}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  @keyframes pulse{0%,100%{opacity:0.4}50%{opacity:1}}
  input,textarea,select{color-scheme:dark}
`;

function Lbl({ children, color = T.muted }) {
  return <div style={{ fontSize: 9, letterSpacing: 3, color, textTransform: "uppercase", marginBottom: 5, fontFamily: T.font }}>{children}</div>;
}
function Chip({ children, color = T.accent }) {
  return <span style={{ fontSize: 8, padding: "2px 8px", border: `1px solid ${color}44`, color, textTransform: "uppercase", letterSpacing: 1, borderRadius: 2, fontFamily: T.mono, whiteSpace: "nowrap" }}>{children}</span>;
}
function Card({ children, style = {}, accent = null }) {
  return (
    <div style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 6, position: "relative", overflow: "hidden", ...style }}>
      {accent && <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: accent }} />}
      {children}
    </div>
  );
}
function Prose({ text, color = T.muted, size = 12 }) {
  if (!text) return null;
  return <p style={{ fontSize: size, color, lineHeight: 1.75, margin: 0 }}>{text}</p>;
}
function RevRow({ rev }) {
  if (!rev || rev.y1 === "—") return null;
  const conf = rev.confidence || "medium";
  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap", padding: "12px 14px", background: T.bg, borderRadius: 4, border: `1px solid ${T.border}`, marginBottom: 16 }}>
      {[["Yr 1", rev.y1, T.green], ["Yr 2", rev.y2, T.green], ["Yr 3", rev.y3, T.green], ["Margin", rev.margin ? rev.margin + "%" : rev.margin, T.gold], ["To First $", rev.ttf, T.muted]].map(([l, v, c]) => (
        <div key={l}><Lbl>{l}</Lbl><div style={{ fontFamily: T.serif, fontSize: 17, color: c, fontWeight: 700 }}>{v || "—"}</div></div>
      ))}
      <div><Lbl>Confidence</Lbl><Chip color={CONF_COLOR[conf] || T.amber}>{conf}</Chip></div>
    </div>
  );
}
function Section({ title, badge, badgeColor = T.accent, defaultOpen = false, loading = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card style={{ marginBottom: 10, overflow: "hidden" }}>
      <div onClick={() => setOpen(o => !o)} style={{ padding: "14px 18px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          {badge && <Chip color={badgeColor}>{badge}</Chip>}
          <h3 style={{ fontFamily: T.serif, fontSize: 14, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</h3>
        </div>
        {loading
          ? <div style={{ width: 14, height: 14, border: `2px solid ${T.border}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 1s linear infinite", flexShrink: 0 }} />
          : <span style={{ color: T.accent, fontSize: 15, flexShrink: 0 }}>{open ? "−" : "+"}</span>
        }
      </div>
      {open && <div style={{ borderTop: `1px solid ${T.border}`, padding: "18px", animation: "fadeUp 0.2s ease" }}>{children}</div>}
    </Card>
  );
}

// ─── FIELD COMPONENTS (outside IntakeForm to prevent remount-on-render) ────────
const iStyle = { width: "100%", background: T.panel, border: `1px solid ${T.border}`, borderRadius: 4, padding: "10px 12px", color: T.text, fontSize: 13, fontFamily: T.font, outline: "none" };

function FI({ label, hint, field, placeholder, type = "text", value, onChange }) {
  const [foc, setFoc] = useState(false);
  return (
    <div>
      <Lbl>{label}</Lbl>
      {hint && <div style={{ fontSize: 10, color: T.muted, marginBottom: 5, lineHeight: 1.4 }}>{hint}</div>}
      <input type={type} value={value} placeholder={placeholder}
        onChange={e => onChange(field, e.target.value)}
        onFocus={() => setFoc(true)} onBlur={() => setFoc(false)}
        style={{ ...iStyle, borderColor: foc ? T.accent : T.border, transition: "border-color 0.15s" }} />
    </div>
  );
}
function FT({ label, hint, field, placeholder, rows = 2, value, onChange }) {
  const [foc, setFoc] = useState(false);
  return (
    <div>
      <Lbl>{label}</Lbl>
      {hint && <div style={{ fontSize: 10, color: T.muted, marginBottom: 5, lineHeight: 1.4 }}>{hint}</div>}
      <textarea value={value} placeholder={placeholder} rows={rows}
        onChange={e => onChange(field, e.target.value)}
        onFocus={() => setFoc(true)} onBlur={() => setFoc(false)}
        style={{ ...iStyle, resize: "vertical", borderColor: foc ? T.accent : T.border, transition: "border-color 0.15s" }} />
    </div>
  );
}
function FS({ label, hint, field, options, value, onChange }) {
  return (
    <div>
      <Lbl>{label}</Lbl>
      {hint && <div style={{ fontSize: 10, color: T.muted, marginBottom: 5, lineHeight: 1.4 }}>{hint}</div>}
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        {options.map(([val, disp]) => (
          <button key={val} onClick={() => onChange(field, val)} style={{
            padding: "7px 13px", borderRadius: 4, fontSize: 11, fontFamily: T.font, cursor: "pointer",
            border: `1px solid ${value === val ? T.accent : T.border}`,
            background: value === val ? T.accentDim : "transparent",
            color: value === val ? T.accent : T.muted, transition: "all 0.15s",
          }}>{disp}</button>
        ))}
      </div>
    </div>
  );
}

// ─── INTAKE FORM ──────────────────────────────────────────────────────────────
function IntakeForm({ onSubmit }) {
  const [p, setP] = useState(BLANK);
  const [step, setStep] = useState(0);
  const set = (k, v) => setP(prev => ({ ...prev, [k]: v }));

  const STEPS = [
    {
      title: "Your Situation", subtitle: "Helps calibrate urgency and risk tolerance accurately", icon: "①",
      valid: () => p.location.trim() && p.currentRole.trim(),
      fields: (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <FI label="First Name" field="name" value={p.name} onChange={set} placeholder="e.g. Alex" />
            <FI label="Age" field="age" value={p.age} onChange={set} placeholder="e.g. 34" type="number" />
          </div>
          <FI label="City / Region" field="location" value={p.location} onChange={set} placeholder="e.g. Toronto, Canada" />
          <FT label="Current or Most Recent Role" field="currentRole" value={p.currentRole} onChange={set} placeholder="e.g. Senior PM at a fintech startup — laid off 2 months ago" rows={2} />
          <FS label="Employment Status Right Now" field="employmentStatus" value={p.employmentStatus} onChange={set} options={[
            ["employed", "Employed (side hustle)"], ["unemployed", "Unemployed / laid off"],
            ["freelance", "Already freelancing"], ["student", "Student"],
          ]} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <FI label="Months of Runway Without Income" hint="How many months can you cover expenses?" field="monthlyRunway" value={p.monthlyRunway} onChange={set} placeholder="e.g. 6" type="number" />
            <FS label="Financial Dependents" hint="Spouse, kids, parents" field="dependents" value={p.dependents} onChange={set} options={[
              ["none", "None"], ["some", "Some"], ["heavy", "Heavy"],
            ]} />
          </div>
        </div>
      ),
    },
    {
      title: "Background & Skills", subtitle: "The more specific you are, the more targeted the analysis", icon: "②",
      valid: () => p.skills.trim(),
      fields: (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <FI label="Years of Professional Experience" field="yearsExperience" value={p.yearsExperience} onChange={set} placeholder="e.g. 9" type="number" />
          <FT label="Industries You've Worked In" field="industries" value={p.industries} onChange={set} placeholder="e.g. Financial services, B2B SaaS, Healthcare IT — be specific" />
          <FT label="Core Skills & Abilities" field="skills" value={p.skills} onChange={set} rows={3} placeholder="e.g. Product strategy, AI implementation, client consulting, writing, public speaking..." />
          <FS label="Technical / Coding Ability" field="technicalLevel" value={p.technicalLevel} onChange={set} options={[
            ["low", "Non-technical"], ["moderate", "Semi-technical"], ["high", "Technical"], ["expert", "Can build / ship code"],
          ]} />
          <FS label="Previous Business Attempts" field="prevBizAttempts" value={p.prevBizAttempts} onChange={set} options={[
            ["none", "None"], ["failed", "Tried and failed"], ["partial", "Partial / stalled"], ["yes", "Yes, successful"],
          ]} />
          <FT label="Execution Track Record" hint="Have you shipped things independently, outside a job?" field="executionTrack" value={p.executionTrack} onChange={set} placeholder="e.g. Ran 3 freelance projects, launched a side project with 200 users..." />
          <FT label="Proof of Work You Already Have" hint="Portfolio, case studies, writing, certs — anything that builds buyer trust" field="proofOfWork" value={p.proofOfWork} onChange={set} placeholder="e.g. 10 published articles, 2 consulting decks delivered, Google PM cert..." />
        </div>
      ),
    },
    {
      title: "Network & Assets", subtitle: "Distribution is often more important than the idea itself", icon: "③",
      valid: () => true,
      fields: (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <FT label="Who Do You Actually Know?" hint="Not social following — your real warm professional network. Industries, seniority, specific types." field="networkQuality" value={p.networkQuality} onChange={set} rows={2} placeholder="e.g. Strong in fintech at director level, a few ex-colleagues at banks, weak in healthcare..." />
          <FS label="Social Media Following (combined)" field="socialFollowing" value={p.socialFollowing} onChange={set} options={[
            ["none", "<500"], ["small", "500–5K"], ["medium", "5K–50K"], ["large", "50K+"],
          ]} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <FI label="Monthly Marketing Budget ($)" field="marketingBudget" value={p.marketingBudget} onChange={set} placeholder="e.g. 300" type="number" />
            <FI label="Total Capital Available ($)" field="capitalAvailable" value={p.capitalAvailable} onChange={set} placeholder="e.g. 15000" type="number" />
          </div>
          <FT label="Languages & Cultural Access" hint="Fluency in other languages or deep cultural ties can unlock markets others can't reach" field="languages" value={p.languages} onChange={set} placeholder="e.g. Native Mandarin, conversational Spanish, deep South Asian business ties..." />
          <FS label="Energy Type" hint="Determines which business models actually work for you" field="energyType" value={p.energyType} onChange={set} options={[
            ["intro", "Introvert — prefer async, writing, 1:1"],
            ["extro", "Extrovert — energised by people, networking"],
            ["ambi", "Ambiverted — comfortable both ways"],
          ]} />
        </div>
      ),
    },
    {
      title: "Positioning & Constraints", subtitle: "Your unfair advantages and hard limits shape what we recommend", icon: "④",
      valid: () => true,
      fields: (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <FT label="Your Unfair Advantages" hint="What have you done that's genuinely hard to replicate? Specific experiences, access, credentials." rows={3} field="unfairAdvantages" value={p.unfairAdvantages} onChange={set} placeholder="e.g. 8 years inside a major Canadian bank's innovation team, native Arabic speaker, built and exited a small business..." />
          <FI label="Most You've Ever Charged for Your Work" hint="Single project, engagement, or hourly. Reveals your pricing psychology." field="highestCharged" value={p.highestCharged} onChange={set} placeholder="e.g. $5,000 project, $150/hr, $25K engagement" />
          <FT label="Sectors / Areas You're Drawn To" hint="Optional. Leave blank for fully open analysis." field="interestedSectors" value={p.interestedSectors} onChange={set} placeholder="e.g. sustainability, wellness, real estate, education — or leave blank" />
          <FT label="Absolute Deal-Breakers" field="mustAvoid" value={p.mustAvoid} onChange={set} placeholder="e.g. No cold calling, no physical products, must stay remote..." />
          <FT label="Work Style & Preferences" field="workStyle" value={p.workStyle} onChange={set} placeholder="e.g. Prefer written deliverables, love deep focused work, happy to travel monthly..." />
        </div>
      ),
    },
    {
      title: "Goals & Timeline", subtitle: "Sets the financial model and urgency calibration", icon: "⑤",
      valid: () => p.targetIncome.trim(),
      fields: (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <FS label="Risk Tolerance" field="riskTolerance" value={p.riskTolerance} onChange={set} options={[
            ["low", "Conservative — need predictable income"],
            ["medium", "Moderate — okay with some uncertainty"],
            ["high", "Aggressive — willing to go all-in"],
          ]} />
          <FS label="Time Available for This" field="timeCommitment" value={p.timeCommitment} onChange={set} options={[
            ["parttime", "Part-time (nights/weekends)"],
            ["fulltime", "Full-time focus"],
            ["flexible", "Flexible / ramping up"],
          ]} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <FI label="Target Annual Income ($)" hint="What does success look like in Year 2–3?" field="targetIncome" value={p.targetIncome} onChange={set} placeholder="e.g. 180000" type="number" />
            <FS label="Timeline to First Revenue" field="timelineToRevenue" value={p.timelineToRevenue} onChange={set} options={[
              ["3months", "< 3 months"], ["6months", "6 months"], ["1year", "1 year"], ["2years+", "2+ years"],
            ]} />
          </div>
        </div>
      ),
    },
  ];

  const cur = STEPS[step];
  const canNext = cur.valid();
  const totalQ = buildQuestions(BLANK).length;

  return (
    <div style={{ maxWidth: 620, margin: "0 auto", padding: "0 18px 80px" }}>
      {/* Step progress */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 28 }}>
        {STEPS.map((s, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", flex: i < STEPS.length - 1 ? "1" : "0" }}>
            <div onClick={() => i < step && setStep(i)} style={{
              width: 30, height: 30, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 12, cursor: i < step ? "pointer" : "default", flexShrink: 0,
              border: `2px solid ${i === step ? T.accent : i < step ? T.green : T.border}`,
              background: i === step ? T.accentDim : i < step ? T.greenDim : "transparent",
              color: i === step ? T.accent : i < step ? T.green : T.muted, transition: "all 0.2s",
            }}>{i < step ? "✓" : s.icon}</div>
            {i < STEPS.length - 1 && <div style={{ flex: 1, height: 1, background: i < step ? T.green + "44" : T.border, margin: "0 3px" }} />}
          </div>
        ))}
      </div>

      <Card style={{ padding: "26px 26px 22px" }}>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontFamily: T.serif, fontSize: 19, fontWeight: 700, marginBottom: 3 }}>{cur.title}</div>
          <div style={{ fontSize: 11, color: T.muted }}>{cur.subtitle}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>{cur.fields}</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24 }}>
          {step > 0
            ? <button onClick={() => setStep(s => s - 1)} style={{ background: "none", border: `1px solid ${T.border}`, color: T.muted, padding: "8px 18px", fontSize: 11, fontFamily: T.font, cursor: "pointer", borderRadius: 4 }}>← Back</button>
            : <div />
          }
          {step < STEPS.length - 1
            ? <button onClick={() => canNext && setStep(s => s + 1)} style={{
              background: canNext ? T.accent : T.faint, border: "none", color: canNext ? "#fff" : T.muted,
              padding: "9px 22px", fontSize: 12, fontFamily: T.font, cursor: canNext ? "pointer" : "not-allowed",
              borderRadius: 4, fontWeight: 600,
            }}>Continue →</button>
            : <button onClick={() => onSubmit(p)} style={{
              background: T.accent, border: "none", color: "#fff", padding: "10px 24px",
              fontSize: 11, fontFamily: T.font, cursor: "pointer", borderRadius: 4, fontWeight: 700,
              letterSpacing: 1, textTransform: "uppercase",
            }}>Run {totalQ} Research Calls</button>
          }
        </div>
      </Card>
    </div>
  );
}

// ─── RESEARCH ENGINE ──────────────────────────────────────────────────────────
function ResearchEngine({ profile, onBack, restoredResults }) {
  const [results, setResults] = useState(restoredResults || {});
  const [progress, setProgress] = useState({ done: 0, label: restoredResults ? "Restored from last session" : "Starting…", total: 0 });
  const [done, setDone] = useState(!!restoredResults);
  const [tab, setTab] = useState(0);
  const ran = useRef(!!restoredResults);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const SYS = `You are a senior strategy partner. Brutally honest, hyper-specific, actionable. Plain prose or numbered lists. No bullet symbols, asterisks, or markdown.`;
    const qs = buildQuestions(profile);
    const total = qs.length;

    // Split into 4 parallel batches based on dependency order
    const PHASE = {
      0: ["readiness","strengths","blindspots","networkgap","macro","sectors","timing","hidden","o1_title","o2_title","o3_title"],
      1: ["o1_concept","o1_market","o1_revenue","o1_risks","o1_validate","o2_concept","o2_market","o2_revenue","o2_risks","o2_validate","o3_concept","o3_market","o3_revenue","o3_risks","o3_validate","compare"],
      2: ["p1_pitch","p1_launch","p1_clients","p1_pricing","p1_leverage","p2_pitch","p2_launch","p2_clients","p2_pricing","p2_leverage","p3_pitch","p3_launch","p3_clients","p3_pricing","p3_leverage"],
      3: ["recommendation","yearone","redflags","pricingpsych"],
    };
    const phases = [0,1,2,3].map(i => qs.filter(q => PHASE[i].includes(q.key)));

    setProgress({ done: 0, label: "Starting research…", total, phase: 0 });

    (async () => {
      const data = {};
      let done = 0;
      const PHASE_LABELS = ["Profiling & market scan","Deep opportunity analysis","Building playbooks","Synthesizing recommendations"];

      for (let pi = 0; pi < phases.length; pi++) {
        setProgress(p => ({ ...p, label: PHASE_LABELS[pi], phase: pi }));
        await runBatch(
          phases[pi].map(q => async () => {
            try { data[q.key] = await ask(SYS, q.prompt, 420); }
            catch { data[q.key] = ""; }
            return q.key;
          }),
          () => {
            done++;
            setProgress(p => ({ ...p, done, label: PHASE_LABELS[pi] }));
            setResults({ ...data });
          },
          5
        );
      }

      setProgress(p => ({ ...p, done: total, label: "Complete" }));
      setDone(true);
      saveReport(profile, data);
    })();
  }, []);

  const R = results;
  const pct = progress.total ? Math.round(progress.done / progress.total * 100) : 0;
  const o1Name = R.o1_title || "Best-Fit Opportunity";
  const o2Name = R.o2_title || "Alternative Opportunity";
  const o3Name = R.o3_title || "High-Upside Opportunity";
  const macros = parseMacro(R.macro || "");
  const yq = parseQs(R.yearone || "");

  const playbooks = [
    { n: 1, name: o1Name, color: T.green, pitch: R.p1_pitch, weeks: parseWeeks(R.p1_launch || ""), acq: parseAcq(R.p1_clients || ""), pricing: parsePricing(R.p1_pricing || ""), lev: parseLeverage(R.p1_leverage || ""), rawLaunch: R.p1_launch, rawAcq: R.p1_clients },
    { n: 2, name: o2Name, color: T.accent, pitch: R.p2_pitch, weeks: parseWeeks(R.p2_launch || ""), acq: parseAcq(R.p2_clients || ""), pricing: parsePricing(R.p2_pricing || ""), lev: parseLeverage(R.p2_leverage || ""), rawLaunch: R.p2_launch, rawAcq: R.p2_clients },
    { n: 3, name: o3Name, color: T.gold, pitch: R.p3_pitch, weeks: parseWeeks(R.p3_launch || ""), acq: parseAcq(R.p3_clients || ""), pricing: parsePricing(R.p3_pricing || ""), lev: parseLeverage(R.p3_leverage || ""), rawLaunch: R.p3_launch, rawAcq: R.p3_clients },
  ];

  const TABS = ["Profile", "Market", "Opportunities", "Playbooks", "Synthesis"];
  const sectionDone = (keys) => keys.some(k => R[k]);

  return (
    <div>
      {/* Progress bar */}
      <div style={{ position: "sticky", top: 52, zIndex: 88, background: T.bg, borderBottom: `1px solid ${T.border}`, padding: "8px 22px" }}>
        <div style={{ maxWidth: 900, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {!done && <div style={{ width: 8, height: 8, borderRadius: "50%", background: T.accent, animation: "pulse 1.5s ease-in-out infinite" }} />}
              <div style={{ fontSize: 10, color: done ? T.green : T.text, fontFamily: T.mono }}>{progress.label}</div>
            </div>
            <div style={{ fontSize: 10, color: done ? T.green : T.muted, fontFamily: T.mono, flexShrink: 0 }}>
              {done ? "✓ Complete" : `${progress.done} / ${progress.total}`}
            </div>
          </div>
          <div style={{ height: 3, background: T.border, borderRadius: 2 }}>
            <div style={{ width: `${pct}%`, height: "100%", background: done ? T.green : T.accent, borderRadius: 2, transition: "width 0.3s ease" }} />
          </div>
          {!done && (
            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
              {["Profiling","Analysis","Playbooks","Synthesis"].map((label, i) => {
                const active = progress.phase === i;
                const complete = progress.phase > i;
                return <div key={i} style={{ display: "flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 2, background: complete ? T.greenDim : active ? T.accentDim : "transparent", border: `1px solid ${complete ? T.green + "44" : active ? T.accent + "44" : T.border}` }}>
                  <span style={{ fontSize: 8, color: complete ? T.green : active ? T.accent : T.faint, letterSpacing: 1, textTransform: "uppercase", fontFamily: T.mono }}>{complete ? "✓ " : ""}{label}</span>
                </div>;
              })}
            </div>
          )}
        </div>
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "0 18px 80px" }}>
        {/* Tabs */}
        <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, marginTop: 20, marginBottom: 22, overflowX: "auto" }}>
          {TABS.map((t, i) => {
            const rdy = i === 0 ? sectionDone(["readiness"]) : i === 1 ? sectionDone(["macro"]) :
              i === 2 ? sectionDone(["o1_concept"]) : i === 3 ? sectionDone(["p1_pitch"]) : sectionDone(["recommendation"]);
            return (
              <button key={i} onClick={() => rdy && setTab(i)} style={{
                background: "none", border: "none", borderBottom: `2px solid ${tab === i ? T.accent : "transparent"}`,
                padding: "8px 15px", fontSize: 10, fontWeight: 600, fontFamily: T.font, whiteSpace: "nowrap",
                color: tab === i ? T.accent : rdy ? T.text : T.faint, cursor: rdy ? "pointer" : "default",
                letterSpacing: 1.2, textTransform: "uppercase", transition: "color 0.15s",
              }}>{t}</button>
            );
          })}
        </div>

        {/* Profile tab */}
        {tab === 0 && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 20, padding: "12px 14px", background: T.panel, border: `1px solid ${T.border}`, borderRadius: 6 }}>
              {[profile.currentRole, `${profile.yearsExperience}yr exp`, profile.employmentStatus, `${profile.monthlyRunway || "?"}mo runway`, profile.riskTolerance + " risk", profile.energyType, profile.technicalLevel + " tech"].filter(Boolean).map((tag, i) => (
                <Chip key={i} color={T.muted}>{tag}</Chip>
              ))}
            </div>
            {R.readiness && <Card accent={T.amber} style={{ padding: "16px 18px 16px 22px", marginBottom: 12 }}><Lbl color={T.amber}>Readiness Assessment</Lbl><Prose text={R.readiness} color={T.text} size={13} /></Card>}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              {R.strengths && <Card accent={T.green} style={{ padding: "14px 16px 14px 20px" }}><Lbl color={T.green}>Genuine Strengths</Lbl><Prose text={R.strengths} /></Card>}
              {R.blindspots && <Card accent={T.red} style={{ padding: "14px 16px 14px 20px" }}><Lbl color={T.red}>Blind Spots</Lbl><Prose text={R.blindspots} /></Card>}
            </div>
            {R.networkgap && <Card accent={T.purple} style={{ padding: "14px 16px 14px 20px" }}><Lbl color={T.purple}>Network & Distribution Gap</Lbl><Prose text={R.networkgap} /></Card>}
          </div>
        )}

        {/* Market tab */}
        {tab === 1 && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            {R.timing && <Card accent={T.gold} style={{ padding: "14px 18px 14px 22px", marginBottom: 14 }}><Lbl color={T.gold}>Timing Verdict</Lbl><Prose text={R.timing} color={T.text} size={13} /></Card>}
            {macros.length > 0 && (
              <><h2 style={{ fontFamily: T.serif, fontSize: 17, marginBottom: 12 }}>Macro Signals</h2>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                  {macros.map((s, i) => {
                    const col = s.direction.includes("tail") ? T.green : s.direction.includes("head") ? T.red : T.amber;
                    return <Card key={i} accent={col} style={{ padding: "12px 16px 12px 20px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: T.text }}>{s.signal}</span>
                        <Chip color={col}>{s.direction || "signal"}</Chip>
                      </div>
                      <Prose text={s.implication} />
                    </Card>;
                  })}
                </div></>
            )}
            {R.sectors && <div style={{ marginBottom: 20 }}><h2 style={{ fontFamily: T.serif, fontSize: 17, marginBottom: 10 }}>High-Opportunity Sectors</h2><Card style={{ padding: 16 }}><Prose text={R.sectors} color={T.text} /></Card></div>}
            {R.hidden && <div><h2 style={{ fontFamily: T.serif, fontSize: 17, marginBottom: 4 }}>Hidden Market Gaps</h2><Card style={{ padding: 16 }}><Prose text={R.hidden} color={T.text} /></Card></div>}
          </div>
        )}

        {/* Opportunities tab */}
        {tab === 2 && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            {R.compare && (
              <div style={{ marginBottom: 20 }}>
                <h2 style={{ fontFamily: T.serif, fontSize: 17, marginBottom: 10 }}>Side-by-Side Comparison</h2>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: T.font }}>
                    <thead><tr>{["Dimension", o1Name, o2Name, o3Name].map((h, i) => (
                      <th key={i} style={{ padding: "8px 12px", textAlign: "left", background: T.panel2, borderBottom: `1px solid ${T.border}`, color: i === 0 ? T.muted : [T.green, T.accent, T.gold][i - 1] || T.text, fontSize: i === 0 ? 9 : 10, letterSpacing: i === 0 ? 2 : 0.5, textTransform: "uppercase", whiteSpace: i === 0 ? "nowrap" : "normal", minWidth: i === 0 ? 100 : 130 }}>{h}</th>
                    ))}</tr></thead>
                    <tbody>{R.compare.split("\n").filter(l => l.includes(":")).map((line, ri) => {
                      const ci = line.indexOf(":");
                      const dim = line.slice(0, ci).trim().replace(/_/g, " ");
                      const vals = line.slice(ci + 1).split(" vs ").map(s => s.trim());
                      return <tr key={ri} style={{ borderBottom: `1px solid ${T.border}`, background: ri % 2 === 0 ? "transparent" : T.panel + "88" }}>
                        <td style={{ padding: "8px 12px", color: T.muted, fontSize: 9, letterSpacing: 1.5, textTransform: "uppercase", whiteSpace: "nowrap" }}>{dim}</td>
                        {[0, 1, 2].map(vi => <td key={vi} style={{ padding: "8px 12px", color: T.text, lineHeight: 1.5, verticalAlign: "top" }}>{vals[vi] || "—"}</td>)}
                      </tr>;
                    })}</tbody>
                  </table>
                </div>
              </div>
            )}
            {[
              { n: 1, name: o1Name, color: T.green, badge: "Best Fit", concept: R.o1_concept, market: R.o1_market, rev: parseRevenue(R.o1_revenue || ""), risks: R.o1_risks, validate: R.o1_validate },
              { n: 2, name: o2Name, color: T.accent, badge: "Alternative", concept: R.o2_concept, market: R.o2_market, rev: parseRevenue(R.o2_revenue || ""), risks: R.o2_risks, validate: R.o2_validate },
              { n: 3, name: o3Name, color: T.gold, badge: "High Upside", concept: R.o3_concept, market: R.o3_market, rev: parseRevenue(R.o3_revenue || ""), risks: R.o3_risks, validate: R.o3_validate },
            ].map((opp, i) => (
              <Section key={i} title={opp.name} badge={opp.badge} badgeColor={opp.color} defaultOpen={i === 0} loading={!opp.concept && !done}>
                {i === 0 && <div style={{ display: "inline-block", background: T.green, padding: "2px 10px", fontSize: 8, letterSpacing: 3, fontWeight: 700, color: "#000", textTransform: "uppercase", marginBottom: 12, borderRadius: 2 }}>Recommended First Pursuit</div>}
                <RevRow rev={opp.rev} />
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  {opp.concept && <div style={{ gridColumn: "1/-1" }}><Lbl>Business Concept</Lbl><Prose text={opp.concept} color={T.text} /></div>}
                  {opp.market && <div><Lbl>Market & Comps</Lbl><Prose text={opp.market} /></div>}
                  {opp.risks && <div><Lbl color={T.red}>Failure Modes</Lbl><Prose text={opp.risks} color="#fca5a5" /></div>}
                </div>
                {opp.validate && (
                  <><div style={{ height: 1, background: T.border, margin: "16px 0" }} />
                    <Lbl color={T.green}>7-Day Validation Checklist</Lbl>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
                      {parseValidation(opp.validate).map((v, vi) => (
                        <div key={vi} style={{ display: "flex", gap: 9, alignItems: "flex-start", padding: "8px 10px", background: T.greenDim, borderRadius: 3, border: `1px solid ${T.green}22` }}>
                          <span style={{ color: T.green, fontFamily: T.mono, fontSize: 10, marginTop: 1, flexShrink: 0 }}>0{vi + 1}</span>
                          <p style={{ fontSize: 11, color: T.text, lineHeight: 1.6, margin: 0 }}>{v}</p>
                        </div>
                      ))}
                      {parseValidation(opp.validate).length === 0 && <Prose text={opp.validate} color={T.text} />}
                    </div>
                  </>
                )}
              </Section>
            ))}
          </div>
        )}

        {/* Playbooks tab */}
        {tab === 3 && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            <p style={{ fontSize: 11, color: T.muted, marginBottom: 16 }}>Real platforms named. Pricing anchored to your history. AI noted as accelerator even for non-AI businesses.</p>
            {playbooks.map((pb, i) => (
              <Section key={i} title={pb.name} badge={`Playbook ${pb.n}`} badgeColor={pb.color} defaultOpen={i === 0} loading={!pb.pitch && !done}>
                {pb.pitch && <div style={{ background: T.bg, borderLeft: `3px solid ${pb.color}`, padding: "10px 14px", borderRadius: "0 3px 3px 0", marginBottom: 18 }}><Lbl>Positioning Script</Lbl><p style={{ fontSize: 12, color: T.text, lineHeight: 1.75, margin: 0, fontStyle: "italic" }}>"{pb.pitch}"</p></div>}
                {pb.weeks.length > 0 ? (
                  <div style={{ marginBottom: 18 }}><Lbl>Launch Timeline</Lbl>
                    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                      {pb.weeks.map((w, wi) => (
                        <div key={wi} style={{ display: "flex", gap: 11 }}>
                          <div style={{ minWidth: 50, padding: "4px 7px", background: pb.color + "11", border: `1px solid ${pb.color}28`, borderRadius: 3, textAlign: "center", alignSelf: "flex-start", flexShrink: 0 }}>
                            <div style={{ fontSize: 6, letterSpacing: 2, color: pb.color, textTransform: "uppercase" }}>Wk</div>
                            <div style={{ fontFamily: T.mono, fontSize: 10, color: pb.color, fontWeight: 600 }}>{w.week}</div>
                          </div>
                          <div style={{ flex: 1 }}>
                            {w.milestone && <div style={{ fontSize: 10, fontWeight: 600, color: T.green, marginBottom: 4 }}>✓ {w.milestone}</div>}
                            {w.actions.map((a, ai) => <div key={ai} style={{ display: "flex", gap: 5, marginBottom: 3 }}><span style={{ color: T.muted, fontSize: 9, marginTop: 2, flexShrink: 0 }}>→</span><p style={{ fontSize: 11, color: T.muted, lineHeight: 1.5, margin: 0 }}>{a}</p></div>)}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : pb.rawLaunch ? <div style={{ marginBottom: 18 }}><Lbl>Launch Timeline</Lbl><Prose text={pb.rawLaunch} /></div> : null}
                <div style={{ marginBottom: 18 }}><Lbl>Pricing Tiers</Lbl>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 6 }}>
                    {[["Entry", pb.pricing.entry, T.muted], ["Core", pb.pricing.core, pb.color], ["Premium", pb.pricing.premium, T.green]].map(([l, v, c]) => (
                      <div key={l} style={{ background: T.panel2, border: `1px solid ${c}22`, borderRadius: 4, padding: 10 }}>
                        <div style={{ fontSize: 8, letterSpacing: 2, color: c, textTransform: "uppercase", marginBottom: 4 }}>{l}</div>
                        <p style={{ fontSize: 10, color: T.text, lineHeight: 1.5, margin: 0 }}>{v || "—"}</p>
                      </div>
                    ))}
                  </div>
                  {pb.pricing.rationale && <p style={{ fontSize: 10, color: T.muted, fontStyle: "italic", margin: 0 }}>Strategy: {pb.pricing.rationale}</p>}
                </div>
                {pb.acq.length > 0 ? (
                  <div style={{ marginBottom: 18 }}><Lbl>Client Acquisition</Lbl>
                    {pb.acq.map((c, ci) => {
                      const ec = c.effort === "low" ? T.green : c.effort === "medium" ? T.amber : T.red;
                      return <div key={ci} style={{ display: "flex", gap: 10, padding: "9px 11px", background: T.bg, borderRadius: 3, border: `1px solid ${T.border}`, marginBottom: 6, alignItems: "flex-start" }}>
                        <Chip color={ec}>{c.effort}</Chip>
                        <div style={{ flex: 1 }}><div style={{ fontSize: 11, fontWeight: 600, color: T.text, marginBottom: 2 }}>{c.channel}</div><p style={{ fontSize: 10, color: T.muted, lineHeight: 1.5, margin: 0 }}>{c.tactic}</p></div>
                      </div>;
                    })}
                  </div>
                ) : pb.rawAcq ? <div style={{ marginBottom: 18 }}><Lbl>Client Acquisition</Lbl><Prose text={pb.rawAcq} /></div> : null}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                  {pb.lev.leadMagnet && <div style={{ background: T.panel2, border: `1px solid ${T.border}`, borderRadius: 4, padding: 10 }}><Lbl>Lead Magnet</Lbl><p style={{ fontSize: 10, color: T.text, lineHeight: 1.5, margin: 0 }}>{pb.lev.leadMagnet}</p></div>}
                  {pb.lev.aiLeverage && <div style={{ background: T.panel2, border: `1px solid ${T.border}`, borderRadius: 4, padding: 10 }}><Lbl>AI as Accelerator</Lbl><p style={{ fontSize: 10, color: T.text, lineHeight: 1.5, margin: 0 }}>{pb.lev.aiLeverage}</p></div>}
                  {pb.lev.scalePath && <div style={{ background: T.panel2, border: `1px solid ${T.border}`, borderRadius: 4, padding: 10, gridColumn: "1/-1" }}><Lbl>Scale Path Beyond Solo</Lbl><p style={{ fontSize: 10, color: T.text, lineHeight: 1.5, margin: 0 }}>{pb.lev.scalePath}</p></div>}
                </div>
                {pb.lev.mistakes.length > 0 && <div style={{ background: T.redDim, border: `1px solid ${T.red}22`, borderRadius: 4, padding: "11px 13px" }}><Lbl color={T.red}>Fatal Mistakes — Specific to Your Profile</Lbl>{pb.lev.mistakes.map((m, mi) => <div key={mi} style={{ display: "flex", gap: 6, marginBottom: 4 }}><span style={{ color: T.red, fontSize: 9, flexShrink: 0, marginTop: 1 }}>✗</span><p style={{ fontSize: 10, color: "#fca5a5", lineHeight: 1.5, margin: 0 }}>{m}</p></div>)}</div>}
              </Section>
            ))}
          </div>
        )}

        {/* Synthesis tab */}
        {tab === 4 && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            {R.recommendation && <Card accent={T.green} style={{ padding: "16px 18px 16px 22px", marginBottom: 14 }}><Lbl color={T.green}>Final Recommendation</Lbl><p style={{ fontSize: 14, color: T.text, lineHeight: 1.8, margin: 0, fontFamily: T.serif }}>{R.recommendation}</p></Card>}
            {(yq.length > 0 || R.yearone) && <div style={{ marginBottom: 14 }}>
              <h2 style={{ fontFamily: T.serif, fontSize: 17, marginBottom: 10 }}>Year 1 Roadmap</h2>
              {yq.length > 0 ? <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                {yq.map((q, i) => <Card key={i} accent={[T.green, T.accent, T.gold, T.red][i]} style={{ padding: "13px 15px 13px 19px" }}><Lbl>Q{q.q}</Lbl><Prose text={q.content} color={T.text} /></Card>)}
              </div> : <Card style={{ padding: 16 }}><Prose text={R.yearone} color={T.text} /></Card>}
            </div>}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {R.redflags && <Card accent={T.red} style={{ padding: "14px 16px 14px 20px" }}><Lbl color={T.red}>What You'll Get Wrong</Lbl><Prose text={R.redflags} color="#fca5a5" /></Card>}
              {R.pricingpsych && <Card accent={T.amber} style={{ padding: "14px 16px 14px 20px" }}><Lbl color={T.amber}>Pricing Psychology Diagnosis</Lbl><Prose text={R.pricingpsych} /></Card>}
            </div>
          </div>
        )}

        {/* Footer bar */}
        {done && (
          <div style={{ marginTop: 40, padding: "18px 20px", background: T.panel, border: `1px solid ${T.border}`, borderRadius: 6, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <div>
              <div style={{ fontSize: 12, color: T.text, marginBottom: 3 }}>Report complete — saved to browser.</div>
              <div style={{ fontSize: 11, color: T.muted }}>Edit your profile, re-run, or download the full report.</div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={onBack} style={{ background: "none", border: `1px solid ${T.border}`, color: T.muted, padding: "8px 14px", fontSize: 10, fontFamily: T.font, cursor: "pointer", borderRadius: 4 }}>← Edit Profile</button>
              <button onClick={() => { ran.current = false; setResults({}); setDone(false); setProgress({ done: 0, label: "Starting…", total: 0 }); }} style={{ background: "none", border: `1px solid ${T.accent}`, color: T.accent, padding: "8px 14px", fontSize: 10, fontFamily: T.font, cursor: "pointer", borderRadius: 4, fontWeight: 600 }}>↻ Re-run</button>
              <button onClick={() => generateReport(profile, results)} style={{ background: T.green, border: "none", color: "#000", padding: "8px 18px", fontSize: 10, fontFamily: T.font, cursor: "pointer", borderRadius: 4, fontWeight: 700 }}>⬇ Download Report</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── API KEY SETUP SCREEN ─────────────────────────────────────────────────────
function ApiKeySetup({ onDone }) {
  const [key, setKey] = useState("");
  const [foc, setFoc] = useState(false);

  const saveAndContinue = () => {
    if (key.trim()) setApiKey(key.trim());
    onDone();
  };

  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ maxWidth: 460, width: "100%" }}>
        <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: 4, color: T.accent, textTransform: "uppercase", marginBottom: 20 }}>Solo Venture Intelligence</div>
        <h1 style={{ fontFamily: T.serif, fontSize: "clamp(24px,4vw,36px)", lineHeight: 1.2, fontWeight: 700, marginBottom: 12 }}>
          One thing before<br /><em style={{ color: T.accent }}>we start.</em>
        </h1>
        <p style={{ fontSize: 13, color: T.muted, lineHeight: 1.8, marginBottom: 32 }}>
          This tool uses Claude AI to run deep research on your profile. To power it, you need a free Anthropic API key.
        </p>

        <div style={{ marginBottom: 10 }}>
          <Lbl>Your Anthropic API Key</Lbl>
          <input
            type="password"
            value={key}
            placeholder="sk-ant-..."
            onChange={e => setKey(e.target.value)}
            onFocus={() => setFoc(true)}
            onBlur={() => setFoc(false)}
            onKeyDown={e => e.key === "Enter" && key.trim() && saveAndContinue()}
            style={{ width: "100%", background: T.panel, border: `1px solid ${foc ? T.accent : T.border}`, borderRadius: 4, padding: "11px 14px", color: T.text, fontSize: 13, fontFamily: T.mono, outline: "none", transition: "border-color 0.15s", boxSizing: "border-box" }}
          />
        </div>

        <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.7, marginBottom: 28, padding: "12px 14px", background: T.panel, borderRadius: 4, border: `1px solid ${T.border}` }}>
          Get a free key at <span style={{ color: T.accent, fontFamily: T.mono }}>console.anthropic.com</span> → API Keys.<br />
          Your key never leaves your browser — it's stored locally and sent directly to Anthropic.
        </div>

        <button
          onClick={saveAndContinue}
          disabled={!key.trim()}
          style={{ width: "100%", background: key.trim() ? T.accent : T.faint, border: "none", color: key.trim() ? "#fff" : T.muted, padding: "13px", fontSize: 12, fontFamily: T.font, cursor: key.trim() ? "pointer" : "not-allowed", borderRadius: 4, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", transition: "background 0.15s", marginBottom: 16 }}
        >
          Get Started →
        </button>

        <div style={{ textAlign: "center" }}>
          <button onClick={onDone} style={{ background: "none", border: "none", color: T.muted, fontSize: 11, fontFamily: T.font, cursor: "pointer", textDecoration: "underline" }}>
            Using this inside Claude.ai? Skip this step.
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("intake");
  const [profile, setProfile] = useState(null);
  const [restored, setRestored] = useState(null);
  const [checkingStorage, setCheckingStorage] = useState(true);
  // Show API key setup on first visit if no mode has been chosen
  const [needsSetup, setNeedsSetup] = useState(() => !localStorage.getItem("svi_setup_done"));

  useEffect(() => {
    const saved = loadReport();
    if (saved?.profile && saved?.results && Object.keys(saved.results).length > 5) {
      setRestored(saved);
    }
    setCheckingStorage(false);
  }, []);

  const handleSetupDone = () => {
    localStorage.setItem("svi_setup_done", "1");
    setNeedsSetup(false);
  };

  if (checkingStorage) return (
    <div style={{ background: T.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <style>{globalCSS}</style>
      <div style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>Loading…</div>
    </div>
  );

  if (needsSetup) return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.text, fontFamily: T.font }}>
      <style>{globalCSS}</style>
      <ApiKeySetup onDone={handleSetupDone} />
    </div>
  );

  return (
    <div style={{ background: T.bg, minHeight: "100vh", color: T.text, fontFamily: T.font }}>
      <style>{globalCSS}</style>
      {/* Header */}
      <div style={{ borderBottom: `1px solid ${T.border}`, padding: "12px 22px", display: "flex", justifyContent: "space-between", alignItems: "center", position: "sticky", top: 0, background: T.bg + "f0", backdropFilter: "blur(10px)", zIndex: 100 }}>
        <div>
          <div style={{ fontSize: 8, letterSpacing: 5, color: T.accent, textTransform: "uppercase", marginBottom: 2, fontFamily: T.mono }}>Solo Venture Intelligence</div>
          <div style={{ fontFamily: T.serif, fontSize: 15, fontWeight: 700 }}>Deep Research Analyst</div>
        </div>
        <button onClick={() => { clearApiKey(); localStorage.removeItem("svi_setup_done"); setNeedsSetup(true); }} title="API Key Settings" style={{ background: "none", border: `1px solid ${T.border}`, color: T.muted, padding: "5px 10px", fontSize: 9, fontFamily: T.mono, cursor: "pointer", borderRadius: 3, letterSpacing: 1 }}>⚙ Settings</button>
      </div>

      {/* Restore banner */}
      {restored && screen === "intake" && (
        <div style={{ background: T.greenDim, borderBottom: `1px solid ${T.green}33`, padding: "10px 22px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 11, color: T.green }}>
            Previous report found for <strong>{restored.profile?.name || "your profile"}</strong>
            {restored.savedAt && <span style={{ color: T.muted, marginLeft: 8 }}>{new Date(restored.savedAt).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}</span>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => { setProfile(restored.profile); setScreen("research"); }} style={{ background: T.green, border: "none", color: "#000", padding: "6px 14px", fontSize: 10, fontFamily: T.font, cursor: "pointer", borderRadius: 3, fontWeight: 700 }}>Restore Report</button>
            <button onClick={() => setRestored(null)} style={{ background: "none", border: `1px solid ${T.border}`, color: T.muted, padding: "6px 12px", fontSize: 10, fontFamily: T.font, cursor: "pointer", borderRadius: 3 }}>Start Fresh</button>
          </div>
        </div>
      )}

      {screen === "intake" && (
        <>
          <div style={{ maxWidth: 620, margin: "0 auto", padding: "40px 18px 20px" }}>
            <div style={{ display: "inline-block", background: T.accentDim, border: `1px solid ${T.accent}40`, borderRadius: 3, padding: "3px 10px", fontSize: 9, letterSpacing: 3, color: T.accent, textTransform: "uppercase", marginBottom: 14, fontFamily: T.mono }}>Personalised Research</div>
            <h1 style={{ fontFamily: T.serif, fontSize: "clamp(20px,3.5vw,34px)", lineHeight: 1.2, fontWeight: 700, marginBottom: 10 }}>
              Your profile.<br /><em style={{ color: T.accent }}>Your opportunities.</em>
            </h1>
            <p style={{ fontSize: 12, color: T.muted, lineHeight: 1.8, maxWidth: 460, marginBottom: 6 }}>
              {buildQuestions(BLANK).length} targeted research calls — market signals, sector analysis, 3 tailored opportunities with 7-day validation checklists, full launch playbooks, and a pricing psychology diagnosis. Every industry, not just tech.
            </p>
          </div>
          <IntakeForm onSubmit={p => { setProfile(p); setScreen("research"); setRestored(null); }} />
        </>
      )}

      {screen === "research" && profile && (
        <ResearchEngine
          key={JSON.stringify(profile)}
          profile={profile}
          restoredResults={restored?.profile && JSON.stringify(restored.profile) === JSON.stringify(profile) ? restored.results : null}
          onBack={() => setScreen("intake")}
        />
      )}
    </div>
  );
}
