const appRoot = document.querySelector("#app");
const modal = document.querySelector("#modal");
const toastRegion = document.querySelector("#toast-region");
const state = { user: null, csrf: null, demo: true, data: null, page: "dashboard", reports: null, suggestions: null, reportFilters: {}, hungerData: null, loading: false };
const roleLabels = { administrator: "Administrator", coordinator: "Coordinator", donor: "Food donor", partner: "Community partner", driver: "Driver / volunteer" };
const statusLabels = {
  new: "New", under_review: "Under review", approved: "Approved for matching", matched: "Partially matched",
  scheduled: "Scheduled", collected: "Collected", delivered: "Delivered", rejected: "Rejected", cancelled: "Cancelled",
  unresolved: "Unresolved", open: "Open", partially_fulfilled: "Partially fulfilled", fulfilled: "Fulfilled",
  expired: "Expired", proposed: "Awaiting approval", confirmed: "Confirmed", declined: "Declined",
  pickup_in_progress: "Pickup in progress", in_transit: "In transit", pickup_failed: "Pickup failed",
  delayed: "Delayed", partially_delivered: "Partially delivered", rejected_on_arrival: "Rejected on arrival",
  under_investigation: "Under investigation", resolved: "Resolved", closed: "Closed",
};
const iconPaths = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
  donations: '<path d="M20 12v8H4v-8"/><path d="M2 7h20v5H2z"/><path d="M12 7v13"/><path d="M12 7H8.5a2.5 2.5 0 1 1 2.4-3.2L12 7Z"/><path d="M12 7h3.5a2.5 2.5 0 1 0-2.4-3.2L12 7Z"/>',
  requests: '<path d="M7 3h10l4 4v14H3V3z"/><path d="M17 3v5h4M7 12h10M7 16h7"/>',
  matching: '<circle cx="8" cy="8" r="5"/><circle cx="16" cy="16" r="5"/><path d="m12 12 2-2"/>',
  map: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>',
  deliveries: '<path d="M3 6h11v12H3zM14 10h4l3 3v5h-7"/><circle cx="7.5" cy="18" r="1.5"/><circle cx="17.5" cy="18" r="1.5"/>',
  issues: '<path d="M12 3 2.8 20h18.4L12 3Z"/><path d="M12 9v5M12 17h.01"/>',
  reports: '<path d="M4 19V5M4 19h17"/><path d="m7 15 4-4 3 2 6-7"/>',
  organizations: '<path d="M3 21h18M5 21V6l7-3 7 3v15M9 9h.01M15 9h.01M9 13h.01M15 13h.01M10 21v-4h4v4"/>',
  notifications: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.2 1-1.5 2.6-1.5-.6-.2.1c-.5.3-1 .6-1.6.7l-.3 1.6h-3l-.3-1.6c-.6-.1-1.1-.4-1.6-.7l-.2-.1-1.5.6-1.5-2.6 1.2-1-.1-.2c-.2-.6-.2-1.2 0-1.8l.1-.2-1.2-1 1.5-2.6 1.5.6.2-.1c.5-.3 1-.6 1.6-.7l.3-1.6h3l.3 1.6c.6.1 1.1.4 1.6.7l.2.1 1.5-.6 1.5 2.6-1.2 1 .1.2c.2.6.2 1.2 0 1.8l-.1.2Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
};
const icon = (key) => `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${iconPaths[key] || iconPaths.dashboard}</svg>`;
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const pretty = (value) => statusLabels[value] || String(value ?? "—").replaceAll("_", " ");
const dateTime = (value, options = {}) => {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHTML(value);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...options }).format(date);
};
const shortDate = (value) => dateTime(value, { year: undefined, hour: undefined, minute: undefined });
const badge = (status) => {
  let tone = "gray";
  if (["delivered", "approved", "confirmed", "accepted", "resolved", "collected", "fulfilled"].includes(status)) tone = "green";
  else if (["new", "open", "proposed", "under_review", "under_investigation", "scheduled", "delayed", "partially_fulfilled"].includes(status)) tone = "amber";
  else if (["rejected", "cancelled", "pickup_failed", "unresolved", "rejected_on_arrival", "declined"].includes(status)) tone = "red";
  else if (["in_transit", "pickup_in_progress", "partially_delivered"].includes(status)) tone = "blue";
  return `<span class="badge badge-${tone}">${escapeHTML(pretty(status))}</span>`;
};
const userIsCoordinator = () => ["administrator", "coordinator"].includes(state.user?.role);

function toast(message, isError = false) {
  const node = document.createElement("div");
  node.className = `toast${isError ? " error" : ""}`;
  node.textContent = message;
  toastRegion.append(node);
  window.setTimeout(() => node.remove(), 3600);
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (options.method && !["GET", "HEAD"].includes(options.method.toUpperCase()) && state.csrf) headers["X-CSRF-Token"] = state.csrf;
  let response;
  try {
    response = await fetch(path, { credentials: "same-origin", ...options, headers });
  } catch {
    toast("Could not reach FoodLink. Check your connection and try again.", true);
    throw new Error("Network request failed.");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message = body.error || `Request failed (${response.status}).`;
    toast(message, true);
    if (response.status === 401 && state.user) {
      state.user = null; state.data = null; state.page = "dashboard"; render();
    }
    throw new Error(message);
  }
  return response.headers.get("content-type")?.includes("application/json") ? response.json() : response;
}

async function refreshData() {
  state.data = await api("/api/bootstrap");
  state.suggestions = null;
  state.reports = null;
}

function brand() {
  return `<a class="brand" href="#" data-action="landing"><span class="brand-mark">F</span><span>FoodLink<small>Local food coordination</small></span></a>`;
}

function landing() {
  return `<main class="landing">
    <nav class="landing-nav">${brand()}<div class="actions"><button class="button button-secondary" data-action="global-map">World hunger map</button><button class="button button-secondary" data-action="auth">Partner sign in</button><button class="button button-primary" data-action="auth">Request participation <span aria-hidden="true">→</span></button></div></nav>
    <div class="landing-main">
      <section class="hero">
        <div><span class="hero-kicker">Community food pilot</span><h1>Connecting surplus food with <em>community needs.</em></h1>
          <p class="hero-copy">A coordinated local network that helps trusted organizations move suitable surplus food to community kitchens and food partners—reliably, safely, and with clear accountability.</p>
          <div class="hero-actions"><button class="button button-primary" data-action="auth">Sign in to FoodLink <span aria-hidden="true">→</span></button><button class="button button-secondary" data-action="global-map">Explore the hunger map</button></div>
        </div>
        <div class="hero-art" aria-hidden="true">
          <div class="art-card art-main"><div class="art-main-top"><span class="art-label">A coordinated handoff</span><span class="badge badge-green">Ready to share</span></div>
            <div class="art-basket"><span class="produce">🥬</span><span class="produce">🍞</span><span class="produce">🥕</span><span class="produce">🍊</span></div>
            <strong>Good food, thoughtfully delivered</strong><small>From a local offer to a confirmed community need</small>
          </div>
          <div class="art-card art-mini"><span class="art-mini-icon">↗</span><span><strong>Coordinator reviewed</strong><small>Human-approved match</small></span></div>
          <div class="art-card art-tag"><span class="avatar">CT</span><span><strong>Community Table Kitchen</strong><small>Delivery handoff confirmed</small></span></div>
        </div>
      </section>
      <div class="landing-stats"><div class="landing-stat"><strong>One local network</strong><span>Organizations working together</span></div><div class="landing-stat"><strong>Human reviewed</strong><span>Coordinators approve every match</span></div><div class="landing-stat"><strong>Accountable delivery</strong><span>Track every handoff and issue</span></div></div>
      <section class="section"><div class="section-head"><span class="hero-kicker">A practical workflow</span><h2>From surplus to community table</h2><p>FoodLink makes the coordination visible—while people remain responsible for safety, suitability, and every match.</p></div>
        <div class="steps"><article class="step-card"><div class="step-num">01</div><h3>Donate</h3><p>Local food businesses share available food, quantities, pickup windows, and handling needs.</p></article><article class="step-card"><div class="step-num">02</div><h3>Coordinate</h3><p>A FoodLink coordinator reviews suitability and proposes a match for both organizations to approve.</p></article><article class="step-card"><div class="step-num">03</div><h3>Deliver</h3><p>An assigned driver records progress and the receiving partner confirms what arrived.</p></article></div>
      </section>
      ${globalMapMarkup("landing")}
    </div>
    <footer class="landing-footer"><span>© FoodLink community pilot · Demonstration experience</span><span>Pilot location and local procedures are to be confirmed · Privacy-first by design</span></footer>
  </main>`;
}

function hungerColor(value) {
  if (value == null || !Number.isFinite(Number(value))) return "#e6ebed";
  const score = Number(value);
  if (score <= 2.5) return "#fffdfc";
  if (score <= 5) return "#fff0eb";
  if (score <= 10) return "#ffd6ca";
  if (score <= 20) return "#f6a394";
  if (score <= 30) return "#e67568";
  return "#b9363c";
}
function countryDescription(country) {
  if (!country) return "Focus or hover on a country to see its latest reported estimate.";
  if (country.value == null) return `${country.name}: no country-level estimate in this dataset. Gray means data is missing, not zero hunger.`;
  const value = Number(country.value);
  const displayed = value <= 2.5 ? "<2.5% (reported at the 2.5% threshold)" : `${value.toFixed(1)}%`;
  return `${country.name} · ${displayed} of the population · observation year ${country.year}`;
}
function globalMapMarkup(id) {
  const full = id === "full";
  return `<section class="global-map-section${full ? " full-map-section" : ""}" id="world-hunger">
    <div class="global-map-heading"><div><span class="hero-kicker">Global context</span><h2>${full ? "Where undernourishment is reported" : "A global view of undernourishment"}</h2><p class="subheading">Country-level prevalence of undernourishment · latest available estimate per country</p></div>${full ? "" : `<button class="button button-secondary" data-action="global-map">Open full map <span aria-hidden="true">→</span></button>`}</div>
    <div class="map-card"><div class="map-card-top"><span class="map-indicator"><span class="map-indicator-dot"></span>People undernourished · percent of population</span><span class="map-snapshot" id="${id}-snapshot">Loading source details…</span></div>
      <div class="map-viewport"><div class="world-map" id="${id}-map" role="group" aria-label="Interactive world map shaded by country undernourishment estimates"><div class="map-loading"><span class="spinner"></span> Loading map data…</div></div></div>
      <div class="map-country-info" id="${id}-country-info" aria-live="polite">Focus or hover on a country to see its latest reported estimate.</div>
      <div class="map-legend"><span>Lower reported prevalence</span><div class="legend-ramp" aria-hidden="true"></div><span>Higher reported prevalence</span></div>
      <div class="map-legend-labels"><span>≤2.5%*</span><span>5%</span><span>10%</span><span>20%</span><span>30%+</span><span class="map-no-data-label"><i></i>No data</span></div>
    </div>
    <div class="map-notes"><p><strong>How to read this:</strong> Countries are shaded from white to red by the estimated share of people who are undernourished. This is a modelled national prevalence measure, not a real-time acute food insecurity or famine map. It does not show variation within countries.</p>
      <p>* The FAO reports values below 2.5% as 2.5% because of uncertainty at very low levels. Gray indicates no observation in this snapshot, not zero hunger. The latest available observation year varies by country.</p>
      <div class="map-source">Source: <a href="https://ourworldindata.org/grapher/prevalence-of-undernourishment" target="_blank" rel="noopener noreferrer">FAO indicator via Our World in Data</a> · Country boundaries: <a href="https://www.naturalearthdata.com/" target="_blank" rel="noopener noreferrer">Natural Earth</a></div>
    </div>
    ${full ? `<section class="map-table-panel"><div class="panel-header"><div><h3>Highest reported national prevalence</h3><p class="subheading">Country estimates shown with their observation year; not a count of people.</p></div></div><div class="map-top-countries" id="${id}-top-countries"></div></section>` : ""}
  </section>`;
}
function publicMapPage() {
  return `<main class="landing"><nav class="landing-nav">${brand()}<div class="actions"><button class="button button-secondary" data-action="landing">Back to FoodLink</button><button class="button button-primary" data-action="auth">Partner sign in</button></div></nav><div class="map-public-content">${globalMapMarkup("full")}</div><footer class="landing-footer"><span>FoodLink community pilot · Public country-level context</span><span>This global indicator is separate from local pilot impact reporting.</span></footer></main>`;
}
async function loadWorldMap(id) {
  const container = document.getElementById(`${id}-map`);
  if (!container) return;
  try {
    if (!state.hungerData) {
      const response = await fetch("/data/hunger-prevalence.json");
      if (!response.ok) throw new Error(`Data request failed (${response.status}).`);
      state.hungerData = await response.json();
    }
    const svgResponse = await fetch("/data/world-countries.svg");
    if (!svgResponse.ok) throw new Error(`Map request failed (${svgResponse.status}).`);
    const parsed = new DOMParser().parseFromString(await svgResponse.text(), "image/svg+xml");
    if (parsed.querySelector("parsererror")) throw new Error("The saved map geometry could not be read.");
    const svg = document.importNode(parsed.documentElement, true);
    const countryData = new Map(state.hungerData.countries.map((country)=>[country.iso3,country]));
    const info = document.getElementById(`${id}-country-info`);
    svg.querySelectorAll("path[data-iso]").forEach((path)=>{
      const country = countryData.get(path.dataset.iso);
      path.style.fill = hungerColor(country?.value);
      path.setAttribute("tabindex", "0");
      path.setAttribute("role", "button");
      path.setAttribute("aria-label", countryDescription(country || {name:path.dataset.name, value:null}));
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = countryDescription(country || {name:path.dataset.name, value:null});
      path.append(title);
      const update = () => {
        if (info) info.textContent = countryDescription(country || {name:path.dataset.name, value:null});
      };
      path.addEventListener("pointerenter", update);
      path.addEventListener("focus", update);
      path.addEventListener("click", update);
      path.addEventListener("keydown", (event)=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();update();}});
    });
    container.replaceChildren(svg);
    const date = document.getElementById(`${id}-snapshot`);
    if (date) date.textContent = `Source updated ${state.hungerData.source_updated || "date not supplied"} · snapshot ${state.hungerData.snapshot_date}`;
    const topCountries = document.getElementById(`${id}-top-countries`);
    if (topCountries) {
      const ranked = [...state.hungerData.countries].sort((a,b)=>b.value-a.value).slice(0,12);
      topCountries.innerHTML = ranked.map((country,index)=>`<button class="top-country" data-action="focus-country" data-iso="${escapeHTML(country.iso3)}"><span class="top-country-rank">${String(index+1).padStart(2,"0")}</span><span class="top-country-name">${escapeHTML(country.name)}<small>Observation year ${country.year}</small></span><strong>${country.value <= 2.5 ? "&lt;2.5%" : `${Number(country.value).toFixed(1)}%`}</strong></button>`).join("");
    }
  } catch (error) {
    container.innerHTML = `<div class="map-error"><strong>Map data could not be loaded.</strong><span>${escapeHTML(error.message)} Refresh the page or check that the bundled data files are present.</span></div>`;
  }
}

function authPage() {
  const demoRoles = ["administrator", "coordinator", "donor", "partner", "driver"];
  return `<main class="auth-screen"><section class="auth-aside">${brand()}<div class="auth-aside-main"><span class="hero-kicker" style="color:#cae7d6">FoodLink community pilot</span><h1>Good food can go further, together.</h1><p>Secure access for the organizations and people coordinating local food donations and deliveries.</p></div><span class="auth-aside-foot">A demonstration project · Not configured for external email or messaging</span></section>
    <section class="auth-box-wrap"><div class="auth-box"><button class="button button-secondary button-small" data-action="landing" style="margin-bottom:26px">← Back to home</button><h2>Welcome back</h2><p>Sign in to your FoodLink workspace.</p>
      <form class="auth-form" data-form="login"><div class="form-field"><label for="login-email">Work email</label><input id="login-email" name="email" type="email" autocomplete="username" required placeholder="you@organization.org"></div><div class="form-field"><label for="login-password">Password</label><input id="login-password" name="password" type="password" autocomplete="current-password" required placeholder="Enter your password"></div><button class="button button-primary" type="submit">Sign in securely</button></form>
      <button class="panel-link" style="margin-top:14px;border:0;background:none;padding:0" data-action="password-reset">Forgot your password?</button>
      <div class="demo-logins"><strong>Try the demonstration workspace</strong><div class="demo-login-list">${demoRoles.map((role) => `<button class="demo-login" data-action="demo-login" data-role="${role}"><span class="avatar">${role.slice(0,1).toUpperCase()}</span><span>${escapeHTML(roleLabels[role])}</span></button>`).join("")}</div><p class="form-hint" style="margin-top:9px">Demo accounts use the password <strong>demo1234</strong>. Do not use these accounts in production.</p></div>
    </div></section></main>`;
}

const navItems = [
  { page: "global-map", label: "Global hunger map", icon: "map", roles: ["administrator", "coordinator", "donor", "partner", "driver"] },
  { page: "dashboard", label: "Operations overview", icon: "dashboard", roles: ["administrator", "coordinator", "donor", "partner", "driver"] },
  { page: "donations", label: "Donations", icon: "donations", roles: ["administrator", "coordinator", "donor"] },
  { page: "requests", label: "Food requests", icon: "requests", roles: ["administrator", "coordinator", "partner"] },
  { page: "matching", label: "Matching", icon: "matching", roles: ["administrator", "coordinator", "donor", "partner"] },
  { page: "deliveries", label: "Deliveries", icon: "deliveries", roles: ["administrator", "coordinator", "donor", "partner", "driver"] },
  { page: "issues", label: "Issues", icon: "issues", roles: ["administrator", "coordinator", "partner"] },
  { page: "reports", label: "Pilot reports", icon: "reports", roles: ["administrator", "coordinator"] },
  { page: "organizations", label: "Organizations & team", icon: "organizations", roles: ["administrator", "coordinator"] },
  { page: "notifications", label: "Notifications", icon: "notifications", roles: ["administrator", "coordinator", "donor", "partner", "driver"] },
  { page: "settings", label: "Pilot settings", icon: "settings", roles: ["administrator"] },
];
const pageTitle = Object.fromEntries(navItems.map((item) => [item.page, item.label]));
function sidebar() {
  const items = navItems.filter((item) => item.roles.includes(state.user.role));
  const pendingIssues = state.data.issues.filter((issue) => ["open", "under_investigation"].includes(issue.status)).length;
  const unread = state.data.notifications.filter((item) => !item.read_at).length;
  return `<aside class="sidebar" id="sidebar"><div>${brand()}<div class="nav-label">Workspace</div><nav class="nav-list" aria-label="Main navigation">${items.map((item) => {
    const count = item.page === "issues" ? pendingIssues : item.page === "notifications" ? unread : 0;
    return `<button class="nav-link${state.page === item.page ? " active" : ""}" data-action="navigate" data-page="${item.page}" ${state.page === item.page ? 'aria-current="page"' : ""}>${icon(item.icon)}<span>${item.label}</span>${count ? `<span class="nav-count">${count}</span>` : ""}</button>`;
  }).join("")}</nav></div><div class="sidebar-bottom"><div class="pilot-chip"><strong>${escapeHTML(state.data.settings?.pilot_name || "FoodLink Pilot")}</strong><span>${escapeHTML(state.data.settings?.district || "Pilot area to be confirmed")}</span></div><div class="account"><span class="avatar">${escapeHTML((state.user.name || "F").split(" ").map((part) => part[0]).slice(0,2).join(""))}</span><span class="account-copy"><strong>${escapeHTML(state.user.name)}</strong><span>${escapeHTML(roleLabels[state.user.role])}</span></span><button class="icon-button" title="Sign out" aria-label="Sign out" data-action="logout">↪</button></div></div></aside>`;
}

function topbar() {
  const unread = state.data.notifications.some((item) => !item.read_at);
  return `<header class="topbar"><div class="topbar-left"><button class="icon-button mobile-menu" aria-label="Open navigation" data-action="mobile-nav">☰</button><div><span class="eyebrow">FoodLink / Pilot operations</span><div class="topbar-title">${escapeHTML(pageTitle[state.page] || "FoodLink")}</div></div></div><div class="topbar-right">${state.demo ? '<span class="demo-badge">DEMO DATA</span>' : ""}<button class="icon-button notification-button" aria-label="Notifications" data-action="navigate" data-page="notifications">${icon("bell")}${unread ? '<span class="notification-dot"></span>' : ""}</button></div></header>`;
}

function pageHeading(title, subtitle, action = "") {
  return `<div class="page-heading"><div><h1>${title}</h1><p class="subheading">${subtitle}</p></div>${action ? `<div class="actions">${action}</div>` : ""}</div>`;
}
function kpi(label, value, foot, iconKey, color = "green") {
  const colorMap = { green: ["#24765a", "#e6f4ed"], amber: ["#ae7014", "#fff3da"], blue: ["#537b98", "#eaf2f8"], red: ["#b7493b", "#fdebe8"] };
  const [accent, pale] = colorMap[color];
  return `<article class="kpi-card" style="--accent:${accent};--accent-pale:${pale}"><div class="kpi-top"><span class="kpi-label">${label}</span><span class="kpi-icon">${icon(iconKey)}</span></div><div class="kpi-value">${value}</div><div class="kpi-foot">${foot}</div></article>`;
}
function emptyState(title, detail, symbol = "↗") {
  return `<div class="empty-state"><span class="empty-icon">${symbol}</span><strong>${title}</strong>${detail}</div>`;
}
function formatQuantity(quantity, unit) {
  return quantity == null ? "Not recorded" : `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(quantity)} ${escapeHTML(unit || "")}`;
}
function orgName(orgId) {
  return state.data.organizations.find((item) => item.id === orgId)?.name || orgId || "—";
}
function recentDonationRows(data) {
  return data.slice(0, 5).map((item) => `<tr><td><strong>${escapeHTML(item.description)}</strong><small>${escapeHTML(item.donor_name || orgName(item.organization_id))} · ${escapeHTML(item.category)}</small></td><td>${formatQuantity(item.quantity,item.unit)}</td><td>${badge(item.status)}</td><td>${shortDate(item.created_at)}</td></tr>`).join("");
}
function activityLabel(action) {
  return ({
    donation_submitted: "Donation offer submitted", request_submitted: "Community request submitted", match_proposed: "Match proposal sent for approval",
    match_confirmed: "Donation match confirmed", match_cancelled: "Match cancelled and allocation released",
    delivery_status_changed: "Delivery progress updated", delivery_confirmed: "Delivery receipt confirmed",
    delivery_discrepancy_reported: "Delivery discrepancy reported", issue_status_changed: "Issue status updated",
    donation_reviewed: "Donation food-safety review updated", request_updated: "Community request updated",
    match_approval_recorded: "Match approval recorded", pilot_settings_updated: "Pilot settings updated",
    partner_feedback_submitted: "Partner feedback submitted",
  })[action] || String(action || "Activity recorded").replaceAll("_", " ");
}

function dashboard() {
  const d = state.data;
  const role = state.user.role;
  const scheduled = d.deliveries.filter((item) => ["scheduled", "pickup_in_progress", "collected", "in_transit"].includes(item.status));
  const openIssues = d.issues.filter((item) => ["open", "under_investigation"].includes(item.status));
  const recent = d.donations.slice(0, 5);
  const isDonor = role === "donor", isPartner = role === "partner", isDriver = role === "driver";
  const heading = isDonor ? `Good ${greeting()}, ${escapeHTML(state.user.name.split(" ")[0])}` : isPartner ? "Your community workspace" : isDriver ? "Your assigned deliveries" : `Good ${greeting()}, ${escapeHTML(state.user.name.split(" ")[0])}`;
  const donationCount = d.donations.filter((item) => !["delivered", "rejected", "cancelled"].includes(item.status)).length;
  const requestCount = d.requests.filter((item) => ["open", "partially_fulfilled"].includes(item.status)).length;
  const matchCount = d.matches.filter((item) => item.status === "confirmed").length;
  const deliveredCount = d.deliveries.filter((item) => item.status === "delivered").length;
  const cards = isDonor ? [
    kpi("Active donation offers", donationCount, "Your organization’s offers", "donations"),
    kpi("Awaiting your approval", d.matches.filter((m) => m.status === "proposed").length, "Proposals need a response", "matching", "amber"),
    kpi("Scheduled deliveries", scheduled.length, "Across your confirmed offers", "deliveries", "blue"),
    kpi("Completed handoffs", deliveredCount, "Recorded delivery confirmations", "reports"),
  ] : isPartner ? [
    kpi("Open food requests", requestCount, "Requests still being coordinated", "requests", "amber"),
    kpi("Awaiting your approval", d.matches.filter((m) => m.status === "proposed").length, "Proposals need a response", "matching", "blue"),
    kpi("Scheduled deliveries", scheduled.length, "Deliveries for your organization", "deliveries"),
    kpi("Open follow-ups", openIssues.length, "Issues requiring attention", "issues", "red"),
  ] : isDriver ? [
    kpi("Assigned deliveries", d.deliveries.length, "Only your assigned routes", "deliveries"),
    kpi("Upcoming pickups", scheduled.length, "Scheduled or in progress", "matching", "blue"),
    kpi("Needs attention", d.deliveries.filter((item) => ["delayed", "unresolved", "pickup_failed"].includes(item.status)).length, "Flagged route issues", "issues", "amber"),
    kpi("Completed handoffs", deliveredCount, "Confirmed deliveries", "reports"),
  ] : [
    kpi("Active donation offers", donationCount, "Suitable offers under coordination", "donations"),
    kpi("Open food requests", requestCount, "Requests requiring review", "requests", "amber"),
    kpi("Confirmed matches", matchCount, "Approved by both organizations", "matching", "blue"),
    kpi("Deliveries scheduled", scheduled.length, "Pickups and deliveries in progress", "deliveries"),
    kpi("Completed deliveries", deliveredCount, "Partner-confirmed receipts", "reports"),
    kpi("Unresolved issues", openIssues.length, "Open or under investigation", "issues", "red"),
  ];
  const attention = isDriver ? d.deliveries : isPartner ? d.matches.filter((m) => m.status === "proposed") : d.requests.filter((r) => ["open", "partially_fulfilled"].includes(r.status)).slice(0, 5);
  const attentionHTML = attention.length ? `<div class="activity-list">${attention.slice(0, 5).map((item) => {
    const title = item.description || item.request_description || item.donation_description || "Delivery assigned";
    return `<div class="activity-item"><span class="activity-dot">${isDriver ? "↗" : "!"}</span><span class="activity-copy"><strong>${escapeHTML(title)}</strong><br>${escapeHTML(isDriver ? (item.destination || "") : isPartner ? (item.donor_name || "") : (item.partner_name || "Needs coordinator review"))}</span><span>${badge(item.status)}</span></div>`;
  }).join("")}</div>` : emptyState("All caught up", "No records need your attention right now.", "✓");
  const activity = (d.activities || []).slice(0, 6);
  const dashboardActions = isPartner
    ? `<button class="button button-secondary" data-action="partner-feedback">Share feedback</button><button class="button button-primary" data-action="new-request">＋ Submit request</button>`
    : isDonor ? `<button class="button button-primary" data-action="new-donation">＋ Offer food</button>`
      : isDriver ? `<button class="button button-secondary" data-action="navigate" data-page="deliveries">View assignments</button>`
        : `<button class="button button-primary" data-action="new-donation">＋ Add donation</button>`;
  return `${pageHeading(heading, isDriver ? "Mobile-ready progress updates for deliveries assigned to you." : "A clear view of the work moving through your local food network.", dashboardActions)}
    ${state.demo ? '<div class="banner callout warning"><strong>Demonstration mode.</strong> Sample organizations and transactions are labeled demo data. Replace the local accounts and verify pilot procedures before live use.</div>' : ""}
    <div class="grid kpi-grid">${cards.join("")}</div>
    <div class="grid columns-2"><section class="panel"><div class="panel-header"><div><h2>${isDonor ? "Your recent offers" : isPartner ? "Your open requests" : isDriver ? "My assigned route" : "Recent donation offers"}</h2><p class="subheading">Latest activity from the pilot network</p></div><button class="panel-link" data-action="navigate" data-page="${isDonor ? "donations" : isPartner ? "requests" : isDriver ? "deliveries" : "donations"}">View all →</button></div>
      ${isDonor ? (recent.length ? `<div class="table-wrap"><table><thead><tr><th>Food offer</th><th>Quantity</th><th>Status</th><th>Submitted</th></tr></thead><tbody>${recentDonationRows(recent)}</tbody></table></div>` : emptyState("No food offers yet", "Add an offer to get started.")) : isPartner ? (d.requests.length ? `<div class="table-wrap"><table><thead><tr><th>Request</th><th>Quantity</th><th>Needed by</th><th>Status</th></tr></thead><tbody>${d.requests.slice(0,5).map((r)=>`<tr><td><strong>${escapeHTML(r.description)}</strong><small>${escapeHTML(JSON.parse(r.categories || "[]").join(", "))}</small></td><td>${formatQuantity(r.quantity,r.unit)}</td><td>${shortDate(r.required_by)}</td><td>${badge(r.status)}</td></tr>`).join("")}</tbody></table></div>` : emptyState("No requests submitted", "Share your organization's needs.")) : isDriver ? deliveryCards(d.deliveries.slice(0,3)) : (recent.length ? `<div class="table-wrap"><table><thead><tr><th>Food offer</th><th>Quantity</th><th>Status</th><th>Submitted</th></tr></thead><tbody>${recentDonationRows(recent)}</tbody></table></div>` : emptyState("No donation offers yet", "Donor organizations can submit their first offer."))}
    </section><section class="panel"><div class="panel-header"><div><h2>${isPartner ? "Proposals awaiting you" : isDriver ? "Route status" : "Needs attention"}</h2><p class="subheading">${isPartner ? "Review and respond to coordinator proposals" : isDriver ? "Your active assignments" : "Items that may need a next step"}</p></div></div>${attentionHTML}</section>
    <section class="panel"><div class="panel-header"><div><h2>Delivery status</h2><p class="subheading">Current delivery records in your view</p></div></div>${deliveryStatusChart(d.deliveries)}</section>
    <section class="panel"><div class="panel-header"><div><h2>Recent activity</h2><p class="subheading">An auditable record of coordination actions</p></div></div>${activity.length ? `<div class="activity-list">${activity.map((item)=>`<div class="activity-item"><span class="activity-dot">↗</span><span class="activity-copy"><strong>${escapeHTML(item.full_name || "FoodLink")}</strong> · ${escapeHTML(activityLabel(item.action))}</span><span class="activity-time">${dateTime(item.created_at,{hour:"numeric",minute:"2-digit"})}</span></div>`).join("")}</div>` : emptyState("No recent activity", "Updates will appear here as work progresses.")}</section></div>`;
}
function greeting() { const hour = new Date().getHours(); return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening"; }
function deliveryStatusChart(deliveries) {
  const statuses = ["scheduled", "in_transit", "delivered", "delayed", "unresolved"];
  const colors = { scheduled: "#dfa642", in_transit: "#6594ad", delivered: "#57a17c", delayed: "#df8548", unresolved: "#c55a4b" };
  const counts = statuses.map((status) => ({ status, count: deliveries.filter((item) => item.status === status).length }));
  const total = counts.reduce((sum,item) => sum + item.count, 0);
  return total ? `<div class="status-chart" aria-label="Delivery status distribution">${counts.map((item)=>item.count ? `<span style="width:${item.count/total*100}%;background:${colors[item.status]}" title="${pretty(item.status)}: ${item.count}"></span>` : "").join("")}</div><div class="legend">${counts.filter((item)=>item.count).map((item)=>`<span><i style="background:${colors[item.status]}"></i>${pretty(item.status)} · ${item.count}</span>`).join("")}</div>` : emptyState("No delivery data yet", "Confirmed matches will appear in the delivery workflow.");
}

function donationsPage() {
  const roleCanAdd = ["donor", "administrator", "coordinator"].includes(state.user.role);
  const rowsHTML = state.data.donations.map((item) => {
    const hasMatch = state.data.matches.some((match)=>match.donation_id===item.id && ["proposed","confirmed"].includes(match.status));
    const canCancel = state.user.role === "donor" && ["new","under_review","approved"].includes(item.status) && !hasMatch;
    return `<tr data-search="${escapeHTML(`${item.description} ${item.donor_name} ${item.category} ${item.status}`.toLowerCase())}" data-status="${escapeHTML(item.status)}"><td><strong>${escapeHTML(item.description)}</strong><small>${escapeHTML(item.id.slice(0,8))} · ${escapeHTML(item.category)} · ${escapeHTML(item.donor_name || orgName(item.organization_id))}</small></td><td>${formatQuantity(item.quantity,item.unit)}</td><td>${shortDate(item.pickup_from)}<small>Until ${dateTime(item.pickup_until)}</small></td><td>${item.use_by ? dateTime(item.use_by) : "Not specified"}</td><td>${badge(item.status)}<small>Food review: ${escapeHTML(pretty(item.review_status))}</small></td><td>${userIsCoordinator() ? `<button class="button button-secondary button-small" data-action="review-donation" data-id="${item.id}">Review</button>` : canCancel ? `<button class="button button-danger button-small" data-action="cancel-donation" data-id="${item.id}">Cancel offer</button>` : ""}</td></tr>`;
  }).join("");
  return `${pageHeading("Donation offers", "Review and coordinate suitable surplus food from participating donors.", roleCanAdd ? `<button class="button button-primary" data-action="new-donation">＋ Add donation</button>` : "")}
    <section class="panel"><div class="filters"><label class="search-wrap">${icon("search")}<input id="table-search" type="search" placeholder="Search food, donor, category…" aria-label="Search donation offers"></label><select id="status-filter" aria-label="Filter by status"><option value="">All statuses</option>${[...new Set(state.data.donations.map((item)=>item.status))].map((item)=>`<option value="${item}">${pretty(item)}</option>`).join("")}</select><select id="category-filter" aria-label="Filter by food category"><option value="">All categories</option>${[...new Set(state.data.donations.map((item)=>item.category))].map((item)=>`<option value="${escapeHTML(item)}">${escapeHTML(item)}</option>`).join("")}</select></div>
    ${rowsHTML ? `<div class="table-wrap"><table id="data-table"><thead><tr><th>Food and donor</th><th>Available quantity</th><th>Pickup window</th><th>Freshness / use by</th><th>Coordination status</th><th>Action</th></tr></thead><tbody>${rowsHTML}</tbody></table></div>` : emptyState("No donation offers yet", "Offers submitted by your authorized network will appear here.", "＋")}
    </section>`;
}
function requestsPage() {
  const canAdd = ["partner", "administrator", "coordinator"].includes(state.user.role);
  const rowsHTML = state.data.requests.map((item) => {
    let categories = []; try { categories = JSON.parse(item.categories || "[]"); } catch { categories = []; }
    return `<tr data-search="${escapeHTML(`${item.description} ${item.partner_name || ""} ${categories.join(" ")} ${item.status}`.toLowerCase())}" data-status="${item.status}"><td><strong>${escapeHTML(item.description)}</strong><small>${escapeHTML(item.id.slice(0,8))} · ${escapeHTML(item.partner_name || orgName(item.organization_id))}</small></td><td>${escapeHTML(categories.join(", "))}</td><td>${formatQuantity(item.quantity,item.unit)}</td><td>${escapeHTML(item.destination)}</td><td>${shortDate(item.required_by)}</td><td>${badge(item.status)} <span class="badge badge-${item.priority === "urgent" ? "red" : item.priority === "high" ? "amber" : "gray"}">${escapeHTML(item.priority)} priority</span></td><td>${item.status !== "cancelled" && item.status !== "fulfilled" ? `<button class="button button-secondary button-small" data-action="cancel-request" data-id="${item.id}">Cancel</button>` : ""}</td></tr>`;
  }).join("");
  return `${pageHeading("Community food requests", "Partner-submitted needs for participating community organizations.", canAdd ? `<button class="button button-primary" data-action="new-request">＋ Submit food request</button>` : "")}
    <section class="panel"><div class="filters"><label class="search-wrap">${icon("search")}<input id="table-search" type="search" placeholder="Search request, partner, category…" aria-label="Search food requests"></label><select id="status-filter" aria-label="Filter by status"><option value="">All statuses</option>${[...new Set(state.data.requests.map((item)=>item.status))].map((item)=>`<option value="${item}">${pretty(item)}</option>`).join("")}</select></div>
    ${rowsHTML ? `<div class="table-wrap"><table id="data-table"><thead><tr><th>Request and partner</th><th>Categories</th><th>Quantity</th><th>Destination</th><th>Required by</th><th>Status and urgency</th><th></th></tr></thead><tbody>${rowsHTML}</tbody></table></div>` : emptyState("No food requests yet", "Requests shared by participating partners will appear here.", "＋")}</section>`;
}
function parseCategories(value) {
  try { return JSON.parse(value || "[]"); } catch { return []; }
}
function matchCard(donation, req) {
  const cats = parseCategories(req.categories);
  const compatible = cats.includes(donation.category) && donation.unit.toLowerCase() === req.unit.toLowerCase();
  const available = donation.available_quantity ?? donation.quantity;
  const needed = req.remaining_quantity ?? req.quantity;
  const quantity = Math.min(available, needed);
  const today = new Date();
  const useBy = donation.use_by ? new Date(donation.use_by) : null;
  const expiryWarn = useBy && useBy < new Date(today.getTime() + 24 * 3600000);
  const timeWarn = new Date(req.required_by) < new Date(donation.pickup_from);
  const warnings = [!compatible ? "Category or units do not align" : null, expiryWarn ? "Freshness timing needs review" : null, timeWarn ? "Request timing conflicts with pickup" : null].filter(Boolean);
  return `<article class="match-card"><div class="panel-header"><div><span class="eyebrow">Potential match · advisory only</span><h3>${escapeHTML(donation.category)} <span class="badge badge-${compatible ? "green" : "red"}">${compatible ? "Category + unit compatible" : "Not compatible"}</span></h3></div><span class="badge badge-${warnings.length ? "amber" : "green"}">${warnings.length ? `${warnings.length} review ${warnings.length === 1 ? "item" : "items"}` : "Ready for coordinator review"}</span></div>
      <div class="match-route"><span><strong>${escapeHTML(donation.donor_name || orgName(donation.organization_id))}</strong><small>${escapeHTML(donation.description)} · ${formatQuantity(available,donation.unit)} still available</small></span><span class="route-arrow">→</span><span><strong>${escapeHTML(req.partner_name || orgName(req.organization_id))}</strong><small>${escapeHTML(req.description)} · ${formatQuantity(needed,req.unit)} still needed</small></span></div>
    <div class="factor-list"><div class="factor"><span>Category and unit</span><span class="${compatible ? "check" : "warn"}">${compatible ? "✓ Compatible" : "Review required"}</span></div><div class="factor"><span>Potential quantity</span><strong>${formatQuantity(quantity,donation.unit)}</strong></div><div class="factor"><span>Pickup window</span><strong>${dateTime(donation.pickup_from)} – ${dateTime(donation.pickup_until,{hour:"numeric",minute:"2-digit"})}</strong></div><div class="factor"><span>Partner need by</span><strong>${dateTime(req.required_by)}</strong></div><div class="factor"><span>Storage / transport</span><strong>${escapeHTML(donation.transport_requirements || donation.storage_requirements || "Check with coordinator")}</strong></div></div>
    ${warnings.length ? `<div class="callout warning" style="margin:12px 0"><strong>Review before proposing:</strong> ${warnings.map(escapeHTML).join(" · ")}</div>` : ""}
    <div class="actions"><button class="button button-primary button-small" data-action="propose-match" data-donation="${donation.id}" data-request="${req.id}" ${!compatible ? "disabled" : ""}>Review and propose</button></div></article>`;
}
async function matchingPage() {
  if (userIsCoordinator() && !state.suggestions) state.suggestions = await api("/api/matches");
  const { donations = [], requests: openRequests = [] } = state.suggestions || {};
  const pairs = [];
  donations.forEach((donation) => openRequests.forEach((req) => pairs.push(matchCard(donation, req))));
  const proposals = state.data.matches.filter((item) => ["proposed", "confirmed", "declined", "cancelled"].includes(item.status));
  return `${pageHeading("Coordinator matching", "Compatibility is a guide only. Every proposal needs human review and both organization approvals.", "")}
    ${state.user.role === "administrator" || state.user.role === "coordinator" ? `<div class="callout warning banner"><strong>Coordinator review required.</strong> Confirm food suitability, pickup and delivery timing, storage/transport compatibility, and both parties' agreement. Suggestions never approve a match automatically.</div>` : ""}
    ${userIsCoordinator() ? `<section class="panel"><div class="panel-header"><div><h2>Potential matches</h2><p class="subheading">Pairs with matching category and measurement unit · advisory only</p></div><span class="badge badge-blue">${pairs.length} candidate${pairs.length === 1 ? "" : "s"}</span></div>${pairs.length ? `<div class="grid match-grid">${pairs.join("")}</div>` : emptyState("No compatible offers and requests", "Check pending food reviews, open requests, and matching units.")}</section>` : ""}
    <section class="panel" style="margin-top:15px"><div class="panel-header"><div><h2>${userCanSeeProposals() ? "Match proposals for your organization" : "Match proposals and approvals"}</h2><p class="subheading">No match is confirmed until both parties accept and a coordinator confirms.</p></div></div>${proposalRows(proposals)}</section>`;
}
function userCanSeeProposals() { return ["donor", "partner"].includes(state.user.role); }
function proposalRows(proposals) {
  if (!proposals.length) return emptyState("No proposals yet", "Coordinator proposals and recorded approvals will appear here.");
  return `<div class="table-wrap"><table><thead><tr><th>Donation → community request</th><th>Proposed quantity</th><th>Pickup / delivery</th><th>Approvals</th><th>Status</th><th>Action</th></tr></thead><tbody>${proposals.map((item) => {
    const approvals = item.approvals || [];
    const donorApproval = approvals.find((a)=>a.role==="donor")?.decision || "pending";
    const partnerApproval = approvals.find((a)=>a.role==="partner")?.decision || "pending";
    let action = "";
    if (item.status === "proposed" && ["donor","partner"].includes(state.user.role)) {
      const ownApproval = state.user.role === "donor" ? donorApproval : partnerApproval;
      if (ownApproval === "pending") action = `<button class="button button-primary button-small" data-action="accept-match" data-id="${item.id}">Review / respond</button>`;
      else action = `<span class="form-hint">Your response: ${pretty(ownApproval)}</span>`;
    } else if (item.status === "proposed" && userIsCoordinator()) {
      if (donorApproval === "accepted" && partnerApproval === "accepted") action = `<button class="button button-primary button-small" data-action="confirm-match" data-id="${item.id}">Confirm match</button>`;
      else action = `<span class="form-hint">Awaiting both approvals</span>`;
    } else if (item.status === "confirmed" && userIsCoordinator()) {
      action = `<button class="button button-secondary button-small" data-action="cancel-match" data-id="${item.id}">Cancel / release</button>`;
    }
    return `<tr><td><strong>${escapeHTML(item.donation_description || item.donation_id)}</strong><small>${escapeHTML(item.donor_name || "")} → ${escapeHTML(item.partner_name || "")} · ${escapeHTML(item.request_description || "")}</small></td><td>${formatQuantity(item.proposed_quantity,item.unit)}</td><td>${dateTime(item.proposed_pickup)}<small>${dateTime(item.proposed_delivery)}</small></td><td><small>Donor: ${escapeHTML(pretty(donorApproval))}</small><small>Partner: ${escapeHTML(pretty(partnerApproval))}</small></td><td>${badge(item.status)}</td><td>${action}</td></tr>`;
  }).join("")}</tbody></table></div>`;
}

function deliveryCards(deliveries) {
  if (!deliveries.length) return emptyState("No deliveries in your view", "Confirmed matches will appear as delivery assignments.");
  return `<div class="activity-list">${deliveries.map((item)=>`<div class="activity-item"><span class="activity-dot">↗</span><span class="activity-copy"><strong>${escapeHTML(item.donor_name || item.id.slice(0,8))} → ${escapeHTML(item.partner_name || item.destination || "Partner")}</strong><br>${formatQuantity(item.quantity_expected,item.unit)} · ${dateTime(item.scheduled_pickup)}</span><span>${badge(item.status)}</span></div>`).join("")}</div>`;
}
function deliveryPage() {
  const rowsHTML = state.data.deliveries.map((item) => {
    const driverCanUpdate = state.user.role === "driver";
    const partnerCanConfirm = state.user.role === "partner";
    const action = driverCanUpdate ? `<button class="button button-primary button-small" data-action="delivery-progress" data-id="${item.id}">Update progress</button>` : partnerCanConfirm ? `<button class="button button-primary button-small" data-action="delivery-confirm" data-id="${item.id}" data-correction="${item.confirmation_at ? "true" : "false"}">${item.confirmation_at ? "Correct receipt" : "Confirm receipt"}</button>` : userIsCoordinator() && !["delivered","cancelled"].includes(item.status) ? `<button class="button button-secondary button-small" data-action="delivery-progress" data-id="${item.id}">Update</button>` : "";
    const canReport = ["driver","partner","donor","administrator","coordinator"].includes(state.user.role) && !["cancelled","delivered"].includes(item.status);
    const contacts = ["driver", "administrator", "coordinator"].includes(state.user.role) ? `<div class="delivery-contact">Pickup: ${escapeHTML(item.donor_contact || "Contact via coordinator")} ${escapeHTML(item.donor_phone || "")}<br>Receive: ${escapeHTML(item.partner_contact || "Contact via coordinator")} ${escapeHTML(item.partner_phone || "")}</div>` : "";
    return `<tr><td><strong>${escapeHTML(item.donor_name || item.id.slice(0,8))} → ${escapeHTML(item.partner_name || item.destination || "Receiving partner")}</strong><small>${escapeHTML(item.id.slice(0,8))} · ${escapeHTML(item.pickup_location || "Pickup location on file")} → ${escapeHTML(item.destination || "Destination on file")}</small></td><td>${formatQuantity(item.quantity_expected,item.unit)}<small>Collected: ${formatQuantity(item.quantity_collected,item.unit)} · Received: ${formatQuantity(item.quantity_received,item.unit)}</small></td><td>${dateTime(item.scheduled_pickup)}<small>Delivery ${dateTime(item.scheduled_delivery)}</small></td><td>${item.driver_name ? escapeHTML(item.driver_name) : item.driver_id ? "Assigned" : "Unassigned"}</td><td>${badge(item.status)}${item.confirmation_at ? `<small>Confirmed ${dateTime(item.confirmation_at)}</small>` : ""}</td><td><button class="button button-quiet button-small" data-action="timeline" data-id="${item.id}">Timeline</button> ${action}${canReport ? `<button class="button button-secondary button-small" data-action="report-delivery-issue" data-id="${item.id}">Report issue</button>` : ""}${contacts}</td></tr>`;
  }).join("");
  return `${pageHeading("Pickup & delivery", "A documented handoff from pickup through receiving-partner confirmation.", "")}
    <div class="callout banner"><strong>Responsibility and handling:</strong> Follow the listed food and transport requirements. Report delays, failed pickups, damage, or quantity differences as soon as they are known.</div>
    <section class="panel">${rowsHTML ? `<div class="table-wrap"><table><thead><tr><th>Route and organizations</th><th>Expected / collected / received</th><th>Schedule</th><th>Driver</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rowsHTML}</tbody></table></div>` : emptyState("No deliveries scheduled", "A delivery is created once the coordinator confirms an approved match.")}</section>`;
}
function issuesPage() {
  const rowsHTML = state.data.issues.map((item) => `<tr><td><strong>${escapeHTML(pretty(item.category))}</strong><small>${escapeHTML(item.delivery_code?.slice(0,8) || item.delivery_id.slice(0,8))} · ${dateTime(item.created_at)}</small></td><td>${escapeHTML(item.description)}${item.follow_up_action ? `<small>Follow-up: ${escapeHTML(item.follow_up_action)}</small>` : ""}</td><td>${escapeHTML(item.assignee_name || "Coordinator review")}</td><td>${badge(item.status)}</td><td>${userIsCoordinator() && item.status !== "closed" ? `<button class="button button-secondary button-small" data-action="update-issue" data-id="${item.id}">Update</button>` : ""}</td></tr>`).join("");
  return `${pageHeading("Delivery issues", "Discrepancies and concerns remain open until reviewed and documented.", "")}<section class="panel">${rowsHTML ? `<div class="table-wrap"><table><thead><tr><th>Issue</th><th>Description and follow-up</th><th>Assigned to</th><th>Status</th><th></th></tr></thead><tbody>${rowsHTML}</tbody></table></div>` : emptyState("No delivery issues", "Reported discrepancies and delivery concerns will be tracked here.", "✓")}</section>`;
}
async function reportsPage() {
  if (!state.reports) {
    const params = new URLSearchParams(Object.entries(state.reportFilters).filter(([,value])=>value));
    state.reports = await api(`/api/reports${params.size ? `?${params}` : ""}`);
  }
  const r = state.reports;
  const completion = r.delivery_completion_rate == null ? "—" : `${r.delivery_completion_rate.toFixed(0)}%`;
  const allCategory = r.category_breakdown || [];
  const maxQty = Math.max(...allCategory.map((item)=>item.received || 0),1);
  const statusColors = { scheduled: "#dfa642", pickup_in_progress: "#c88e3a", collected: "#82ae91", in_transit: "#6594ad", delivered: "#57a17c", delayed: "#df8548", unresolved: "#c55a4b", partially_delivered: "#8e7aae", rejected_on_arrival: "#b94c41", pickup_failed: "#b94c41", cancelled: "#aab5b4" };
  const statusTotal = r.delivery_statuses.reduce((sum,item)=>sum+item.count,0);
  const orgOptions = state.data.organizations.map((org)=>`<option value="${org.id}" ${state.reportFilters.organization_id===org.id?"selected":""}>${escapeHTML(org.name)}</option>`).join("");
  const areaOptions = [...new Set(state.data.organizations.map((org)=>org.service_area).filter(Boolean))].map((area)=>`<option value="${escapeHTML(area)}" ${state.reportFilters.area===area?"selected":""}>${escapeHTML(area)}</option>`).join("");
  const categoryOptions = [...new Set(state.data.donations.map((donation)=>donation.category))].map((category)=>`<option value="${escapeHTML(category)}" ${state.reportFilters.category===category?"selected":""}>${escapeHTML(category)}</option>`).join("");
  return `${pageHeading("Eight-week pilot evaluation", "Operational measures from recorded data only. This dashboard does not claim health or hunger outcomes.", `<a class="button button-secondary" href="/api/reports.csv${Object.keys(state.reportFilters).some((key)=>state.reportFilters[key])?`?${new URLSearchParams(state.reportFilters)}`:""}">↓ Export CSV</a>`)}
    <div class="callout warning banner"><strong>Interpretation:</strong> Completed deliveries are counted only when a receiving partner confirms full expected quantity. Completion rate = completed deliveries ÷ confirmed matches. Partial, rejected, cancelled, and in-progress deliveries are not counted as completed. Unknown quantities are shown as missing, not zero.</div>
    <section class="panel" style="margin-bottom:15px"><div class="filters" style="margin:0"><label class="form-field"><span class="form-label">From</span><input type="date" data-report-filter="date_from" value="${escapeHTML(state.reportFilters.date_from || "")}"></label><label class="form-field"><span class="form-label">To</span><input type="date" data-report-filter="date_to" value="${escapeHTML(state.reportFilters.date_to || "")}"></label><label class="form-field"><span class="form-label">Organization</span><select data-report-filter="organization_id"><option value="">All organizations</option>${orgOptions}</select></label><label class="form-field"><span class="form-label">Area</span><select data-report-filter="area"><option value="">All areas</option>${areaOptions}</select></label><label class="form-field"><span class="form-label">Food category</span><select data-report-filter="category"><option value="">All categories</option>${categoryOptions}</select></label><button class="button button-secondary" data-action="clear-report-filters">Clear filters</button></div></section>
    <div class="grid kpi-grid">${kpi("Delivery completion",completion,`${r.completion_count} completed / ${r.confirmed_match_count} confirmed matches`,"reports","green")}${kpi("Overdue unmet requests",r.unmet_request_count,"Open or partially fulfilled past required-by","requests","amber")}${kpi("Participating organizations",r.partner_coverage.organizations,"Active pilot participants","organizations","blue")}${kpi("Partner feedback",r.partner_feedback.responses,`Responses · ease ${r.partner_feedback.ease == null ? "—" : Number(r.partner_feedback.ease).toFixed(1)}/5`,"dashboard")}${kpi("Unknown received quantities",r.missing_data.received_quantities_unknown,"Missing values are not treated as zero","issues","red")}${kpi("Recorded activity",r.activity.length,"Most recent actions in audit history","notifications")}</div>
    <div class="grid columns-even"><section class="panel"><div class="panel-header"><div><h2>Food delivered by category</h2><p class="subheading">Grouped by category and compatible unit</p></div></div>${allCategory.length ? `<div class="bar-chart">${allCategory.map((item)=>`<div class="bar-row"><span>${escapeHTML(item.category)} <small>(${escapeHTML(item.unit)})</small></span><span class="bar-track"><span class="bar-fill" style="display:block;width:${Math.max(2,item.received/maxQty*100)}%"></span></span><b>${item.received}${item.unknown ? ` · ${item.unknown} unknown` : ""}</b></div>`).join("")}</div>` : emptyState("No confirmed delivery totals", "Receipt data will appear after partners confirm deliveries.")}</section>
    <section class="panel"><div class="panel-header"><div><h2>Delivery status distribution</h2><p class="subheading">Current status of each delivery record</p></div></div>${statusTotal ? `<div class="status-chart">${r.delivery_statuses.map((item)=>`<span style="width:${item.count/statusTotal*100}%;background:${statusColors[item.status] || "#9aa9a8"}"></span>`).join("")}</div><div class="legend">${r.delivery_statuses.map((item)=>`<span><i style="background:${statusColors[item.status] || "#9aa9a8"}"></i>${pretty(item.status)} · ${item.count}</span>`).join("")}</div>` : emptyState("No delivery status data", "Confirmed matches create delivery records.")}</section></div>
    <div class="grid columns-even" style="margin-top:15px"><section class="panel"><div class="panel-header"><div><h2>Delivery completion over time</h2><p class="subheading">Partner-confirmed full deliveries by confirmation date</p></div></div>${r.time_series.length ? `<div class="bar-chart">${r.time_series.map((item)=>`<div class="bar-row"><span>${escapeHTML(item.date)}</span><span class="bar-track"><span class="bar-fill" style="display:block;width:${Math.max(7,item.completed_deliveries/Math.max(...r.time_series.map((entry)=>entry.completed_deliveries))*100)}%"></span></span><b>${item.completed_deliveries}</b></div>`).join("")}</div>` : emptyState("No confirmed completions yet","The chart will show full deliveries by confirmation date.")}</section><section class="panel"><div class="panel-header"><div><h2>Timeliness and partner coverage</h2><p class="subheading">Measured from actual collected and receipt events</p></div></div><div class="metric-list"><div class="metric-row"><span>Donation submission → actual pickup</span><strong>${average(r.timeliness_hours.submission_to_pickup)}</strong></div><div class="metric-row"><span>Actual pickup → confirmed receipt</span><strong>${average(r.timeliness_hours.pickup_to_delivery)}</strong></div>${r.partner_coverage.areas.map((area)=>`<div class="metric-row"><span>${escapeHTML(area.service_area || "Area not recorded")}</span><strong>${area.organizations} organizations</strong></div>`).join("")}</div></section>
    <section class="panel"><div class="panel-header"><div><h2>Coverage and data limitations</h2><p class="subheading">Interpret incomplete measures cautiously</p></div></div><div class="metric-list"><div class="metric-row"><span>Avg. communication feedback</span><strong>${r.partner_feedback.communication == null ? "Not recorded" : `${Number(r.partner_feedback.communication).toFixed(1)} / 5`}</strong></div><div class="metric-row"><span>Avg. reliability feedback</span><strong>${r.partner_feedback.reliability == null ? "Not recorded" : `${Number(r.partner_feedback.reliability).toFixed(1)} / 5`}</strong></div><div class="metric-row"><span>Known unmatched/rejected food</span><strong>${r.unmatched_food_by_category_unit.length ? r.unmatched_food_by_category_unit.map((x)=>`${x.quantity} ${x.unit} ${x.category}`).join(", ") : "Not recorded"}</strong></div><div class="metric-row"><span>Coordinator hours / transport cost</span><strong>Not recorded</strong></div><div class="callout warning">${escapeHTML(r.missing_data.unusable_food)} ${escapeHTML(r.missing_data.operational_effort)}</div></div></section></div>`;
}
function average(values) {
  if (!values?.length) return "Not enough data";
  return `${(values.reduce((a,b)=>a+b,0)/values.length).toFixed(1)} h`;
}
function organizationsPage() {
  const orgRows = state.data.organizations.map((item)=>`<tr><td><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(pretty(item.type))}</small></td><td>${escapeHTML(item.contact_name || "Contact to be confirmed")}<small>${escapeHTML(item.contact_email || "")} ${escapeHTML(item.contact_phone || "")}</small></td><td>${escapeHTML(item.service_area || "To be confirmed")}</td><td>${escapeHTML(item.capabilities || "Not recorded")}</td><td>${badge(item.participation_status)}</td></tr>`).join("");
  const teamRows = state.data.team.map((item)=>`<tr><td><strong>${escapeHTML(item.full_name)}</strong><small>${escapeHTML(item.email)}</small></td><td>${escapeHTML(roleLabels[item.role] || item.role)}</td><td>${escapeHTML(orgName(item.organization_id))}</td><td>${badge(item.active ? "active" : "cancelled")}</td><td>${state.user.role==="administrator" && item.id!==state.user.id ? `<button class="button button-secondary button-small" data-action="toggle-member" data-id="${item.id}" data-active="${item.active ? "false" : "true"}">${item.active ? "Deactivate" : "Reactivate"}</button>` : ""}</td></tr>`).join("");
  const adminActions = state.user.role === "administrator" ? `<button class="button button-secondary" data-action="new-team-member">＋ Add team member</button><button class="button button-primary" data-action="new-organization">＋ Register organization</button>` : "";
  return `${pageHeading("Organizations & team", "Authorized operational directory. Contact details are visible only to coordinator/admin roles.", adminActions)}<div class="grid columns-even"><section class="panel"><div class="panel-header"><div><h2>Participating organizations</h2><p class="subheading">${state.data.organizations.length} registered organizations</p></div></div>${orgRows ? `<div class="table-wrap"><table><thead><tr><th>Organization</th><th>Authorized contact</th><th>Service area</th><th>Handling capabilities</th><th>Status</th></tr></thead><tbody>${orgRows}</tbody></table></div>` : emptyState("No organizations found","Add partner organizations before the pilot begins.")}</section><section class="panel"><div class="panel-header"><div><h2>Authorized team</h2><p class="subheading">Role and organization assignments</p></div></div>${teamRows ? `<div class="table-wrap"><table><thead><tr><th>Team member</th><th>Role</th><th>Organization</th><th>Access</th><th></th></tr></thead><tbody>${teamRows}</tbody></table></div>` : emptyState("Team directory restricted","Administrators and coordinators can view authorized accounts.")}</section></div>`;
}
function newOrganizationForm() {
  showModal("Register an organization", "Register a participating donor, community partner, transport provider, or pilot team.", `<form id="modal-fields" data-submit="organization"><div class="form-grid">
    <div class="form-field full"><label for="org-name">Organization name</label><input id="org-name" name="name" required maxlength="140"></div>
    <div class="form-field"><label for="org-type">Organization type</label><select id="org-type" name="type" required><option value="donor">Food donor</option><option value="community_partner">Community partner</option><option value="transport">Transport provider</option><option value="pilot">Pilot team</option></select></div>
    <div class="form-field"><label for="org-contact">Authorized contact</label><input id="org-contact" name="contact_name"></div>
    <div class="form-field"><label for="org-email">Operational email</label><input id="org-email" name="contact_email" type="email"></div>
    <div class="form-field"><label for="org-phone">Operational phone</label><input id="org-phone" name="contact_phone" type="tel"></div>
    <div class="form-field"><label for="org-area">Service area</label><input id="org-area" name="service_area"></div>
    <div class="form-field full"><label for="org-capabilities">Handling capabilities</label><textarea id="org-capabilities" name="capabilities"></textarea></div>
    <div class="form-field full"><label for="org-notes">Notes / agreements</label><textarea id="org-notes" name="notes"></textarea></div>
    </div></form>`, "Register organization");
}
function newTeamMemberForm() {
  const orgs = state.data.organizations;
  showModal("Create authorized user", "Initial passwords are stored as password hashes. Share initial credentials through an approved secure channel.", `<form id="modal-fields" data-submit="team-member"><div class="form-grid">
    <div class="form-field"><label for="member-name">Full name</label><input id="member-name" name="full_name" required></div><div class="form-field"><label for="member-email">Work email</label><input id="member-email" name="email" type="email" required></div>
    <div class="form-field"><label for="member-role">Role</label><select id="member-role" name="role" required><option value="coordinator">Coordinator</option><option value="donor">Food donor</option><option value="partner">Community partner</option><option value="driver">Driver / volunteer</option><option value="administrator">Administrator</option></select></div>
    <div class="form-field"><label for="member-org">Organization</label><select id="member-org" name="organization_id" required>${orgs.map((org)=>`<option value="${org.id}">${escapeHTML(org.name)} · ${escapeHTML(pretty(org.type))}</option>`).join("")}</select></div>
    <div class="form-field full"><label for="member-password">Initial password</label><input id="member-password" name="password" type="password" minlength="12" required><span class="form-hint">At least 12 characters. Ask the user to change it after their first sign in.</span></div>
    </div></form>`, "Create user");
}
function feedbackForm() {
  showModal("Share partner feedback", "Your feedback helps evaluate ease of use, communication, and reliability.", `<form id="modal-fields" data-submit="feedback"><div class="form-grid">
    ${[["ease_rating","Ease of use"],["communication_rating","Communication"],["reliability_rating","Reliability"]].map(([key,label])=>`<div class="form-field"><label for="${key}">${label}</label><select id="${key}" name="${key}" required><option value="">Choose a rating</option>${[5,4,3,2,1].map((rating)=>`<option value="${rating}">${rating} / 5</option>`).join("")}</select></div>`).join("")}
    <div class="form-field full"><label for="feedback-comment">Optional comment</label><textarea id="feedback-comment" name="comment"></textarea></div></div></form>`, "Submit feedback");
}
function reportIssue(id) {
  const delivery = state.data.deliveries.find((item)=>item.id===id);
  showModal("Report a delivery issue", `Delivery ${id.slice(0,8)} · ${delivery?.donor_name || delivery?.pickup_location} → ${delivery?.partner_name || delivery?.destination}`, `<form id="modal-fields" data-submit="delivery-issue" data-id="${id}"><div class="form-grid">
    <div class="form-field"><label for="reported-issue-category">Issue category</label><select id="reported-issue-category" name="category"><option value="delay">Delay</option><option value="pickup_failure">Pickup failure</option><option value="quantity_discrepancy">Quantity discrepancy</option><option value="food_condition">Food condition</option><option value="packaging">Packaging</option><option value="other">Other</option></select></div>
    <div class="form-field full"><label for="reported-issue-description">What happened?</label><textarea id="reported-issue-description" name="description" required></textarea></div>
    <div class="form-field full"><label for="reported-issue-followup">Suggested follow-up</label><textarea id="reported-issue-followup" name="follow_up_action"></textarea></div>
    </div></form>`, "Send to coordinator");
}
function notificationsPage() {
  return `${pageHeading("Notifications", "In-app alerts are active. Email or messaging delivery is not configured.", "")}<div class="callout warning banner"><strong>External delivery unconfigured.</strong> Notifications are stored in FoodLink only; configure an email or messaging provider before relying on off-platform alerts.</div><section class="panel">${state.data.notifications.length ? `<div class="activity-list">${state.data.notifications.map((item)=>`<div class="activity-item"><span class="activity-dot">${item.read_at ? "✓" : "!"}</span><span class="activity-copy"><strong>${escapeHTML(item.title)}</strong><br>${escapeHTML(item.message)}<small>${dateTime(item.created_at)}</small></span><span>${item.read_at ? '<span class="badge badge-gray">Read</span>' : `<button class="button button-quiet button-small" data-action="read-notification" data-id="${item.id}">Mark read</button>`}</span></div>`).join("")}</div>` : emptyState("No notifications", "Important workflow updates will appear here.")}</section>`;
}
function settingsPage() {
  const settings = state.data.settings;
  const categories = parseCategories(settings.accepted_categories);
  const units = parseCategories(settings.accepted_units);
  const checklist = parseCategories(settings.safety_checklist);
  return `${pageHeading("Pilot configuration", "Placeholders remain until the pilot team confirms its district, schedule, partners, and local procedures.", "")}<div class="callout warning banner"><strong>Food-safety configuration is not legal certification.</strong> The pilot team must review and approve applicable local requirements with participating organizations before operation.</div>
    <section class="panel"><form data-form="settings" class="form-grid">
      <div class="form-field"><label for="pilot-name">Pilot name</label><input id="pilot-name" name="pilot_name" value="${escapeHTML(settings.pilot_name)}" required></div>
      <div class="form-field"><label for="district">Neighborhood / district</label><input id="district" name="district" value="${escapeHTML(settings.district)}" required></div>
      <div class="form-field"><label for="start-date">Pilot start date</label><input id="start-date" name="start_date" type="date" value="${escapeHTML(settings.start_date || "")}"></div>
      <div class="form-field"><label for="end-date">Pilot end date</label><input id="end-date" name="end_date" type="date" value="${escapeHTML(settings.end_date || "")}"></div>
      <div class="form-field"><label for="categories">Accepted food categories</label><input id="categories" name="accepted_categories" value="${escapeHTML(categories.join(", "))}"><span class="form-hint">Comma-separated; confirm categories with participating organizations.</span></div>
      <div class="form-field"><label for="units">Measurement units</label><input id="units" name="accepted_units" value="${escapeHTML(units.join(", "))}"></div>
      <div class="form-field full"><label for="safety-checklist">Food review checklist</label><textarea id="safety-checklist" name="safety_checklist">${escapeHTML(checklist.join("\n"))}</textarea><span class="form-hint">One review item per line. This is configurable pilot guidance, not a statement of local law.</span></div>
      <div class="form-field full"><label for="schedule-rules">Delivery scheduling rules</label><textarea id="schedule-rules" name="scheduling_rules">${escapeHTML(settings.scheduling_rules)}</textarea></div>
      <div class="form-field full"><label for="capacity">Transportation capacity / constraints</label><textarea id="capacity" name="transport_capacity">${escapeHTML(settings.transport_capacity)}</textarea></div>
      <div class="form-field full"><label for="privacy-policy">Privacy approach</label><textarea id="privacy-policy" name="privacy_policy">${escapeHTML(settings.privacy_policy)}</textarea></div>
      <div class="form-field full"><label for="retention-policy">Data retention policy</label><textarea id="retention-policy" name="retention_policy">${escapeHTML(settings.retention_policy)}</textarea></div>
      <div class="form-field full"><button type="submit" class="button button-primary">Save pilot settings</button></div>
    </form></section>`;
}

async function render() {
  if (!state.user) {
    if (state.page === "global-map") {
      appRoot.innerHTML = publicMapPage();
      await loadWorldMap("full");
    } else {
      appRoot.innerHTML = state.page === "auth" ? authPage() : landing();
      if (state.page !== "auth") await loadWorldMap("landing");
    }
    return;
  }
  if (!state.data) {
    appRoot.innerHTML = `<div class="boot"><span class="brand-mark">F</span><span>Loading your workspace</span><span class="spinner"></span></div>`;
    return;
  }
  const pages = {
    dashboard,
    "global-map": () => globalMapMarkup("full"),
    donations: donationsPage,
    requests: requestsPage,
    matching: matchingPage,
    deliveries: deliveryPage,
    issues: issuesPage,
    reports: reportsPage,
    organizations: organizationsPage,
    notifications: notificationsPage,
    settings: settingsPage,
  };
  let body;
  try { body = await (pages[state.page] || dashboard)(); }
  catch (error) { body = `${pageHeading("Unable to load this view", "Please retry after checking the connection.")}<section class="panel">${emptyState("Data could not be loaded", escapeHTML(error.message), "!")}</section>`; }
  appRoot.innerHTML = `<div class="app-shell">${sidebar()}<div class="workspace">${topbar()}<main class="content">${body}</main></div></div>`;
  if (state.page === "donations" || state.page === "requests") bindTableFilters();
  if (state.page === "global-map") await loadWorldMap("full");
}
function bindTableFilters() {
  const search = document.querySelector("#table-search");
  const status = document.querySelector("#status-filter");
  const category = document.querySelector("#category-filter");
  const table = document.querySelector("#data-table");
  if (!table) return;
  let page = 0;
  let sortColumn = 0;
  let direction = 1;
  const pageSize = 10;
  const pagination = document.createElement("div");
  pagination.className = "table-pagination";
  pagination.innerHTML = `<span class="pagination-count" aria-live="polite"></span><div><button class="button button-secondary button-small" data-page-step="-1">Previous</button><button class="button button-secondary button-small" data-page-step="1">Next</button></div>`;
  table.closest(".table-wrap").after(pagination);
  const filter = () => {
    const term = (search?.value || "").toLowerCase();
    const rows = [...table.querySelectorAll("tbody tr")];
    const shown = rows.filter((row) => {
      const matchesSearch = (row.dataset.search || "").includes(term);
      const matchesStatus = !status?.value || row.dataset.status === status.value;
      const matchesCategory = !category?.value || (row.dataset.search || "").includes(category.value.toLowerCase());
      return matchesSearch && matchesStatus && matchesCategory;
    });
    shown.sort((a,b) => direction * a.cells[sortColumn].textContent.localeCompare(b.cells[sortColumn].textContent, undefined, { numeric: true }));
    rows.forEach((row) => { row.hidden = !shown.includes(row); });
    const maxPage = Math.max(0, Math.ceil(shown.length / pageSize) - 1);
    page = Math.min(page, maxPage);
    shown.forEach((row,index) => { row.hidden = index < page * pageSize || index >= (page + 1) * pageSize; });
    pagination.querySelector(".pagination-count").textContent = shown.length ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, shown.length)} of ${shown.length} records` : "No matching records";
    pagination.querySelector('[data-page-step="-1"]').disabled = page === 0;
    pagination.querySelector('[data-page-step="1"]').disabled = page >= maxPage;
    shown.forEach((row)=>table.tBodies[0].append(row));
  };
  search?.addEventListener("input", filter);
  status?.addEventListener("change", () => { page = 0; filter(); });
  category?.addEventListener("change", () => { page = 0; filter(); });
  pagination.addEventListener("click", (event) => {
    const button = event.target.closest("[data-page-step]");
    if (!button) return;
    page = Math.max(0, page + Number(button.dataset.pageStep));
    filter();
  });
  table.querySelectorAll("th").forEach((heading,index) => {
    heading.tabIndex = 0;
    heading.setAttribute("aria-label", `${heading.textContent.trim()}, activate to sort`);
    const sort = () => {
      if (sortColumn === index) direction *= -1;
      else { sortColumn = index; direction = 1; }
      filter();
    };
    heading.addEventListener("click", sort);
    heading.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); sort(); } });
  });
  filter();
}
function showModal(title, description, content, submitLabel = "Save") {
  modal.innerHTML = `<div class="modal-form"><div class="modal-header"><div><h2>${escapeHTML(title)}</h2><p class="subheading">${escapeHTML(description || "")}</p></div><button type="button" class="icon-button" aria-label="Close" data-action="close-modal">✕</button></div><div class="modal-body">${content}</div><div class="modal-footer"><button type="button" class="button button-secondary" data-action="close-modal">Cancel</button>${submitLabel ? `<button class="button button-primary" type="submit" form="modal-fields">${escapeHTML(submitLabel)}</button>` : ""}</div></div>`;
  if (!modal.open) modal.showModal();
}
function organizationsSelect(type, name, label, selected = "") {
  const orgs = state.data.organizations.filter((org) => org.type === type);
  return `<div class="form-field"><label for="${name}">${label}</label><select id="${name}" name="${name}" required><option value="">Choose an organization</option>${orgs.map((org)=>`<option value="${org.id}" ${selected===org.id?"selected":""}>${escapeHTML(org.name)}</option>`).join("")}</select></div>`;
}
function newDonationForm() {
  const isDonor = state.user.role === "donor";
  const donorSelect = !isDonor ? organizationsSelect("donor","organization_id","Donor organization") : "";
  const categories = parseCategories(state.data.settings.accepted_categories);
  const options = categories.length ? categories : ["Bakery","Produce","Prepared meals","Dairy","Packaged goods","Other"];
  showModal("Add a donation offer", "Share availability and handling information. A coordinator must review food suitability before matching.", `<form id="modal-fields" data-submit="donation"><input type="hidden" name="submission_key" value="${crypto.randomUUID()}"><div class="form-grid">${donorSelect}
    <div class="form-field"><label for="don-category">Food category</label><select id="don-category" name="category" required>${options.map((c)=>`<option>${escapeHTML(c)}</option>`).join("")}</select></div>
    <div class="form-field full"><label for="don-description">Food description</label><input id="don-description" name="description" required maxlength="200" placeholder="e.g. Sealed mixed vegetable boxes"></div>
    <div class="form-field"><label for="don-quantity">Available quantity</label><input id="don-quantity" name="quantity" type="number" min="0.01" step="0.01" required></div><div class="form-field"><label for="don-unit">Unit</label><select id="don-unit" name="unit" required>${["kg","items","boxes","litres"].map((u)=>`<option>${u}</option>`).join("")}</select></div>
    <div class="form-field full"><label for="don-location">Pickup location</label><input id="don-location" name="pickup_location" required maxlength="250"></div>
    <div class="form-field"><label for="don-from">Pickup available from</label><input id="don-from" name="pickup_from" type="datetime-local" required></div><div class="form-field"><label for="don-until">Pickup available until</label><input id="don-until" name="pickup_until" type="datetime-local" required></div>
    <div class="form-field"><label for="don-use-by">Freshness / use-by time</label><input id="don-use-by" name="use_by" type="datetime-local"></div><div class="form-field"><label for="don-allergens">Known allergens</label><input id="don-allergens" name="allergens" placeholder="If known"></div>
    <div class="form-field"><label for="don-storage">Storage requirements</label><input id="don-storage" name="storage_requirements" placeholder="e.g. Keep chilled"></div><div class="form-field"><label for="don-transport">Transport requirements</label><input id="don-transport" name="transport_requirements" placeholder="e.g. Insulated transport"></div>
    <p class="form-hint full">Do not offer food you believe is unsafe. The coordinator will review food condition, packaging, labels, freshness, and applicable pilot requirements.</p></div></form>`, "Submit offer");
}
function newRequestForm() {
  const isPartner = state.user.role === "partner";
  const partnerSelect = !isPartner ? organizationsSelect("community_partner","organization_id","Community partner") : "";
  showModal("Submit a food request", "Describe your organization's operational needs. Do not enter personal recipient details.", `<form id="modal-fields" data-submit="request"><input type="hidden" name="submission_key" value="${crypto.randomUUID()}"><div class="form-grid">${partnerSelect}
    <div class="form-field full"><label for="req-description">What does your organization need?</label><input id="req-description" name="description" maxlength="200" required placeholder="e.g. Ingredients for community meal service"></div>
    <div class="form-field full"><label for="req-categories">Requested categories</label><select id="req-categories" name="categories" multiple required size="4">${["Bakery","Produce","Prepared meals","Dairy","Packaged goods","Other"].map((c)=>`<option>${c}</option>`).join("")}</select><span class="form-hint">Use Ctrl/Command to select multiple categories.</span></div>
    <div class="form-field"><label for="req-quantity">Quantity requested</label><input id="req-quantity" name="quantity" type="number" min="0.01" step="0.01" required></div><div class="form-field"><label for="req-unit">Unit</label><select id="req-unit" name="unit">${["kg","items","boxes","litres"].map((u)=>`<option>${u}</option>`).join("")}</select></div>
    <div class="form-field full"><label for="req-destination">Delivery destination</label><input id="req-destination" name="destination" required maxlength="250"></div><div class="form-field"><label for="req-date">Required by</label><input id="req-date" name="required_by" type="datetime-local" required></div><div class="form-field"><label for="req-priority">Operational priority</label><select id="req-priority" name="priority"><option value="standard">Standard</option><option value="high">High</option><option value="urgent">Urgent</option></select></div>
    <div class="form-field full"><label for="req-handling">Storage and handling needs</label><textarea id="req-handling" name="handling_requirements" placeholder="Tell coordinators about storage or transport requirements"></textarea></div></div></form>`, "Submit request");
}
function reviewDonation(id) {
  const donation = state.data.donations.find((item)=>item.id===id);
  if (!donation) return;
  const configured = parseCategories(state.data.settings.safety_checklist);
  let checked = {}; try { checked = JSON.parse(donation.safety_checklist || "{}"); } catch { checked = {}; }
  const checks = configured.map((item)=>`<label class="checkline"><input type="checkbox" name="check_${escapeHTML(item)}" ${checked[item]?"checked":""}><span>${escapeHTML(item)}</span></label>`).join("");
  showModal("Food suitability review", `${donation.description} · ${formatQuantity(donation.quantity,donation.unit)}`, `<form id="modal-fields" data-submit="review-donation" data-id="${id}"><div class="form-grid"><div class="form-field full"><span class="form-label">Configured review checklist</span><div class="checklist">${checks || "No checklist configured. Confirm local requirements with the pilot team."}</div></div>
    <div class="form-field"><label for="review-status">Food review outcome</label><select id="review-status" name="review_status"><option value="pending" ${donation.review_status==="pending"?"selected":""}>Pending review</option><option value="approved" ${donation.review_status==="approved"?"selected":""}>Approved for matching</option><option value="rejected" ${donation.review_status==="rejected"?"selected":""}>Rejected</option></select></div>
    <div class="form-field"><label for="donation-status">Coordination status</label><select id="donation-status" name="status">${["new","under_review","approved","matched","scheduled","collected","delivered","rejected","cancelled","unresolved"].map((s)=>`<option value="${s}" ${donation.status===s?"selected":""}>${pretty(s)}</option>`).join("")}</select></div>
    <div class="form-field full"><label for="reject-reason">Rejection reason (required if rejected)</label><textarea id="reject-reason" name="rejection_reason">${escapeHTML(donation.rejection_reason || "")}</textarea></div><div class="form-field full"><label for="review-notes">Coordinator notes</label><textarea id="review-notes" name="coordinator_notes">${escapeHTML(donation.coordinator_notes || "")}</textarea></div>
    <p class="form-hint full">A generic checklist does not establish legal compliance. Participating organizations must confirm the applicable local requirements.</p></div></form>`, "Save review");
}
function proposeMatch(donationId, requestId) {
  const donation = state.suggestions.donations.find((item)=>item.id===donationId);
  const req = state.suggestions.requests.find((item)=>item.id===requestId);
  if (!donation || !req) return;
  const max = Math.min(donation.quantity, req.quantity);
  showModal("Review and propose a match", "Both organizations must approve. No quantity is reserved until coordinator confirmation.", `<form id="modal-fields" data-submit="propose-match"><input type="hidden" name="donation_id" value="${donation.id}"><input type="hidden" name="request_id" value="${req.id}"><div class="form-grid">
    <div class="form-field full"><label>Donation → request</label><div class="callout">${escapeHTML(donation.donor_name)} · ${escapeHTML(donation.description)} → ${escapeHTML(req.partner_name)} · ${escapeHTML(req.description)}</div></div>
    <div class="form-field"><label for="match-quantity">Proposed quantity (${escapeHTML(donation.unit)})</label><input id="match-quantity" name="quantity" type="number" min="0.01" max="${max}" step="0.01" value="${max}" required></div>
    <div class="form-field"><label>Available / needed</label><div class="field-control">${formatQuantity(donation.quantity,donation.unit)} / ${formatQuantity(req.quantity,req.unit)}</div></div>
    <div class="form-field"><label for="match-pickup">Proposed pickup</label><input id="match-pickup" name="pickup" type="datetime-local" value="${toLocal(donation.pickup_from)}" required></div><div class="form-field"><label for="match-delivery">Proposed delivery</label><input id="match-delivery" name="delivery" type="datetime-local" value="${toLocal(req.required_by)}" required></div>
    <div class="form-field full"><label class="checkline"><input name="transport_feasible" type="checkbox" required><span>I confirmed transport capacity and handling compatibility.</span></label></div>
    <div class="form-field full"><label class="checkline"><input name="timing_feasible" type="checkbox" required><span>I confirmed freshness/use-by timing and the partner's required-by date are feasible.</span></label></div>
    <div class="form-field full"><div class="callout warning">Advisory checks are not safety approval. Confirm pickup/destination with both organizations; check use-by, transport, and storage requirements before submitting.</div></div></div></form>`, "Send proposal");
}
function toLocal(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2,"0");
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function respondMatch(id) {
  const match = state.data.matches.find((item)=>item.id===id);
  const role = state.user.role;
  showModal("Review match proposal", `${match.donation_description || "Donation"} → ${match.request_description || "Community request"}`, `<form id="modal-fields" data-submit="respond-match" data-id="${id}"><div class="callout">Proposed ${formatQuantity(match.proposed_quantity,match.unit)} · Pickup ${dateTime(match.proposed_pickup)} · Delivery ${dateTime(match.proposed_delivery)}. Your decision records your organization's acceptance; the coordinator confirms the match afterward.</div><div class="form-field" style="margin-top:13px"><label for="approval-note">Note (optional)</label><textarea id="approval-note" name="note" placeholder="Add an operational note for the coordinator"></textarea></div></form>`, "Record acceptance");
  modal.querySelector(".modal-form").dataset.defaultResponse = role;
  modal.querySelector(".modal-footer").insertAdjacentHTML("afterbegin", `<button type="button" class="button button-danger button-small" data-action="decline-match" data-id="${id}">Decline</button>`);
}
function confirmMatch(id) {
  const drivers = state.data.team.filter((item)=>item.role==="driver" && item.active);
  showModal("Confirm approved match", "This reserves the proposed quantity and creates an assigned delivery.", `<form id="modal-fields" data-submit="confirm-match" data-id="${id}"><div class="callout">Confirmation is allowed only after both organizations accepted. The transaction checks remaining donation and request quantities again before reserving.</div><div class="form-field" style="margin-top:13px"><label for="driver-id">Assign driver / volunteer</label><select id="driver-id" name="driver_id"><option value="">Unassigned (coordinator must assign later)</option>${drivers.map((driver)=>`<option value="${driver.id}">${escapeHTML(driver.full_name)}</option>`).join("")}</select></div></form>`, "Confirm match & create delivery");
}
function deliveryProgress(id) {
  const item = state.data.deliveries.find((delivery)=>delivery.id===id);
  const driver = state.user.role === "driver";
  const possible = {
    scheduled: ["pickup_in_progress","pickup_failed","delayed","cancelled"],
    pickup_in_progress: ["collected","pickup_failed","delayed","unresolved"],
    collected: ["in_transit","delayed","unresolved"],
    in_transit: ["delivered","partially_delivered","rejected_on_arrival","delayed","unresolved"],
    delayed: ["pickup_in_progress","collected","in_transit","cancelled","unresolved"],
    pickup_failed: ["scheduled","cancelled","unresolved"],
    partially_delivered: ["delivered","unresolved"],
    rejected_on_arrival: ["unresolved","cancelled"],
    unresolved: ["scheduled","pickup_in_progress","collected","in_transit","delivered","cancelled"],
  }[item.status] || [];
  const allowed = driver ? possible.filter((status)=>["pickup_in_progress","collected","in_transit","pickup_failed","delayed","unresolved"].includes(status)) : possible;
  showModal("Update delivery progress", `${item.donor_name || item.pickup_location} → ${item.partner_name || item.destination}`, `<form id="modal-fields" data-submit="delivery-status" data-id="${id}"><div class="form-grid"><div class="form-field full"><label for="new-delivery-status">New status</label><select id="new-delivery-status" name="status" required>${allowed.map((status)=>`<option value="${status}">${pretty(status)}</option>`).join("")}</select></div><div class="form-field full"><label for="collected-qty">Quantity collected (${escapeHTML(item.unit)})</label><input id="collected-qty" name="quantity_collected" type="number" min="0" step="0.01" value="${item.quantity_collected ?? ""}"></div></div></form>`, "Update status");
}
function confirmDelivery(id, correction = false) {
  const item = state.data.deliveries.find((delivery)=>delivery.id===id);
  showModal(correction ? "Correct delivery receipt" : "Confirm delivery receipt", `${correction ? "A correction is appended; the original remains in the audit history. " : ""}Expected ${formatQuantity(item.quantity_expected,item.unit)} · ${item.partner_name || "Receiving partner"}`, `<form id="modal-fields" data-submit="delivery-confirm" data-id="${id}"><input type="hidden" name="is_correction" value="${correction}"><div class="form-grid">
    <div class="form-field"><label for="received">Quantity received (${escapeHTML(item.unit)})</label><input id="received" name="quantity_received" type="number" min="0" step="0.01" value="${item.quantity_expected}" required></div>
    <div class="form-field"><label for="acceptance">Acceptance</label><select id="acceptance" name="acceptance"><option value="accepted">Accepted in full</option><option value="partially_accepted">Partially accepted</option><option value="rejected">Rejected</option></select></div>
    <div class="form-field full"><label for="condition">Condition on arrival</label><textarea id="condition" name="condition_on_arrival" required placeholder="Packaging, freshness, condition, or other observations"></textarea></div>
    <div class="form-field"><label for="issue-category">Issue category (if applicable)</label><select id="issue-category" name="issue_category"><option value="quantity_discrepancy">Quantity discrepancy</option><option value="food_condition">Food condition</option><option value="packaging">Packaging</option><option value="delay">Delay</option><option value="other">Other</option></select></div>
    <div class="form-field"><label for="followup">Follow-up action</label><input id="followup" name="follow_up_action" placeholder="What should happen next?"></div>
    <div class="form-field full"><label for="issue-description">Issue description (if quantities differ)</label><textarea id="issue-description" name="issue_description"></textarea></div>
    <p class="form-hint full">A quantity discrepancy or partial/rejected delivery automatically creates an issue for coordinator review. Corrections are added as a new confirmation record.</p></div></form>`, "Record confirmation");
}
function updateIssue(id) {
  const issue = state.data.issues.find((item)=>item.id===id);
  showModal("Update issue follow-up", issue.description, `<form id="modal-fields" data-submit="issue" data-id="${id}"><div class="form-grid"><div class="form-field"><label for="issue-status">Issue status</label><select id="issue-status" name="status">${["open","under_investigation","resolved","closed"].map((status)=>`<option value="${status}" ${issue.status===status?"selected":""}>${pretty(status)}</option>`).join("")}</select></div><div class="form-field full"><label for="issue-followup">Follow-up action and resolution notes</label><textarea id="issue-followup" name="follow_up_action" required>${escapeHTML(issue.follow_up_action || "")}</textarea></div></div></form>`, "Save issue update");
}
function timelineModal(id) {
  api(`/api/deliveries/${id}/timeline`).then((data)=>{
    showModal("Delivery timeline", `${data.delivery.donor_name || data.delivery.pickup_location} → ${data.delivery.partner_name || data.delivery.destination}`, `${data.timeline.length ? `<div class="timeline">${data.timeline.map((event)=>{ let details={};try{details=JSON.parse(event.details||"{}")}catch{};return `<div class="timeline-item"><span class="timeline-dot"></span><span class="timeline-copy"><strong>${escapeHTML(activityLabel(event.action))}</strong><small>${escapeHTML(event.full_name || "FoodLink")} · ${dateTime(event.created_at)}${details.to?` · ${escapeHTML(pretty(details.to))}`:""}</small></span></div>`;}).join("")}</div>` : emptyState("No progress recorded yet","Updates will appear here as the driver and partner report progress.")}`, "");
    modal.querySelector(".modal-form")?.addEventListener("submit",(event)=>event.preventDefault());
  }).catch(()=>{});
}

function fieldFormData(form) {
  const data = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (data[key] !== undefined) data[key] = [].concat(data[key], value);
    else data[key] = value;
  }
  form.querySelectorAll('input[type="checkbox"]').forEach((input)=>{ data[input.name] = input.checked; });
  form.querySelectorAll("select[multiple]").forEach((select)=>{ data[select.name] = [...select.selectedOptions].map((o)=>o.value); });
  return data;
}
async function submitForm(form) {
  const action = form.dataset.form || form.dataset.submit;
  if (action === "login") {
    const data = fieldFormData(form);
    const result = await api("/api/login", { method: "POST", body: JSON.stringify(data) });
    state.user = result.user; state.csrf = result.csrf_token; state.demo = result.demo_mode; state.page = "dashboard";
    await refreshData(); render(); toast(`Welcome, ${state.user.name.split(" ")[0]}.`);
    return;
  }
  const data = fieldFormData(form);
  const id = form.dataset.id;
  if (action === "donation") {
    if (data.use_by) data.use_by = new Date(data.use_by).toISOString();
    data.pickup_from = new Date(data.pickup_from).toISOString(); data.pickup_until = new Date(data.pickup_until).toISOString();
    await api("/api/donations", { method: "POST", body: JSON.stringify(data) }); modal.close(); await refreshData(); render(); toast("Donation offer submitted for coordinator review.");
  } else if (action === "request") {
    data.required_by = new Date(data.required_by).toISOString();
    await api("/api/requests", { method: "POST", body: JSON.stringify(data) }); modal.close(); await refreshData(); render(); toast("Community food request submitted.");
  } else if (action === "review-donation") {
    const checks = {};
    form.querySelectorAll('input[type="checkbox"]').forEach((input)=>{checks[input.name.slice(6)] = input.checked;});
    data.safety_checklist = checks;
    await api(`/api/donations/${id}`, { method: "PATCH", body: JSON.stringify(data) }); modal.close(); await refreshData(); render(); toast("Food review and checklist saved.");
  } else if (action === "propose-match") {
    data.pickup = new Date(data.pickup).toISOString(); data.delivery = new Date(data.delivery).toISOString();
    await api("/api/matches", { method: "POST", body: JSON.stringify(data) }); modal.close(); await refreshData(); render(); toast("Proposal sent to donor and community partner.");
  } else if (action === "respond-match") {
    await api(`/api/matches/${id}/approval`, { method: "POST", body: JSON.stringify({ decision: "accepted", note: data.note }) }); modal.close(); await refreshData(); render(); toast("Your approval was recorded.");
  } else if (action === "confirm-match") {
    await api(`/api/matches/${id}/confirm`, { method: "POST", body: JSON.stringify(data) }); modal.close(); await refreshData(); render(); toast("Match confirmed and delivery created.");
  } else if (action === "delivery-status") {
    if (data.quantity_collected === "") delete data.quantity_collected;
    await api(`/api/deliveries/${id}/status`, { method: "PATCH", body: JSON.stringify(data) }); modal.close(); await refreshData(); render(); toast("Delivery progress updated.");
  } else if (action === "delivery-confirm") {
    data.is_correction = data.is_correction === "true";
    await api(`/api/deliveries/${id}/confirm`, { method: "POST", body: JSON.stringify(data) }); modal.close(); await refreshData(); render(); toast("Receipt recorded. Any discrepancy is assigned for coordinator follow-up.");
  } else if (action === "issue") {
    await api(`/api/issues/${id}`, { method: "PATCH", body: JSON.stringify(data) }); modal.close(); await refreshData(); render(); toast("Issue follow-up updated; the audit history is retained.");
  } else if (action === "feedback") {
    await api("/api/feedback", { method: "POST", body: JSON.stringify(data) }); modal.close(); await refreshData(); render(); toast("Thank you. Your feedback is recorded for pilot evaluation.");
  } else if (action === "organization") {
    await api("/api/organizations", { method: "POST", body: JSON.stringify(data) }); modal.close(); await refreshData(); render(); toast("Organization registered.");
  } else if (action === "team-member") {
    await api("/api/team", { method: "POST", body: JSON.stringify(data) }); modal.close(); await refreshData(); render(); toast("User account created. Share initial credentials through an approved secure channel.");
  } else if (action === "delivery-issue") {
    await api(`/api/deliveries/${id}/issues`, { method: "POST", body: JSON.stringify(data) }); modal.close(); await refreshData(); render(); toast("Issue sent to the coordinator for follow-up.");
  } else if (action === "settings") {
    await api("/api/settings", { method: "PATCH", body: JSON.stringify(data) }); await refreshData(); render(); toast("Pilot settings saved.");
  }
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const { action, page, id } = target.dataset;
  try {
    if (action === "landing") { state.page = state.user ? "dashboard" : "landing"; render(); }
    else if (action === "global-map") { state.page = "global-map"; render(); }
    else if (action === "auth") { state.page = "auth"; render(); }
    else if (action === "navigate") { state.page = page || "notifications"; if (window.innerWidth <= 820) document.querySelector("#sidebar")?.classList.remove("open"); render(); }
    else if (action === "mobile-nav") document.querySelector("#sidebar")?.classList.toggle("open");
    else if (action === "logout") { await api("/api/logout", { method: "POST", body: "{}" }); state.user = null; state.data = null; state.csrf = null; state.page = "landing"; render(); toast("You have signed out."); }
    else if (action === "new-donation") newDonationForm();
    else if (action === "new-request") newRequestForm();
    else if (action === "new-organization") newOrganizationForm();
    else if (action === "new-team-member") newTeamMemberForm();
    else if (action === "partner-feedback") feedbackForm();
    else if (action === "review-donation") reviewDonation(id);
    else if (action === "propose-match") proposeMatch(target.dataset.donation, target.dataset.request);
    else if (action === "accept-match") respondMatch(id);
    else if (action === "decline-match") {
      const form = modal.querySelector("#modal-fields");
      await api(`/api/matches/${id}/approval`, { method: "POST", body: JSON.stringify({ decision: "declined", note: form?.elements.note?.value || "" }) });
      modal.close(); await refreshData(); render(); toast("Proposal declined and coordinator notified.");
    }
    else if (action === "confirm-match") confirmMatch(id);
    else if (action === "cancel-match") {
      if (!window.confirm("Cancel this match? Confirmed quantities will be released, the delivery will be cancelled, and the change will be audited.")) return;
      await api(`/api/matches/${id}/cancel`, { method: "POST", body: "{}" }); await refreshData(); render(); toast("Match cancelled and reserved quantity released.");
    }
    else if (action === "delivery-progress") deliveryProgress(id);
    else if (action === "delivery-confirm") confirmDelivery(id, target.dataset.correction === "true");
    else if (action === "report-delivery-issue") reportIssue(id);
    else if (action === "timeline") timelineModal(id);
    else if (action === "update-issue") updateIssue(id);
    else if (action === "cancel-request") {
      if (!window.confirm("Cancel this request?")) return;
      await api(`/api/requests/${id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) }); await refreshData(); render(); toast("Request cancelled.");
    }
    else if (action === "cancel-donation") {
      if (!window.confirm("Cancel this donation offer?")) return;
      await api(`/api/donations/${id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) }); await refreshData(); render(); toast("Donation offer cancelled.");
    }
    else if (action === "read-notification") {
      await api(`/api/notifications/${id}/read`, { method: "POST", body: "{}" }); await refreshData(); render();
    }
    else if (action === "toggle-member") {
      await api(`/api/team/${id}`, { method: "PATCH", body: JSON.stringify({ active: target.dataset.active === "true" }) });
      await refreshData(); render(); toast("User access updated.");
    }
    else if (action === "clear-report-filters") {
      state.reportFilters = {}; state.reports = null; render();
    }
    else if (action === "focus-country") {
      const country = state.hungerData?.countries.find((item)=>item.iso3===target.dataset.iso);
      const info = document.getElementById("full-country-info");
      if (info) info.textContent = countryDescription(country || {name:target.dataset.iso,value:null});
      document.querySelector(`#full-map path[data-iso="${target.dataset.iso}"]`)?.focus();
    }
    else if (action === "password-reset") {
      const email = window.prompt("Enter your account email. External email delivery is not configured.");
      if (email) { const result = await api("/api/password-reset", { method: "POST", body: JSON.stringify({ email }) }); toast(result.message); }
    }
    else if (action === "demo-login") {
      const role = target.dataset.role;
      const emails = { administrator:"admin@foodlink.local", coordinator:"coordinator@foodlink.local", donor:"donor@foodlink.local", partner:"partner@foodlink.local", driver:"driver@foodlink.local" };
      const result = await api("/api/login", { method: "POST", body: JSON.stringify({ email: emails[role], password: "demo1234" }) });
      state.user = result.user; state.csrf = result.csrf_token; state.demo = result.demo_mode; state.page = "dashboard";
      await refreshData(); render(); toast(`Signed in as ${roleLabels[role]}.`);
    }
  } catch { /* API failures are surfaced by the shared request handler. */ }
});

document.addEventListener("change", (event) => {
  const control = event.target.closest("[data-report-filter]");
  if (!control) return;
  state.reportFilters[control.dataset.reportFilter] = control.value;
  state.reports = null;
  render();
});

document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.id === "modal-fields") {
    event.preventDefault();
    if (!form.reportValidity()) return;
    try { await submitForm(form); } catch { }
    return;
  }
  if (form.matches("[data-form]")) {
    event.preventDefault();
    if (!form.reportValidity()) return;
    try { await submitForm(form); } catch { }
  }
});
document.addEventListener("click", (event) => {
  if (event.target.matches("[data-action='close-modal']")) modal.close();
});
modal.addEventListener("click", (event) => {
  if (event.target === modal) modal.close();
});

async function start() {
  try {
    const result = await fetch("/api/session", { credentials: "same-origin" }).then((response)=>response.json());
    state.user = result.user; state.csrf = result.csrf_token; state.demo = result.demo_mode;
    if (state.user) { await refreshData(); state.page = "dashboard"; }
    else state.page = "landing";
    await render();
  } catch {
    appRoot.innerHTML = `<main class="auth-screen"><section class="auth-aside">${brand()}<div class="auth-aside-main"><h1>FoodLink is almost ready.</h1><p>The application server could not be reached. Start it with <code>python app.py</code>, then refresh this page.</p></div></section></main>`;
  }
}
start();
