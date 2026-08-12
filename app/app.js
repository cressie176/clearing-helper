'use strict';

// ── UCAS Tariff ──────────────────────────────────────────────────────────────

const GRADE_TARIFF = { 'A*': 56, 'A': 48, 'B': 40, 'C': 32, 'D': 24, 'E': 16 };
const GRADES = ['A*', 'A', 'B', 'C', 'D', 'E', 'N/A'];

function gradesToTariff(grades) {
  return grades
    .filter(g => g !== 'N/A')
    .reduce((sum, g) => sum + (GRADE_TARIFF[g] || 0), 0);
}

function parseEntryReqTariff(reqString) {
  if (!reqString) return null;
  // Try to parse strings like "AAB", "A*BB", "ABB-BBB", "128", "128 UCAS points"
  const pointsMatch = reqString.match(/\b(\d{2,3})\b/);
  if (pointsMatch) return parseInt(pointsMatch[1], 10);

  // Try letter grade string (take the higher of a range)
  const grades = reqString.replace(/[^A-C*]/g, '').match(/A\*|[A-E]/g);
  if (grades && grades.length >= 2) {
    return gradesToTariff(grades.slice(0, 3));
  }
  return null;
}

function formatEntryReq(reqString, myTariff) {
  if (!reqString) return null;
  const reqTariff = parseEntryReqTariff(reqString);
  if (!reqTariff || !myTariff) return { label: reqString, cls: 'entry-req' };
  const diff = myTariff - reqTariff;
  if (diff >= 8) return { label: reqString, cls: 'entry-req achievable', tariff: reqTariff };
  if (diff >= -8) return { label: reqString, cls: 'entry-req marginal', tariff: reqTariff };
  return { label: reqString, cls: 'entry-req reach', tariff: reqTariff };
}

// ── State ────────────────────────────────────────────────────────────────────

const STATE_KEY = 'clearing-app-v1';

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function saveState(patch) {
  const current = loadState();
  localStorage.setItem(STATE_KEY, JSON.stringify({ ...current, ...patch }));
}

let state = {
  myGrades: ['A', 'B', 'B'],
  excludedCourses: [],     // array of course IDs excluded from search results
  excludedUnis: [],
  uniOrder: {},            // { uniName: preferenceNumber }
  filters: { 'startDate.month': ['September'] },  // default September
  entryReqMax: 128,        // upper bound tariff (ABB = 128); null = any
  entryReqMin: null,       // lower bound tariff; null = any
  hideTracked: true,       // hide tracked courses by default (checkbox inverted in UI)
  trackerStatusFilter: [], // empty = show all; otherwise show only matching statuses
  tracker: [],             // { id, uniName, courseName, courseCode, entryReq, contact, phone, ucasUrl, status, notes, addedAt }
  searchResults: [],       // last search results
  algoliaConfig: null,
  activeTab: 'search',
};

function hydrate() {
  const saved = loadState();
  Object.assign(state, saved);
  // Ensure arrays
  if (!Array.isArray(state.myGrades)) state.myGrades = ['A', 'B', 'B'];
  if (!Array.isArray(state.excludedCourses)) state.excludedCourses = [];
  if (!Array.isArray(state.excludedUnis)) state.excludedUnis = [];
  if (!Array.isArray(state.tracker)) state.tracker = [];
  if (!state.uniOrder) state.uniOrder = {};
  if (!state.filters) state.filters = {};
  if (!state.filters['startDate.month']?.length) state.filters['startDate.month'] = ['September'];
  if (state.entryReqMax == null) state.entryReqMax = 128;
  if (state.entryReqMin === undefined) state.entryReqMin = null;
  if (state.hideTracked === undefined) state.hideTracked = true;
  if (!Array.isArray(state.trackerStatusFilter)) state.trackerStatusFilter = [];
}

function persist() {
  saveState({
    myGrades: state.myGrades,
    excludedCourses: state.excludedCourses,
    excludedUnis: state.excludedUnis,
    uniOrder: state.uniOrder,
    filters: state.filters,
    entryReqMax: state.entryReqMax,
    entryReqMin: state.entryReqMin,
    hideTracked: state.hideTracked,
    trackerStatusFilter: state.trackerStatusFilter,
    tracker: state.tracker,
    activeTab: state.activeTab,
  });
}

// ── Algolia Search ───────────────────────────────────────────────────────────

window.algoliaConfig = null;

async function loadAlgoliaConfig() {
  if (window.algoliaConfig) return window.algoliaConfig;
  // Check for manually entered config in localStorage (highest priority)
  const override = localStorage.getItem('ucas-api-override');
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (parsed.appId && parsed.apiKey) {
        window.algoliaConfig = parsed;
        return window.algoliaConfig;
      }
    } catch {}
  }
  // Use config.js window variable (works with file://)
  if (window.UCAS_CONFIG?.appId) {
    window.algoliaConfig = window.UCAS_CONFIG;
    return window.algoliaConfig;
  }
  // Fall back to fetching JSON (works on HTTP server)
  try {
    const res = await fetch('./data/ucas-api-config.json');
    window.algoliaConfig = await res.json();
    return window.algoliaConfig;
  } catch {
    return null;
  }
}

window.loadAlgoliaConfig = loadAlgoliaConfig;

async function searchUCAS(query, page = 0) {
  const config = await loadAlgoliaConfig();
  if (!config?.appId || !config?.apiKey) {
    throw new Error('UCAS API configuration not found. Please run scripts/find-ucas-api.js or enter credentials manually.');
  }

  const { appId, apiKey, indexName } = config;

  const facetFilterGroups = [
    ['academicYearId:2026'],
    ['uiFilters:Undergraduate'],
    ['vacancies:England'],
    ['entryPoints.name:Year 1'],
  ];
  Object.entries(state.filters).forEach(([facet, values]) => {
    if (values && values.length > 0) {
      facetFilterGroups.push(values.map(v => `${facet}:${v}`));
    }
  });
  const facetFilters = JSON.stringify(facetFilterGroups);

  const params = [
    `query=${encodeURIComponent(query || 'psychology')}`,
    'hitsPerPage=200',
    `page=${page}`,
    `facetFilters=${encodeURIComponent(facetFilters)}`,
    'filters=NOT%20academicYearId%3A2024%20AND%20NOT%20academicYearId%3A2025%20AND%20NOT%20academicYearId%3A2028%20AND%20NOT%20academicYearId%3A2029%20AND%20NOT%20entryPoints.name%3A%22Foundation%20Year%22',
    'attributesToRetrieve=courseTitle,localTitle,applicationCode,courseId,provider,location,academicEntryRequirements,ucasTariff,duration,studyMode,startDate,outcomeQualification,vacancies',
  ].join('&');

  const body = {
    requests: [{
      indexName: indexName || 'd10prod_courses_new',
      params,
    }],
  };

  const url = `https://${appId}-dsn.algolia.net/1/indexes/*/queries`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Algolia-Application-Id': appId,
      'X-Algolia-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Algolia API error ${resp.status}: ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  const result = data.results?.[0];
  const hits = (result?.hits || []).map(normalizeHit);

  // Auto-fetch next page if there are more results (up to 500 total)
  if (page === 0 && result?.nbPages > 1 && hits.length < 500) {
    const page2 = await searchUCAS(query, 1);
    return [...hits, ...page2];
  }

  return hits;
}

function normalizeHit(hit) {
  // Extract A-level entry requirement
  const aLevelReq = (hit.academicEntryRequirements || [])
    .find(r => r.name === 'A level' && !r.notAccepted);
  const entryReq = aLevelReq?.offer?.grades || '';

  // Build UCAS tariff from ucasTariff field
  const tariff = hit.ucasTariff?.min ? `${hit.ucasTariff.min} pts` : '';

  // Build UCAS URL
  const slug = (hit.courseTitle || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const ucasUrl = hit.courseId
    ? `https://www.ucas.com/explore/courses/${hit.courseId}/${slug}?studyYear=2026`
    : '';

  return {
    id: hit.courseId || hit.objectID,
    courseName: hit.courseTitle || '',
    courseCode: hit.applicationCode || '',
    uniName: hit.provider?.name || '',
    city: hit.location?.townOrCity || hit.provider?.townOrCity || '',
    region: hit.location?.region?.grouped || '',
    entryReq,       // A-level grades string e.g. "BBC"
    tariffMin: hit.ucasTariff?.min || null,
    tariffMax: hit.ucasTariff?.max || null,
    tariffDisplay: tariff,
    qualification: hit.outcomeQualification?.name || '',
    duration: hit.duration?.caption || '',
    studyMode: hit.studyMode?.mappedCaption || '',
    ucasUrl,
    // Contact details are not in the Algolia index — user clicks through to UCAS page
    phone: '',
    email: '',
  };
}

// ── Universities Data ─────────────────────────────────────────────────────────

let universitiesData = null;

async function loadUniversities() {
  if (universitiesData) return universitiesData;
  // Use universities-data.js window variable (works with file://)
  if (window.UNIVERSITIES_DATA?.universities?.length) {
    universitiesData = window.UNIVERSITIES_DATA;
    return universitiesData;
  }
  // Fall back to fetching JSON (works on HTTP server)
  try {
    const res = await fetch('./data/universities.json');
    universitiesData = await res.json();
    return universitiesData;
  } catch {
    return { universities: [] };
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function myTariff() {
  return gradesToTariff(state.myGrades);
}

function isTracked(courseCode, uniName) {
  return state.tracker.some(t =>
    (courseCode && t.courseCode === courseCode) ||
    (t.uniName === uniName && t.courseName)
  );
}

function renderTabBadges() {
  document.getElementById('tracker-badge').textContent = state.tracker.length || '';
  document.getElementById('tracker-badge').style.display = state.tracker.length ? 'inline-flex' : 'none';
}


// ── Tabs ──────────────────────────────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tab}`));
  state.activeTab = tab;
  persist();

  if (tab === 'universities') renderUniversitiesTab();
  if (tab === 'tracker') renderTrackerTab();
}

window.switchTab = switchTab;

// ── Search Tab ────────────────────────────────────────────────────────────────

async function runSearch() {
  const btn = document.getElementById('search-btn');
  const resultsEl = document.getElementById('search-results');
  const query = document.getElementById('query-input').value.trim() || 'psychology';

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Searching...';
  resultsEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Searching UCAS clearing...</p></div>';

  try {
    const results = await searchUCAS(query);
    state.searchResults = results;
    persist();
    renderSearchResults();
    showBanner(`Found ${results.length} courses matching "${query}"`, 'success');
  } catch (err) {
    resultsEl.innerHTML = `
      <div class="banner error">
        <strong>Search failed:</strong> ${escHtml(err.message)}
        <br><small>Check that the UCAS API config is set up correctly (run scripts/find-ucas-api.js).</small>
      </div>
    `;
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Search UCAS';
  }
}

window.runSearch = runSearch;

function renderSearchResults() {
  const el = document.getElementById('search-results');
  const metaEl = document.getElementById('search-meta');

  if (!state.searchResults.length) {
    el.innerHTML = '';
    metaEl.innerHTML = '';
    return;
  }

  const sortBy = document.getElementById('sort-select')?.value || 'preference';
  const tariff = myTariff();
  const trackedIds = new Set(state.tracker.map(t => t.courseCode).filter(Boolean));
  const trackedUniCourse = new Set(state.tracker.map(t => `${t.uniName}|${t.courseName}`));

  let results = [...state.searchResults];

  // Filter: hidden courses — count before removing
  const showHidden = document.getElementById('show-hidden')?.checked;
  const hiddenCourseCount = results.filter(r => state.excludedCourses.includes(r.id)).length;
  if (!showHidden) {
    results = results.filter(r => !state.excludedCourses.includes(r.id));
  }

  // Filter: no Foundation Year (belt-and-braces in case API filter misses any)
  results = results.filter(r => !/foundation/i.test(r.courseName));

  // Filter: Bachelors only — exclude integrated Masters (MSci etc.)
  results = results.filter(r => !r.qualification || !/master/i.test(r.qualification));

  // Filter: exclude hidden unis — count before removing
  const showExcluded = document.getElementById('show-excluded')?.checked;
  const excludedUniCount = results.filter(r => state.excludedUnis.includes(r.uniName)).length;
  if (!showExcluded) {
    results = results.filter(r => !state.excludedUnis.includes(r.uniName));
  }

  // Filter: entry requirement range (A-level req only — tariffMin covers all routes and is unreliable)
  if (state.entryReqMax != null || state.entryReqMin != null) {
    results = results.filter(r => {
      const t = parseEntryReqTariff(r.entryReq);
      if (!t) return true; // no A-level req stated — show it
      if (state.entryReqMax != null && t > state.entryReqMax) return false;
      if (state.entryReqMin != null && t < state.entryReqMin) return false;
      return true;
    });
  }

  // Filter: hide already tracked — count before removing
  const trackedCount = results.filter(r => {
    if (r.courseCode && trackedIds.has(r.courseCode)) return true;
    if (trackedUniCourse.has(`${r.uniName}|${r.courseName}`)) return true;
    return false;
  }).length;
  if (state.hideTracked) {
    results = results.filter(r => {
      if (r.courseCode && trackedIds.has(r.courseCode)) return false;
      if (trackedUniCourse.has(`${r.uniName}|${r.courseName}`)) return false;
      return true;
    });
  }

  // Sort
  results.sort((a, b) => {
    if (sortBy === 'preference') {
      const aOrd = state.uniOrder[a.uniName] ?? 999;
      const bOrd = state.uniOrder[b.uniName] ?? 999;
      return aOrd - bOrd;
    }
    if (sortBy === 'entry-high') {
      const aT = a.tariffMin ?? parseEntryReqTariff(a.entryReq) ?? 0;
      const bT = b.tariffMin ?? parseEntryReqTariff(b.entryReq) ?? 0;
      return bT - aT;
    }
    if (sortBy === 'entry-low') {
      const aT = a.tariffMin ?? parseEntryReqTariff(a.entryReq) ?? 999;
      const bT = b.tariffMin ?? parseEntryReqTariff(b.entryReq) ?? 999;
      return aT - bT;
    }
    if (sortBy === 'uni') return a.uniName.localeCompare(b.uniName);
    return 0;
  });

  const pills = [
    trackedCount ? `<button class="filter-pill" onclick="toggleShowTracked()" title="${state.hideTracked ? 'Click to show' : 'Click to hide'}">${trackedCount} tracked ${state.hideTracked ? '(hidden)' : '(shown)'}</button>` : '',
    excludedUniCount && !showExcluded ? `<button class="filter-pill" onclick="document.getElementById('show-excluded').click()" title="Click to show excluded">${excludedUniCount} excluded unis hidden</button>` : '',
    hiddenCourseCount && !showHidden ? `<button class="filter-pill" onclick="document.getElementById('show-hidden').click()" title="Click to show hidden courses">${hiddenCourseCount} hidden</button>` : '',
  ].filter(Boolean).join('');

  metaEl.innerHTML = `
    <span class="result-count">
      <strong>${results.length}</strong> courses${pills ? ` · ${pills}` : ''}
    </span>
    <div class="sort-group">
      <label>Sort:</label>
      <select class="sort-select" id="sort-select" onchange="renderSearchResults()">
        <option value="preference" ${sortBy === 'preference' ? 'selected' : ''}>Preferred Universities</option>
        <option value="entry-high" ${sortBy === 'entry-high' ? 'selected' : ''}>Entry req (high → low)</option>
        <option value="entry-low" ${sortBy === 'entry-low' ? 'selected' : ''}>Entry req (low → high)</option>
        <option value="uni" ${sortBy === 'uni' ? 'selected' : ''}>University A-Z</option>
      </select>
    </div>
  `;

  if (!results.length) {
    el.innerHTML = `
      <div class="no-results">
        <div class="icon">🔍</div>
        <p>No results match your current filters.</p>
        ${state.hideTracked ? '<p style="margin-top:8px"><small>You may have already tracked all matching courses.</small></p>' : ''}
      </div>
    `;
    return;
  }

  courseCache.clear();
  el.innerHTML = results.map(r => renderCourseCard(r, tariff)).join('');
}

window.renderSearchResults = renderSearchResults;

function entryReqClass(tariffMin, myTariff) {
  if (!tariffMin || !myTariff) return 'entry-req';
  const diff = myTariff - tariffMin;
  if (diff >= 8) return 'entry-req achievable';
  if (diff >= -8) return 'entry-req marginal';
  return 'entry-req reach';
}

function renderCourseCard(r, myTariffPts) {
  const isExcl = state.excludedUnis.includes(r.uniName);
  const isHidden = state.excludedCourses.includes(r.id);
  const alreadyTracked = isTracked(r.courseCode, r.uniName);
  const prefNum = state.uniOrder[r.uniName];
  const cardClasses = [
    'course-card',
    isExcl ? 'excluded' : '',
    isHidden ? 'hidden-course' : '',
    alreadyTracked ? 'already-tracked' : '',
  ].filter(Boolean).join(' ');

  const cid = cacheCourse(r);
  const entryLabel = r.entryReq || r.tariffDisplay || '';
  const tariffHint = r.tariffMin ? ` (${r.tariffMin}–${r.tariffMax ?? r.tariffMin} pts)` : '';

  return `
    <div class="${cardClasses}" id="course-${escHtml(cid)}">
      <div class="course-card-header">
        <div class="course-info">
          <div class="course-title">${escHtml(r.courseName)}</div>
          <div class="course-uni">${escHtml(r.uniName)}</div>
          <div class="course-code">
            ${r.courseCode ? `Code: ${escHtml(r.courseCode)}` : ''}
            ${r.duration ? ` · ${escHtml(r.duration)}` : ''}
          </div>
        </div>
        <div class="course-actions">
          ${alreadyTracked
            ? `<span class="already-tracked-badge">✓ Tracked</span>`
            : `<button class="btn btn-primary btn-sm" onclick="addToTrackerById('${escAttr(cid)}')">+ Track</button>`
          }
        </div>
      </div>

      <div class="course-meta">
        ${entryLabel ? `<span class="meta-chip">${escHtml(entryLabel)}</span>` : ''}
        ${r.city ? `<a class="meta-chip" style="text-decoration:none;cursor:pointer" href="https://maps.google.com/maps?q=${encodeURIComponent(r.uniName + ', ' + r.city)}&z=6" target="maps">${escHtml(r.city)}${r.region && r.region !== r.city ? `, ${escHtml(r.region)}` : ''}</a>` : ''}
        ${(() => {
          const raw = (r.qualification || '')
            .replace(/Bachelor of Science \(with Honours\)/g, 'BSc (Hons)')
            .replace(/Bachelor of Arts \(with Honours\)/g, 'BA (Hons)');
          const qual = [...new Set(raw.split(/\s*[-–]\s*/).map(s => s.trim()).filter(Boolean))].join(' / ');
          return qual ? `<span class="meta-chip">${escHtml(qual)}</span>` : '';
        })()}
      </div>

      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${r.ucasUrl ? `<a href="${escHtml(r.ucasUrl)}#contact-details" target="_blank" class="btn btn-secondary btn-sm">Full details & contact ↗</a>` : ''}
        <button class="btn ${isHidden ? 'btn-secondary' : 'btn-danger'} btn-sm" onclick="toggleExcludeCourse('${escAttr(r.id)}')">${isHidden ? 'Unhide' : 'Hide'}</button>
      </div>
    </div>
  `;
}

function addToTracker(course) {
  if (isTracked(course.courseCode, course.uniName)) return;
  state.tracker.push({
    id: `track-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    uniName: course.uniName,
    courseName: course.courseName,
    courseCode: course.courseCode,
    entryReq: course.entryReq || '',
    tariffMin: course.tariffMin || null,
    phone: course.phone || '',
    email: course.email || '',
    ucasUrl: course.ucasUrl || '',
    city: course.city || '',
    region: course.region || '',
    status: 'not-contacted',
    notes: '',
    addedAt: new Date().toISOString(),
  });
  persist();
  renderTabBadges();
  renderSearchResults();
  showBanner(`Added ${course.courseName} at ${course.uniName} to your tracker`, 'success');
}

window.addToTracker = addToTracker;

function toggleExcludeUni(uniName) {
  const idx = state.excludedUnis.indexOf(uniName);
  if (idx >= 0) {
    state.excludedUnis.splice(idx, 1);
  } else {
    state.excludedUnis.push(uniName);
  }
  persist();
  renderSearchResults();
  if (state.activeTab === 'universities') renderUniversitiesTab();
}

function toggleExcludeCourse(courseId) {
  const idx = state.excludedCourses.indexOf(courseId);
  if (idx >= 0) state.excludedCourses.splice(idx, 1);
  else state.excludedCourses.push(courseId);
  persist();
  renderSearchResults();
}

function toggleTrackerFilter(el) {
  const status = el.dataset.status;
  const idx = state.trackerStatusFilter.indexOf(status);
  if (idx >= 0) state.trackerStatusFilter.splice(idx, 1);
  else state.trackerStatusFilter.push(status);
  persist();
  renderTrackerTab();
}

window.toggleTrackerFilter = toggleTrackerFilter;

function toggleShowTracked() {
  state.hideTracked = !state.hideTracked;
  const cb = document.getElementById('show-tracked');
  if (cb) cb.checked = !state.hideTracked;
  persist();
  renderSearchResults();
}

window.toggleShowTracked = toggleShowTracked;
window.toggleExcludeUni = toggleExcludeUni;
window.toggleExcludeCourse = toggleExcludeCourse;

// ── Filter Chips ──────────────────────────────────────────────────────────────

function toggleFilter(el) {
  const facet = el.dataset.facet;
  const value = el.dataset.value;
  if (!state.filters[facet]) state.filters[facet] = [];
  const idx = state.filters[facet].indexOf(value);
  if (idx >= 0) {
    state.filters[facet].splice(idx, 1);
    el.classList.remove('active');
  } else {
    state.filters[facet].push(value);
    el.classList.add('active');
  }
  persist();
}

function setEntryReqFilter() {
  const maxEl = document.getElementById('filter-entry-max');
  const minEl = document.getElementById('filter-entry-min');
  state.entryReqMax = maxEl?.value ? parseInt(maxEl.value, 10) : null;
  state.entryReqMin = minEl?.value ? parseInt(minEl.value, 10) : null;
  persist();
}

function restoreFilterChips() {
  document.querySelectorAll('.filter-chip[data-facet]').forEach(chip => {
    const active = state.filters[chip.dataset.facet]?.includes(chip.dataset.value);
    chip.classList.toggle('active', !!active);
  });
  const maxEl = document.getElementById('filter-entry-max');
  if (maxEl) maxEl.value = state.entryReqMax != null ? String(state.entryReqMax) : '';
  const minEl = document.getElementById('filter-entry-min');
  if (minEl) minEl.value = state.entryReqMin != null ? String(state.entryReqMin) : '';
}

window.toggleFilter = toggleFilter;
window.setEntryReqFilter = setEntryReqFilter;

// ── Universities Tab – drag-and-drop ranked list ──────────────────────────────

let _allUnis = [];   // full ordered list (parallel to DOM)
let _dragSrc = null; // index of item being dragged

async function renderUniversitiesTab() {
  const el = document.getElementById('unis-list');
  el.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading...</p></div>';

  const data = await loadUniversities();
  const unis = data.universities || [];

  if (!unis.length) {
    el.innerHTML = '<div class="banner warning">No university data found.</div>';
    return;
  }

  // Determine display order: saved preference order first, then unranked sorted by psych rank
  const ranked = Object.entries(state.uniOrder)
    .sort((a, b) => a[1] - b[1])
    .map(([name]) => unis.find(u => u.name === name))
    .filter(Boolean);

  const rankedNames = new Set(ranked.map(u => u.name));
  // Sort: real psychology ranks first, then alphabetical
  const unranked = unis
    .filter(u => !rankedNames.has(u.name))
    .sort((a, b) => {
      const aR = parseInt(a.psychologyRank) || null;
      const bR = parseInt(b.psychologyRank) || null;
      if (aR && bR) return aR - bR;
      if (aR) return -1;
      if (bR) return 1;
      return a.name.localeCompare(b.name);
    });

  _allUnis = [...ranked, ...unranked];

  el.innerHTML = '';
  _allUnis.forEach((u, i) => el.appendChild(_makeUniItem(u, i + 1)));

  _initDragDrop(el);
}

function _makeUniItem(u, rank) {
  const isExcl = state.excludedUnis.includes(u.name);

  const div = document.createElement('div');
  div.className = ['uni-list-item', isExcl ? 'excluded' : ''].filter(Boolean).join(' ');
  div.dataset.name = u.name;
  div.draggable = true;

  div.innerHTML = `
    <span class="uni-drag-handle" title="Drag to reorder">⠿</span>
    <span class="uni-rank-num">${rank}</span>
    <div class="uni-list-info">
      <div class="uni-list-name">
        ${escHtml(u.name)}
        ${u.psychologyRank ? `<span class="rank-chip psych" style="margin-left:6px;vertical-align:middle">Rank #${escHtml(u.psychologyRank)}</span>` : ''}
      </div>
      <div class="uni-list-sub">${u.city ? escHtml(u.city) : ''}</div>
      ${u.cityDescription ? `<div class="uni-list-desc">${escHtml(u.cityDescription)}</div>` : ''}
    </div>
    <div class="uni-list-actions">
      <button class="btn ${isExcl ? 'btn-secondary' : 'btn-danger'} btn-sm"
        onclick="toggleExcludeUni('${escAttr(u.name)}')"
        style="white-space:nowrap">
        ${isExcl ? 'Include' : 'Exclude'}
      </button>
    </div>
  `;

  return div;
}

function _initDragDrop(list) {
  list.addEventListener('dragstart', e => {
    const item = e.target.closest('.uni-list-item');
    if (!item) return;
    _dragSrc = [...list.children].indexOf(item);
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', _dragSrc);
  });

  list.addEventListener('dragover', e => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const item = e.target.closest('.uni-list-item');
    list.querySelectorAll('.drag-above').forEach(el => el.classList.remove('drag-above'));
    if (item) item.classList.add('drag-above');
  });

  list.addEventListener('dragleave', e => {
    if (!list.contains(e.relatedTarget)) {
      list.querySelectorAll('.drag-above').forEach(el => el.classList.remove('drag-above'));
    }
  });

  list.addEventListener('drop', e => {
    e.preventDefault();
    const item = e.target.closest('.uni-list-item');
    if (!item || _dragSrc === null) return;

    const items = [...list.children];
    const destIndex = items.indexOf(item);
    if (_dragSrc === destIndex) return;

    const dragged = items[_dragSrc];
    // Insert before or after target depending on direction
    if (_dragSrc < destIndex) {
      list.insertBefore(dragged, item.nextSibling);
    } else {
      list.insertBefore(dragged, item);
    }

    _saveOrder(list);
    item.classList.remove('drag-above');
  });

  list.addEventListener('dragend', () => {
    list.querySelectorAll('.dragging, .drag-above').forEach(el => {
      el.classList.remove('dragging', 'drag-above');
    });
    _dragSrc = null;
  });
}

function _saveOrder(list) {
  const newOrder = {};
  [...list.children].forEach((item, i) => {
    const name = item.dataset.name;
    if (name) {
      newOrder[name] = i + 1;
      const rankEl = item.querySelector('.uni-rank-num');
      if (rankEl) rankEl.textContent = i + 1;
    }
  });
  state.uniOrder = newOrder;
  persist();
}

// ── Tracker Tab ───────────────────────────────────────────────────────────────

function renderTrackerTab() {
  const el = document.getElementById('tracker-list');
  const filterRow = document.getElementById('tracker-status-filters');

  if (!state.tracker.length) {
    if (filterRow) filterRow.style.display = 'none';
    el.innerHTML = `
      <div class="tracker-empty">
        <div class="icon">📋</div>
        <h3>No courses tracked yet</h3>
        <p>Search for courses and click "+ Track" to add them here.</p>
      </div>
    `;
    return;
  }

  if (filterRow) filterRow.style.display = '';

  // Restore chip active states
  filterRow?.querySelectorAll('.filter-chip[data-status]').forEach(chip => {
    chip.classList.toggle('active', state.trackerStatusFilter.includes(chip.dataset.status));
  });

  // Sort: accepted first, then by status priority, then by addedAt
  const statusOrder = { 'accepted': 0, 'offer': 1, 'contacted': 2, 'not-contacted': 3, 'declined': 4 };
  let sorted = [...state.tracker].sort((a, b) => {
    return (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
  });

  // Filter by status if any chips are active
  if (state.trackerStatusFilter.length) {
    sorted = sorted.filter(t => state.trackerStatusFilter.includes(t.status));
  }

  if (!sorted.length) {
    el.innerHTML = `<div class="no-results"><p>No courses match the selected status filter.</p></div>`;
    return;
  }

  el.innerHTML = sorted.map(t => renderTrackerCard(t)).join('');
}

function renderTrackerCard(t) {
  const added = new Date(t.addedAt);
  const addedStr = added.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return `
    <div class="tracker-card status-${t.status}" id="tracker-${t.id}">
      <div class="tracker-card-header">
        <div class="tracker-info">
          <div class="course-title">${escHtml(t.courseName)}</div>
          <div class="course-uni">${escHtml(t.uniName)}</div>
          ${t.courseCode ? `<div class="course-code">Code: ${escHtml(t.courseCode)}</div>` : ''}
        </div>
        <div class="status-select-wrapper">
          <select class="status-select status-${t.status}" onchange="updateTrackerStatus('${t.id}', this.value)">
            <option value="not-contacted" ${t.status === 'not-contacted' ? 'selected' : ''}>Not contacted</option>
            <option value="contacted" ${t.status === 'contacted' ? 'selected' : ''}>Called / Contacted</option>
            <option value="offer" ${t.status === 'offer' ? 'selected' : ''}>Offer received</option>
            <option value="declined" ${t.status === 'declined' ? 'selected' : ''}>Offer declined</option>
            <option value="accepted" ${t.status === 'accepted' ? 'selected' : ''}>ACCEPTED ✓</option>
          </select>
        </div>
      </div>

      <div class="course-meta" style="margin-bottom:10px">
        ${t.entryReq ? `<span class="meta-chip">${escHtml(t.entryReq)}</span>` : ''}
        ${t.city ? `<span class="meta-chip">${escHtml(t.city)}${t.region ? `, ${escHtml(t.region)}` : ''}</span>` : ''}
      </div>

      ${(t.phone || t.email) ? `
        <div class="course-contact" style="margin-bottom:10px">
          ${t.phone ? `<span>📞 <span class="contact-phone">${escHtml(t.phone)}</span></span>` : ''}
          ${t.email ? `<span>✉️ ${escHtml(t.email)}</span>` : ''}
        </div>
      ` : ''}

      <textarea
        class="tracker-notes"
        placeholder="Notes (e.g. spoke to admissions, reference number, follow-up needed...)"
        onchange="updateTrackerNotes('${t.id}', this.value)"
      >${escHtml(t.notes)}</textarea>

      <div class="tracker-meta">
        <span class="tracker-added">Added ${addedStr}</span>
        <div style="display:flex;gap:8px">
          ${t.ucasUrl ? `<a href="${escHtml(t.ucasUrl)}#contact-details" target="_blank" class="btn btn-secondary btn-sm">Full details & contact ↗</a>` : ''}
          <button class="btn btn-secondary btn-sm" onclick="removeFromTracker('${t.id}')">Remove</button>
        </div>
      </div>
    </div>
  `;
}

function updateTrackerStatus(id, status) {
  const item = state.tracker.find(t => t.id === id);
  if (item) {
    item.status = status;
    persist();
    renderTrackerTab();
    renderTabBadges();
  }
}

function updateTrackerNotes(id, notes) {
  const item = state.tracker.find(t => t.id === id);
  if (item) { item.notes = notes; persist(); }
}

function removeFromTracker(id) {
  state.tracker = state.tracker.filter(t => t.id !== id);
  persist();
  renderTrackerTab();
  renderTabBadges();
  renderSearchResults();
}

window.updateTrackerStatus = updateTrackerStatus;
window.updateTrackerNotes = updateTrackerNotes;
window.removeFromTracker = removeFromTracker;

// ── Course cache (avoids passing objects through HTML onclick attributes) ─────

const courseCache = new Map();

function cacheCourse(course) {
  courseCache.set(course.id, course);
  return course.id;
}

function addToTrackerById(id) {
  const course = courseCache.get(id);
  if (course) addToTracker(course);
}

window.addToTrackerById = addToTrackerById;

// ── UI Helpers ────────────────────────────────────────────────────────────────

let bannerTimer = null;
function showBanner(msg, type = 'info') {
  const el = document.getElementById('status-banner');
  el.className = `banner ${type}`;
  el.textContent = msg;
  el.style.display = 'flex';
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.style.display = 'none'; }, 4000);
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(str) {
  return String(str || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function escJson(obj) {
  return JSON.stringify(obj).replace(/'/g, "\\'").replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

// ── API Config Modal ──────────────────────────────────────────────────────────

function openApiConfigModal() {
  const saved = JSON.parse(localStorage.getItem('ucas-api-override') || '{}');
  document.getElementById('config-app-id').value = saved.appId || '';
  document.getElementById('config-api-key').value = saved.apiKey || '';
  document.getElementById('config-index').value = saved.indexName || '';
  document.getElementById('api-config-modal').classList.add('open');
}

function closeApiConfigModal() {
  document.getElementById('api-config-modal').classList.remove('open');
}

function saveApiConfig() {
  const config = {
    appId: document.getElementById('config-app-id').value.trim(),
    apiKey: document.getElementById('config-api-key').value.trim(),
    indexName: document.getElementById('config-index').value.trim(),
  };
  localStorage.setItem('ucas-api-override', JSON.stringify(config));
  window.algoliaConfig = config;
  closeApiConfigModal();
  checkApiStatus();
  showBanner('API config saved — try searching now', 'success');
}

async function checkApiStatus() {
  const el = document.getElementById('api-status');
  if (!el) return;
  const config = await loadAlgoliaConfig();
  if (config?.appId && config?.apiKey) {
    el.innerHTML = `<span style="font-size:0.8rem;color:var(--green)">✓ UCAS API configured (App: ${escHtml(config.appId)})</span>`;
  } else {
    el.innerHTML = `
      <div class="banner warning" style="margin:0;font-size:0.82rem">
        UCAS API not configured yet. Run <code>node scripts/find-ucas-api.js</code> then refresh,
        or <button class="btn btn-secondary btn-sm" onclick="openApiConfigModal()" style="margin-left:8px">Enter credentials manually</button>
      </div>
    `;
  }
}

window.openApiConfigModal = openApiConfigModal;
window.closeApiConfigModal = closeApiConfigModal;
window.saveApiConfig = saveApiConfig;
window.checkApiStatus = checkApiStatus;

// ── Init ──────────────────────────────────────────────────────────────────────

function init() {
  hydrate();
  renderTabBadges();
  restoreFilterChips();
  switchTab(state.activeTab || 'search');

  // Checkboxes
  const showTrackedCb = document.getElementById('show-tracked');
  if (showTrackedCb) {
    showTrackedCb.checked = !state.hideTracked;
    showTrackedCb.addEventListener('change', function() {
      state.hideTracked = !this.checked;
      persist();
      renderSearchResults();
    });
  }
  document.getElementById('show-excluded')?.addEventListener('change', renderSearchResults);
  document.getElementById('show-hidden')?.addEventListener('change', renderSearchResults);

  // Close modals on backdrop click
  document.getElementById('api-config-modal')?.addEventListener('click', function(e) {
    if (e.target === this) closeApiConfigModal();
  });

  // Enter key on search
  document.getElementById('query-input')?.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') runSearch();
  });

  // Check API status
  checkApiStatus();
}

document.addEventListener('DOMContentLoaded', init);
