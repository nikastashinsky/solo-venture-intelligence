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
  <div>${[profile.currentRole, profile.location, ...(Array.isArray(profile.industries) ? profile.industries.slice(0,2) : [])].filter(Boolean).map(t => `<span class="cover-tag">${t}</span>`).join("")}</div>
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
  name: "", location: "",
  employmentStatus: "employed", monthlyRunway: "", dependents: "none",
  currentRole: "",
  industries: [], skills: [],
  technicalLevel: "moderate", energyType: "ambi",
  capitalAvailable: "",
  riskTolerance: "medium", timeCommitment: "fulltime",
  targetIncome: "", timelineToRevenue: "6months",
  venturePref: "open",
  interestedSectors: [], mustAvoid: [], unfairAdvantages: [],
};

// ─── RESEARCH QUESTIONS ───────────────────────────────────────────────────────
const RESEARCH_SYS = `You are an expert business analyst and monetization strategist specializing in solo and micro-business ventures. Your job is to identify genuinely feasible opportunities that a real person can build and get paid for — based on their specific skills, experience, and circumstances — across ALL industries, not just tech.

Core mandate: prioritize scaleable, repeatable business models over pure hourly consulting. This means productized services, recurring subscriptions, digital products, licensing, content and IP, systematized agencies, info products, coaching programs, SaaS tools, niche platforms, or any model where the founder's income is not entirely dependent on trading their own hours. Every recommendation must have a credible path to generating revenue without requiring the founder's direct presence for every dollar earned.

Be brutally honest. Be hyper-specific. Never give generic advice. Use plain prose or numbered lists. No bullet symbols, asterisks, or markdown headers. Early 2026.`;

function buildCtx(p) {
  const industries = Array.isArray(p.industries) ? p.industries.join(", ") : (p.industries || "");
  const skills = Array.isArray(p.skills) ? p.skills.join(", ") : (p.skills || "");
  const sectors = Array.isArray(p.interestedSectors) ? p.interestedSectors.join(", ") : (p.interestedSectors || "");
  const avoid = Array.isArray(p.mustAvoid) ? p.mustAvoid.join(", ") : (p.mustAvoid || "");
  const advantages = Array.isArray(p.unfairAdvantages) ? p.unfairAdvantages.join(", ") : (p.unfairAdvantages || "");
  return `FOUNDER PROFILE (early 2026):
Name: ${p.name || "Founder"} | Location: ${p.location}
Employment: ${p.employmentStatus} | Monthly Runway: ${p.monthlyRunway || "unknown"} months | Dependents: ${p.dependents}
Role: ${p.currentRole}
Industries: ${industries || "not specified"} | Skills: ${skills || "not specified"}
Technical level: ${p.technicalLevel} | Energy type: ${p.energyType}
Capital available: $${p.capitalAvailable || 0} | Risk tolerance: ${p.riskTolerance}
Time commitment: ${p.timeCommitment} | Target income: $${p.targetIncome || "not specified"}/yr | Timeline: ${p.timelineToRevenue}
Venture preference: ${p.venturePref || "open"} | Sectors of interest: ${sectors || "open"} | Must avoid: ${avoid || "nothing"}
Unfair advantages: ${advantages || "not specified"}`;
}

// Phase 0: profile + market + 3 opportunity titles (11 calls)
// These run first. After they complete, actual titles are injected into Phase 1-3 prompts.
function buildPhase0(p) {
  const ctx = buildCtx(p);
  const industries = Array.isArray(p.industries) ? p.industries.join(", ") : (p.industries || "");
  return [
    { key: "readiness", label: "Assessing monetization readiness", prompt: `${ctx}\n\nHonest assessment: is this person ready to build something and start making money on their own right now? Consider runway (${p.monthlyRunway || "unknown"} months), employment (${p.employmentStatus}), dependents (${p.dependents}). What is their single most significant blocker? 3-4 sentences. No flattery.` },
    { key: "strengths", label: "Mapping monetizable strengths", prompt: `${ctx}\n\n3 competencies this person has that are genuinely monetizable — specific to their actual background, not aspirational. Focus on what paying customers or clients would actually buy. Number 1-3. One concrete sentence each.` },
    { key: "blindspots", label: "Identifying blind spots", prompt: `${ctx}\n\n3 things this person is likely wrong about when it comes to building a solo venture. Consider energy type (${p.energyType}), risk tolerance (${p.riskTolerance}), and the gap between what they think they can sell vs. what the market actually pays for. Number 1-3. Specific and honest.` },
    { key: "networkgap", label: "Analyzing distribution gaps", prompt: `${ctx}\n\nWhere is this person's biggest gap in reaching paying customers or clients — given their role and industry background? What specific types of relationships or channels are missing, and what's the most realistic way to fill them quickly? 3-4 sentences.` },
    { key: "macro", label: "Scanning macro signals", prompt: `${ctx}\n\n4 macro trends most relevant to what this person could realistically monetize — given their background in ${industries || "their field"} in ${p.location}, early 2026. Format each line: SIGNAL | tailwind or headwind | specific implication for this person's monetization potential. One per line. No other text.` },
    { key: "sectors", label: "Identifying high-opportunity sectors", prompt: `${ctx}\n\n5 sectors where a solo with this person's background could build a scaleable, repeatable revenue stream in ${p.location} in 2026. Bias toward sectors with recurring spend, structural tailwinds, or underserved demand. Number 1-5. Format: SECTOR: why now + specific angle for this person.` },
    { key: "timing", label: "Assessing timing", prompt: `${ctx}\n\nBlunt verdict: given runway (${p.monthlyRunway || "unknown"} months), capital ($${p.capitalAvailable || 0}), dependents (${p.dependents}), risk tolerance (${p.riskTolerance}) — should they move now or prepare first? If not now, what specifically needs to change? 3 sentences.` },
    { key: "hidden", label: "Surfacing hidden monetization angles", prompt: `${ctx}\n\n4 monetization angles this person probably hasn't considered — based on their background in ${industries || "their field"}, location ${p.location}, and energy type (${p.energyType}). Each should be something they could feasibly build into a scaleable model. Number 1-4. Format: OPPORTUNITY: why overlooked + why this person is positioned for it.` },
    { key: "o1_title", label: "Identifying best-fit opportunity", prompt: `${ctx}\n\nThe single best solo venture this person could realistically build and monetize — highest probability of reaching repeatable revenue given their specific background. Venture preference: "${p.venturePref || "open"}" — honour this unless there is a strongly better fit (explain if overriding). Must have a credible path to scale. Consider all industries. Respond with only the venture title in 4-8 words. Nothing else.` },
    { key: "o2_title", label: "Identifying alternative opportunity", prompt: `${ctx}\n\nA second viable solo venture — genuinely different industry or model from the first. Venture preference: "${p.venturePref || "open"}". Must be something this person can plausibly build and get paid for. Respond with only the venture title in 4-8 words. Nothing else.` },
    { key: "o3_title", label: "Identifying high-upside opportunity", prompt: `${ctx}\n\nA third, higher-ceiling solo venture — more ambitious, more leverage, more upside if it works. Venture preference: "${p.venturePref || "open"}". Must be distinct from the first two. Respond with only the venture title in 4-8 words. Nothing else.` },
  ];
}

// Phase 1-3: all detail prompts — built AFTER phase 0 so actual titles can be injected (35 calls)
function buildPhase1to3(p, titles) {
  const ctx = buildCtx(p);
  const o1 = titles.o1 || "Best-Fit Opportunity";
  const o2 = titles.o2 || "Alternative Opportunity";
  const o3 = titles.o3 || "High-Upside Opportunity";
  return [
    // ── Opportunity 1 ──
    { key: "o1_concept", label: "Defining Opportunity 1", prompt: `${ctx}\n\nFor the solo venture titled "${o1}": describe exactly what it is, the specific paying customer, and the revenue model. Explain how this generates income beyond just trading hours — what makes it repeatable or scaleable. Why is this person specifically positioned to build it? Account for energy type (${p.energyType}). 3-4 sentences.` },
    { key: "o1_market", label: "Sizing Opportunity 1", prompt: `${ctx}\n\nFor "${o1}": who actually pays for this and how much, in ${p.location}? What is the realistic addressable market for one person? Cite 2-3 real-world analogues, comparables, or existing businesses. 3-4 sentences.` },
    { key: "o1_revenue", label: "Modeling Opportunity 1 revenue", prompt: `${ctx}\n\nConservative revenue projections for "${o1}" — assume a realistic ramp. One line exactly: Y1: $X | Y2: $X | Y3: $X | MARGIN: X% | TIME_TO_FIRST_$: X | CONFIDENCE: high/medium/low` },
    { key: "o1_risks", label: "Stress-testing Opportunity 1", prompt: `${ctx}\n\nFor "${o1}": the 3 most likely reasons this specific founder fails to monetize it. Be specific to their profile — not generic startup risks. Number 1-3. Add one sentence on what wild success looks like.` },
    { key: "o1_validate", label: "Building Opportunity 1 validation checklist", prompt: `${ctx}\n\nFor "${o1}": 5 concrete actions to take in the next 7 days to test whether this is real and whether people will pay. Name who to contact, exactly what to ask, and what a positive signal looks like. Number 1-5.` },
    // ── Opportunity 2 ──
    { key: "o2_concept", label: "Defining Opportunity 2", prompt: `${ctx}\n\nFor the solo venture titled "${o2}": what it is, the specific paying customer, and the revenue model. How does this generate repeatable income — what's the path beyond just billing hours? Why this person? 3-4 sentences.` },
    { key: "o2_market", label: "Sizing Opportunity 2", prompt: `${ctx}\n\nFor "${o2}": who pays and how much, in ${p.location}? Realistic addressable market for one person. 2-3 real analogues. 3-4 sentences.` },
    { key: "o2_revenue", label: "Modeling Opportunity 2 revenue", prompt: `${ctx}\n\nRevenue projections for "${o2}". One line: Y1: $X | Y2: $X | Y3: $X | MARGIN: X% | TIME_TO_FIRST_$: X | CONFIDENCE: high/medium/low` },
    { key: "o2_risks", label: "Stress-testing Opportunity 2", prompt: `${ctx}\n\nFor "${o2}": 3 most likely reasons this founder specifically fails to make it work. Number 1-3. One sentence on wild success condition.` },
    { key: "o2_validate", label: "Building Opportunity 2 validation checklist", prompt: `${ctx}\n\nFor "${o2}": 5 specific 7-day actions to test whether people will actually pay. Number 1-5.` },
    // ── Opportunity 3 ──
    { key: "o3_concept", label: "Defining Opportunity 3", prompt: `${ctx}\n\nFor the higher-ceiling venture titled "${o3}": what it is, specific paying customer, revenue model, and what makes it scaleable beyond the founder's direct time. Why could this person specifically build it? 3-4 sentences.` },
    { key: "o3_market", label: "Sizing Opportunity 3", prompt: `${ctx}\n\nFor "${o3}": who pays and how much, in ${p.location}? What's the ceiling if it works? 2-3 real analogues. 3-4 sentences.` },
    { key: "o3_revenue", label: "Modeling Opportunity 3 revenue", prompt: `${ctx}\n\nRevenue projections for "${o3}". One line: Y1: $X | Y2: $X | Y3: $X | MARGIN: X% | TIME_TO_FIRST_$: X | CONFIDENCE: high/medium/low` },
    { key: "o3_risks", label: "Stress-testing Opportunity 3", prompt: `${ctx}\n\nFor "${o3}": 3 most likely reasons this founder fails to monetize it. Number 1-3. One sentence on wild success condition.` },
    { key: "o3_validate", label: "Building Opportunity 3 validation checklist", prompt: `${ctx}\n\nFor "${o3}": 5 specific 7-day actions to test real market demand. Number 1-5.` },
    // ── Compare ──
    { key: "compare", label: "Comparing all three opportunities", prompt: `${ctx}\n\nCompare "${o1}" vs "${o2}" vs "${o3}". One line per dimension: DIMENSION: Opp1 vs Opp2 vs Opp3. Dimensions: REVENUE CEILING, SCALABILITY POTENTIAL, TIME TO FIRST $, CAPITAL REQUIRED, AUTOMATION POTENTIAL, SKILL FIT, FITS ENERGY TYPE, BIGGEST EXECUTION RISK` },
    // ── Playbook 1 ──
    { key: "p1_pitch", label: "Writing Playbook 1: positioning", prompt: `${ctx}\n\nFor "${o1}": write a 2-sentence answer to "what do you do?" that clearly communicates who it's for and why they should pay for it. Specific, no jargon.` },
    { key: "p1_launch", label: "Writing Playbook 1: launch plan", prompt: `${ctx}\n\nFor "${o1}" with $${p.capitalAvailable || 0} capital — concrete week-by-week launch steps focused on getting to first paid engagement fast: WEEK 1-2: [3 specific actions] | MILESTONE: [first paid signal] || WEEK 3-6: [3 actions] | MILESTONE: [outcome] || WEEK 7-12: [3 actions] | MILESTONE: [repeatable revenue]` },
    { key: "p1_clients", label: "Writing Playbook 1: client acquisition", prompt: `${ctx}\n\nFor "${o1}": 3 specific channels to find first paying customers or clients. Name real platforms, communities, or networks. CHANNEL NAME (effort: low/medium/high): [exact first steps]` },
    { key: "p1_pricing", label: "Writing Playbook 1: pricing", prompt: `${ctx}\n\nPricing structure for "${o1}" — design for repeatability, not one-off projects. ENTRY: [price — what's included] | CORE: [price — what's included] | PREMIUM: [price — what's included] | RATIONALE: [one sentence on pricing logic]` },
    { key: "p1_leverage", label: "Writing Playbook 1: scale & mistakes", prompt: `${ctx}\n\nFor "${o1}": LEAD MAGNET: [specific free asset that builds trust and pipeline] | AI LEVERAGE: [specific way AI tools reduce the founder's manual hours in this business] | SCALE PATH: [concrete path to revenue that doesn't require more of the founder's time — automation, productization, delegation] | FATAL MISTAKES: 1. [specific to this profile] 2. [mistake] 3. [mistake]` },
    // ── Playbook 2 ──
    { key: "p2_pitch", label: "Writing Playbook 2: positioning", prompt: `${ctx}\n\nFor "${o2}": 2-sentence answer to "what do you do?" Specific, no jargon.` },
    { key: "p2_launch", label: "Writing Playbook 2: launch plan", prompt: `${ctx}\n\nFor "${o2}" — steps to first paid engagement: WEEK 1-2: [3 actions] | MILESTONE: [first paid signal] || WEEK 3-6: [3 actions] | MILESTONE: [outcome] || WEEK 7-12: [3 actions] | MILESTONE: [repeatable revenue]` },
    { key: "p2_clients", label: "Writing Playbook 2: client acquisition", prompt: `${ctx}\n\nFor "${o2}": 3 specific channels to find first paying customers. CHANNEL NAME (effort: low/medium/high): [exact steps]` },
    { key: "p2_pricing", label: "Writing Playbook 2: pricing", prompt: `${ctx}\n\nPricing for "${o2}" — design for repeatability. ENTRY: [price — included] | CORE: [price — included] | PREMIUM: [price — included] | RATIONALE: [one sentence]` },
    { key: "p2_leverage", label: "Writing Playbook 2: scale & mistakes", prompt: `${ctx}\n\nFor "${o2}": LEAD MAGNET: [specific asset] | AI LEVERAGE: [specific way AI reduces manual hours] | SCALE PATH: [concrete path to revenue beyond founder's direct time] | FATAL MISTAKES: 1. [specific] 2. [mistake] 3. [mistake]` },
    // ── Playbook 3 ──
    { key: "p3_pitch", label: "Writing Playbook 3: positioning", prompt: `${ctx}\n\nFor "${o3}": 2-sentence answer to "what do you do?" Specific, no jargon.` },
    { key: "p3_launch", label: "Writing Playbook 3: launch plan", prompt: `${ctx}\n\nFor "${o3}" — steps to first paid engagement: WEEK 1-2: [3 actions] | MILESTONE: [first paid signal] || WEEK 3-6: [3 actions] | MILESTONE: [outcome] || WEEK 7-12: [3 actions] | MILESTONE: [repeatable revenue]` },
    { key: "p3_clients", label: "Writing Playbook 3: client acquisition", prompt: `${ctx}\n\nFor "${o3}": 3 specific channels to find paying customers. CHANNEL NAME (effort: low/medium/high): [exact steps]` },
    { key: "p3_pricing", label: "Writing Playbook 3: pricing", prompt: `${ctx}\n\nPricing for "${o3}" — design for repeatability. ENTRY: [price — included] | CORE: [price — included] | PREMIUM: [price — included] | RATIONALE: [one sentence]` },
    { key: "p3_leverage", label: "Writing Playbook 3: scale & mistakes", prompt: `${ctx}\n\nFor "${o3}": LEAD MAGNET: [specific asset] | AI LEVERAGE: [specific way AI reduces manual hours] | SCALE PATH: [concrete path to revenue beyond founder's direct time] | FATAL MISTAKES: 1. [specific] 2. [mistake] 3. [mistake]` },
    // ── Synthesis ──
    { key: "recommendation", label: "Synthesizing final recommendation", prompt: `${ctx}\n\nBetween "${o1}", "${o2}", and "${o3}" — which ONE gives this person the clearest path to repeatable, scaleable income given who they actually are? Be definitive. Weight scalability potential alongside runway, capital, dependents, energy type, risk tolerance. 3-4 sentences. No hedging.` },
    { key: "yearone", label: "Mapping Year 1 roadmap", prompt: `${ctx}\n\nFor the recommended venture — practical quarterly milestones focused on getting to repeatable revenue: Q1: [priority + measurable outcome] | Q2: [priority + outcome] | Q3: [priority + outcome] | Q4: [priority + outcome]` },
    { key: "redflags", label: "Flagging likely failure modes", prompt: `${ctx}\n\n3 things this specific person is most likely to get wrong — not generic startup mistakes but things directly tied to their profile, energy type, and background. Number 1-3.` },
    { key: "pricingpsych", label: "Diagnosing pricing psychology", prompt: `${ctx}\n\nTarget income: $${p.targetIncome || 0}/yr. Risk tolerance: ${p.riskTolerance}. This person needs to build a scaleable revenue model, not just bill hours. Diagnose the specific mindset or pricing pattern that will hold them back, and what shift is required. 3-4 sentences.` },
  ];
}

const TOTAL_CALLS = 46; // 11 (phase 0) + 35 (phases 1-3)

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

// ─── CHIP GRID ────────────────────────────────────────────────────────────────
const INDUSTRY_OPTIONS = ["Financial Services","Healthcare","Real Estate","Education","Technology","Media & Content","Retail & E-commerce","Professional Services","Manufacturing","Non-profit","Government","Construction","Hospitality","Legal","Marketing & Advertising","Sports & Recreation","Logistics & Supply Chain","Energy & Utilities"];
const SKILL_OPTIONS = ["Project Management","Sales","Writing & Copywriting","Product Strategy","Data Analysis","Design (UX/UI)","Software Development","Marketing","Financial Modeling","Operations","Legal & Compliance","Coaching & Training","Research","Public Speaking","Video Production","Customer Success","Community Building","Recruiting & HR"];
const SECTOR_OPTIONS = ["Healthcare & Wellness","Education & Learning","Sustainability & Climate","Real Estate","Finance & Wealth","Legal Services","Food & Agriculture","Creative & Media","Travel & Hospitality","Non-profit & Social Impact","Sports & Recreation","Logistics & Supply Chain"];
const AVOID_OPTIONS = ["Cold calling / outbound","Physical products","Must stay remote","Frequent travel","Managing employees","Long sales cycles","Fundraising / investors","Highly regulated industries","On-call / 24/7 support","High upfront capital","B2C consumer market"];
const ADVANTAGE_OPTIONS = ["Industry insider knowledge","Unique cultural / language access","Existing client relationships","Proprietary data or IP","Niche certification or credential","Published thought leadership","Prior exit / business success","Rare technical skill","Deep domain expertise","Government or institutional access","Strong social media presence"];

function ChipGrid({ label, hint, field, options, value = [], onChange }) {
  const [custom, setCustom] = useState("");
  const toggle = (opt) => {
    const next = value.includes(opt) ? value.filter(v => v !== opt) : [...value, opt];
    onChange(field, next);
  };
  const addCustom = () => {
    const t = custom.trim();
    if (t && !value.includes(t)) onChange(field, [...value, t]);
    setCustom("");
  };
  const customVals = value.filter(v => !options.includes(v));
  return (
    <div>
      <Lbl>{label}</Lbl>
      {hint && <div style={{ fontSize: 10, color: T.muted, marginBottom: 6, lineHeight: 1.4 }}>{hint}</div>}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: customVals.length ? 8 : 4 }}>
        {options.map(opt => {
          const sel = value.includes(opt);
          return (
            <button key={opt} onClick={() => toggle(opt)} style={{
              padding: "6px 12px", borderRadius: 4, fontSize: 11, fontFamily: T.font, cursor: "pointer",
              border: `1px solid ${sel ? T.accent : T.border}`,
              background: sel ? T.accentDim : "transparent",
              color: sel ? T.accent : T.muted, transition: "all 0.15s",
            }}>{opt}</button>
          );
        })}
      </div>
      {customVals.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {customVals.map(v => (
            <span key={v} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 4, background: T.accentDim, border: `1px solid ${T.accent}44`, fontSize: 11, color: T.accent }}>
              {v}
              <button onClick={() => onChange(field, value.filter(x => x !== v))} style={{ background: "none", border: "none", color: T.accent, cursor: "pointer", padding: 0, fontSize: 14, lineHeight: 1, marginTop: -1 }}>×</button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 7 }}>
        <input value={custom} onChange={e => setCustom(e.target.value)} onKeyDown={e => e.key === "Enter" && custom.trim() && addCustom()} placeholder="Add your own…" style={{ ...iStyle, flex: 1, fontSize: 11, padding: "7px 10px" }} />
        <button onClick={addCustom} disabled={!custom.trim()} style={{ padding: "7px 12px", borderRadius: 4, fontSize: 11, fontFamily: T.font, cursor: custom.trim() ? "pointer" : "not-allowed", border: `1px solid ${T.border}`, background: "transparent", color: T.muted, whiteSpace: "nowrap" }}>+ Add</button>
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
      title: "Your Situation", subtitle: "Sets the financial constraints and urgency of your launch window", icon: "①",
      valid: () => p.location.trim() && p.currentRole.trim(),
      fields: (
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <FI label="First Name" field="name" value={p.name} onChange={set} placeholder="e.g. Alex" />
            <FI label="City / Region" field="location" value={p.location} onChange={set} placeholder="e.g. Toronto, Canada" />
          </div>
          <FI label="Current or Most Recent Role" hint="Be specific — this shapes every opportunity we identify" field="currentRole" value={p.currentRole} onChange={set} placeholder="e.g. Senior PM at a fintech startup, laid off 2 months ago" />
          <FS label="Employment Status" field="employmentStatus" value={p.employmentStatus} onChange={set} options={[
            ["employed", "Employed (side hustle)"], ["unemployed", "Unemployed / laid off"],
            ["freelance", "Already freelancing"], ["student", "Student"],
          ]} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <FI label="Months of Runway" hint="How long can you cover expenses without income?" field="monthlyRunway" value={p.monthlyRunway} onChange={set} placeholder="e.g. 6" type="number" />
            <FS label="Financial Dependents" hint="Spouse, kids, parents" field="dependents" value={p.dependents} onChange={set} options={[
              ["none", "None"], ["some", "Some"], ["heavy", "Heavy"],
            ]} />
          </div>
        </div>
      ),
    },
    {
      title: "What You Bring", subtitle: "Your skills and experience are the raw material — the more complete, the better the analysis", icon: "②",
      valid: () => p.industries.length > 0 && p.skills.length > 0,
      fields: (
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <ChipGrid label="Industries You've Worked In" hint="Select all that apply — include adjacent or partial experience" field="industries" options={INDUSTRY_OPTIONS} value={p.industries} onChange={set} />
          <ChipGrid label="Core Skills & Abilities" hint="Pick everything you're genuinely competent at, not just what you love" field="skills" options={SKILL_OPTIONS} value={p.skills} onChange={set} />
          <FS label="Technical / Coding Ability" field="technicalLevel" value={p.technicalLevel} onChange={set} options={[
            ["low", "Non-technical"], ["moderate", "Semi-technical"], ["high", "Technical"], ["expert", "Can build / ship code"],
          ]} />
          <FS label="Energy Type" hint="Determines which business models actually suit you" field="energyType" value={p.energyType} onChange={set} options={[
            ["intro", "Introvert — prefer async, writing, 1:1"],
            ["extro", "Extrovert — energised by people, networking"],
            ["ambi", "Ambiverted — comfortable both ways"],
          ]} />
        </div>
      ),
    },
    {
      title: "Your Direction", subtitle: "Income goals, timeline, and constraints that shape what's actually feasible for you", icon: "③",
      valid: () => p.targetIncome.trim(),
      fields: (
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <FS label="How do you want to make money?" hint="This shapes whether we prioritize service models, product models, or a mix" field="venturePref" value={p.venturePref} onChange={set} options={[
            ["service", "Selling my time & expertise — consulting, coaching, done-for-you"],
            ["product", "Building a product — digital, SaaS, course, content, or physical"],
            ["mixed", "Productized service — structured offer, but still expertise-led"],
            ["open", "No preference — show me what makes the most sense"],
          ]} />
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <FI label="Target Annual Income ($)" hint="What does success look like in Year 2–3?" field="targetIncome" value={p.targetIncome} onChange={set} placeholder="e.g. 150000" type="number" />
            <FI label="Capital Available ($)" hint="Budget for tools, marketing, setup" field="capitalAvailable" value={p.capitalAvailable} onChange={set} placeholder="e.g. 10000" type="number" />
          </div>
          <FS label="Time Available" field="timeCommitment" value={p.timeCommitment} onChange={set} options={[
            ["parttime", "Part-time (nights/weekends)"],
            ["fulltime", "Full-time focus"],
            ["flexible", "Flexible / ramping up"],
          ]} />
          <FS label="Timeline to First Revenue" field="timelineToRevenue" value={p.timelineToRevenue} onChange={set} options={[
            ["3months", "< 3 months"], ["6months", "6 months"], ["1year", "1 year"], ["2years+", "2+ years"],
          ]} />
          <FS label="Risk Tolerance" field="riskTolerance" value={p.riskTolerance} onChange={set} options={[
            ["low", "Conservative — need predictable income"],
            ["medium", "Moderate — okay with uncertainty"],
            ["high", "Aggressive — willing to go all-in"],
          ]} />
          <ChipGrid label="Sectors You're Drawn To" hint="Optional — leave empty for fully open analysis" field="interestedSectors" options={SECTOR_OPTIONS} value={p.interestedSectors} onChange={set} />
          <ChipGrid label="Absolute Deal-Breakers" hint="Optional — things you will not do regardless of the opportunity" field="mustAvoid" options={AVOID_OPTIONS} value={p.mustAvoid} onChange={set} />
          <ChipGrid label="Unfair Advantages" hint="Optional — what makes you genuinely hard to replicate?" field="unfairAdvantages" options={ADVANTAGE_OPTIONS} value={p.unfairAdvantages} onChange={set} />
        </div>
      ),
    },
  ];

  const cur = STEPS[step];
  const canNext = cur.valid();

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
            }}>Run Deep Research →</button>
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

    const PHASE_LABELS = ["Profiling & market scan", "Deep opportunity analysis", "Building playbooks", "Synthesizing recommendations"];
    const PHASE1_KEYS = ["o1_concept","o1_market","o1_revenue","o1_risks","o1_validate","o2_concept","o2_market","o2_revenue","o2_risks","o2_validate","o3_concept","o3_market","o3_revenue","o3_risks","o3_validate","compare"];
    const PHASE2_KEYS = ["p1_pitch","p1_launch","p1_clients","p1_pricing","p1_leverage","p2_pitch","p2_launch","p2_clients","p2_pricing","p2_leverage","p3_pitch","p3_launch","p3_clients","p3_pricing","p3_leverage"];
    const PHASE3_KEYS = ["recommendation","yearone","redflags","pricingpsych"];

    setProgress({ done: 0, label: "Starting research…", total: TOTAL_CALLS, phase: 0 });

    (async () => {
      const data = {};
      let doneCount = 0;

      const runPhase = async (qs, phaseIndex) => {
        setProgress(p => ({ ...p, label: PHASE_LABELS[phaseIndex], phase: phaseIndex }));
        await runBatch(
          qs.map(q => async () => {
            try { data[q.key] = await ask(RESEARCH_SYS, q.prompt, 420); }
            catch { data[q.key] = ""; }
            return q.key;
          }),
          () => {
            doneCount++;
            setProgress(p => ({ ...p, done: doneCount, label: PHASE_LABELS[phaseIndex] }));
            setResults({ ...data });
          },
          5
        );
      };

      // Phase 0: profile + market + generate 3 titles
      await runPhase(buildPhase0(profile), 0);

      // Extract actual titles — inject them into all subsequent prompts
      const titles = {
        o1: (data.o1_title || "").trim() || "Best-Fit Opportunity",
        o2: (data.o2_title || "").trim() || "Alternative Opportunity",
        o3: (data.o3_title || "").trim() || "High-Upside Opportunity",
      };
      const laterQs = buildPhase1to3(profile, titles);

      // Phase 1: opportunity deep-dives (titles now injected in prompts)
      await runPhase(laterQs.filter(q => PHASE1_KEYS.includes(q.key)), 1);
      // Phase 2: playbooks (titles injected)
      await runPhase(laterQs.filter(q => PHASE2_KEYS.includes(q.key)), 2);
      // Phase 3: synthesis (titles injected)
      await runPhase(laterQs.filter(q => PHASE3_KEYS.includes(q.key)), 3);

      setProgress(p => ({ ...p, done: TOTAL_CALLS, label: "Complete" }));
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
              {[profile.currentRole, profile.employmentStatus, `${profile.monthlyRunway || "?"}mo runway`, profile.riskTolerance + " risk", profile.energyType, profile.technicalLevel + " tech"].filter(Boolean).map((tag, i) => (
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
            <p style={{ fontSize: 11, color: T.muted, marginBottom: 16 }}>Actionable launch steps, real acquisition channels, and a scale path for each — how to go from first dollar to repeatable revenue without trading all your hours.</p>
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
  const [showClaudeGuide, setShowClaudeGuide] = useState(false);

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
          This tool runs deep AI research on your skills, experience, and circumstances to find a scaleable solo venture you can actually build and get paid for. To power it, you need a free Anthropic API key.
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
          <div style={{ fontSize: 10, color: T.muted, marginTop: 6 }}>
            Get a free key at <span style={{ color: T.accent, fontFamily: T.mono }}>console.anthropic.com</span> → API Keys
          </div>
        </div>

        {/* Privacy & Security breakdown */}
        <div style={{ marginBottom: 24, borderRadius: 6, border: `1px solid ${T.border}`, overflow: "hidden" }}>
          <div style={{ padding: "10px 14px", background: T.panel2, borderBottom: `1px solid ${T.border}` }}>
            <span style={{ fontSize: 9, letterSpacing: 2, color: T.green, textTransform: "uppercase", fontFamily: T.mono }}>Privacy & Security</span>
          </div>
          {[
            [T.green, "Your key never leaves your browser", "It's stored in localStorage on your device only. This tool has no backend server — nothing is ever transmitted to us."],
            [T.green, "Calls go directly to Anthropic", "When you run research, your browser talks directly to api.anthropic.com. Your data and key are not routed through any third party."],
            [T.green, "Your profile stays on your device", "Everything you enter — your background, financials, goals — is stored locally and never sent anywhere except directly to Anthropic to generate your report."],
            [T.amber, "Set a spend limit on your key", "We recommend setting a monthly spending cap at console.anthropic.com → Billing. Each full report costs roughly $0.15–0.20."],
            [T.amber, "Don't share your key", "Treat it like a password. Anyone with your key can make API calls billed to your account."],
          ].map(([color, title, desc], i) => (
            <div key={i} style={{ display: "flex", gap: 12, padding: "11px 14px", borderBottom: i < 4 ? `1px solid ${T.border}` : "none", background: T.panel }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0, marginTop: 5 }} />
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: T.text, marginBottom: 2 }}>{title}</div>
                <div style={{ fontSize: 10, color: T.muted, lineHeight: 1.6 }}>{desc}</div>
              </div>
            </div>
          ))}
        </div>

        <button
          onClick={saveAndContinue}
          disabled={!key.trim()}
          style={{ width: "100%", background: key.trim() ? T.accent : T.faint, border: "none", color: key.trim() ? "#fff" : T.muted, padding: "13px", fontSize: 12, fontFamily: T.font, cursor: key.trim() ? "pointer" : "not-allowed", borderRadius: 4, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", transition: "background 0.15s", marginBottom: 16 }}
        >
          Get Started →
        </button>

        <div style={{ textAlign: "center" }}>
          <button onClick={() => setShowClaudeGuide(true)} style={{ background: "none", border: "none", color: T.muted, fontSize: 11, fontFamily: T.font, cursor: "pointer", textDecoration: "underline" }}>
            Want to use this inside Claude.ai instead?
          </button>
        </div>

        {showClaudeGuide && (
          <ClaudeGuide onBack={() => setShowClaudeGuide(false)} onSkip={onDone} />
        )}
      </div>
    </div>
  );
}

function ClaudeGuide({ onBack, onSkip }) {
  const [status, setStatus] = useState("idle"); // idle | loading | copied | error
  const RAW_URL = "https://raw.githubusercontent.com/nikastashinsky/solo-venture-intelligence/main/src/App.jsx";

  const copyCode = async () => {
    setStatus("loading");
    try {
      const res = await fetch(RAW_URL);
      if (!res.ok) throw new Error();
      const code = await res.text();
      const prompt = `Please render the following as an interactive React artifact. Launch it immediately — do not explain the code or ask any questions. The app is a solo business research tool that will guide the user through a form.\n\n${code}`;
      await navigator.clipboard.writeText(prompt);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
  };

  const btnColor = status === "copied" ? T.green : status === "error" ? T.red : T.accent;
  const btnLabel = status === "loading" ? "Fetching code…" : status === "copied" ? "✓ Copied to clipboard!" : status === "error" ? "Failed — try again" : "Copy code to clipboard";

  return (
    <div style={{ position: "fixed", inset: 0, background: T.bg + "ee", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div style={{ maxWidth: 480, width: "100%", background: T.panel, border: `1px solid ${T.border}`, borderRadius: 8, padding: 28 }}>
        <div style={{ fontFamily: T.serif, fontSize: 18, fontWeight: 700, marginBottom: 6 }}>Run inside Claude.ai</div>
        <p style={{ fontSize: 12, color: T.muted, lineHeight: 1.7, marginBottom: 24 }}>No API key needed — Claude handles everything. Just paste the code into any conversation.</p>

        <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 28 }}>
          {[
            ["1", "Copy the code", <button key="copy" onClick={copyCode} disabled={status === "loading"} style={{ background: btnColor, border: "none", color: status === "copied" ? "#000" : "#fff", padding: "10px 18px", fontSize: 11, fontFamily: T.font, cursor: "pointer", borderRadius: 4, fontWeight: 700, whiteSpace: "nowrap", transition: "background 0.2s" }}>{btnLabel}</button>],
            ["2", "Open Claude.ai and start a new conversation", <a key="open" href="https://claude.ai" target="_blank" rel="noreferrer" style={{ fontSize: 11, color: T.accent, fontFamily: T.mono }}>claude.ai →</a>],
            ["3", "Paste the code into the message box and send", <span key="paste" style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>Cmd+V / Ctrl+V</span>],
            ["4", "Claude renders it as an interactive app — click Run Deep Research", null],
          ].map(([num, label, action]) => (
            <div key={num} style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 26, height: 26, borderRadius: "50%", background: T.accentDim, border: `1px solid ${T.accent}44`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: T.accent, fontWeight: 700, fontFamily: T.mono }}>{num}</span>
              </div>
              <div style={{ flex: 1, fontSize: 12, color: T.text, lineHeight: 1.5 }}>{label}</div>
              {action && <div style={{ flexShrink: 0 }}>{action}</div>}
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onBack} style={{ flex: 1, background: "none", border: `1px solid ${T.border}`, color: T.muted, padding: "10px", fontSize: 11, fontFamily: T.font, cursor: "pointer", borderRadius: 4 }}>← Back</button>
          <button onClick={onSkip} style={{ flex: 1, background: T.accentDim, border: `1px solid ${T.accent}44`, color: T.accent, padding: "10px", fontSize: 11, fontFamily: T.font, cursor: "pointer", borderRadius: 4, fontWeight: 600 }}>I'm already in Claude →</button>
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
            <div style={{ display: "inline-block", background: T.accentDim, border: `1px solid ${T.accent}40`, borderRadius: 3, padding: "3px 10px", fontSize: 9, letterSpacing: 3, color: T.accent, textTransform: "uppercase", marginBottom: 14, fontFamily: T.mono }}>Solo Venture Discovery</div>
            <h1 style={{ fontFamily: T.serif, fontSize: "clamp(20px,3.5vw,34px)", lineHeight: 1.2, fontWeight: 700, marginBottom: 10 }}>
              What can you<br /><em style={{ color: T.accent }}>actually build?</em>
            </h1>
            <p style={{ fontSize: 12, color: T.muted, lineHeight: 1.8, maxWidth: 500, marginBottom: 6 }}>
              Deep research across all industries to find a scaleable solo venture you can realistically build and get paid for — based on your real skills and experience, not wishful thinking. {TOTAL_CALLS} targeted AI research calls. 3 opportunities with actionable launch playbooks.
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
