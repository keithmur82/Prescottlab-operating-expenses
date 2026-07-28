// =====================================================
// CONFIG
// =====================================================
const QB_REALM   = 'mit.quickbase.com';
const QB_TOKEN   = 'b7kkpt_bkcg_0_ctgaj8yy7byuk2iezzhd5d46g2';
const TABLE_ID   = 'bv569jz6b';
const SUPERVISOR = 'Prescott /Sara L';

const FIDS = {
  supervisor:   20,
  creationDate: 21,
  category:      8,
  accountName:   9,
  accountId:    10,
  totalAmount:  11,
  itemName:     23
};

// Applies to the Operating Expenses tab (and the Animal tab after its filter).
// Empty = show all spend. Add category/account names here to hide them.
const EXCLUDED = [];

// Animal tab keeps only rows whose Category OR Item Name matches one of these.
const ANIMAL_KEYWORDS = [
  'animal', 'perdiem', 'per diem',
  'surgery', 'surgical', 'veterinary', 'diagnostic'
];

function isAnimal(d) {
  const hay = `${d.category} ${d.itemName}`.toLowerCase();
  return ANIMAL_KEYWORDS.some(k => hay.includes(k));
}

// Buckets an animal row into a charge type. First match wins.
function animalType(d) {
  const hay = `${d.category} ${d.itemName}`.toLowerCase();
  if (hay.includes('perdiem') || hay.includes('per diem')) return 'Per Diem';
  if (hay.includes('surgical'))                            return 'Surgical Supplies';
  if (hay.includes('surgery'))                             return 'Surgery Services';
  if (hay.includes('veterinary') || hay.includes(' vet')) return 'Veterinary';
  if (hay.includes('diagnostic'))                          return 'Diagnostic';
  if (hay.includes('purchase'))                            return 'Animal Purchases';
  if (hay.includes('animal'))                              return 'Animal (Other)';
  return 'Other';
}
// =====================================================

function dashboard() {
  return {
    loading: true,
    error: '',
    lastUpdated: '',
    rawData: [],
    filteredData: [],
    filteredCount: 0,
    view: 'animal',            // 'animal' = Animal Facility Charges, 'opex' = Operating Expenses
    currentRange: 'ytd',
    customStart: '',
    customEnd: '',
    tableSearch: '',
    ranges: [
      { key: 'last30', label: 'Last 30'      },
      { key: 'last90', label: 'Last 90'      },
      { key: 'ytd',    label: 'YTD'          },
      { key: 'fy',     label: `FY${getFY()}` },
      { key: 'all',    label: 'All Time'     },
      { key: 'custom', label: 'Custom'       }
    ],
    kpis: { totalSpent: 0, totalOrders: 0, topCategory: '—', avgTransaction: 0 },
    charts: {},

    async init() {
      await this.loadData();
    },

    async loadData() {
      this.loading = true;
      this.error   = '';
      try {
        const pageSize = 5000;
        let all = [], skip = 0, total = Infinity;
        while (skip < total) {
          const r = await fetch('https://api.quickbase.com/v1/records/query', {
            method: 'POST',
            headers: {
              'QB-Realm-Hostname': QB_REALM,
              'Authorization':     `QB-USER-TOKEN ${QB_TOKEN}`,
              'Content-Type':      'application/json'
            },
            body: JSON.stringify({
              from:    TABLE_ID,
              select:  Object.values(FIDS),
              where:   `{'${FIDS.supervisor}'.EX.'${SUPERVISOR}'}`,
              sortBy:  [{ fieldId: FIDS.creationDate, order: 'DESC' }],
              options: { top: pageSize, skip }
            })
          });
          if (!r.ok) throw new Error(`Quickbase API ${r.status}: ${await r.text()}`);
          const json = await r.json();
          const rows = json.data || [];
          all   = all.concat(rows);
          total = (json.metadata && json.metadata.totalRecords != null) ? json.metadata.totalRecords : all.length;
          if (rows.length === 0) break;
          skip += rows.length;
          if (skip > 100000) break;   // hard safety cap
        }
        this.rawData     = all.map(row => normalizeRow(row));
        this.lastUpdated = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        this.applyFilters();
      } catch (e) {
        this.error = e.message;
        console.error(e);
      } finally {
        this.loading = false;
      }
    },

    setView(v) {
      if (this.view === v) return;
      this.view = v;
      this.applyFilters();
    },

    setRange(key) {
      this.currentRange = key;
      if (key !== 'custom') this.applyFilters();
    },

    applyFilters() {
      const [start, end] = getDateBounds(this.currentRange, this.customStart, this.customEnd);
      this.filteredData  = this.rawData.filter(d => {
        if (this.view === 'animal' && !isAnimal(d)) return false;   // Animal tab only
        if (EXCLUDED.includes(d.category))    return false;
        if (EXCLUDED.includes(d.accountName)) return false;
        if (!start && !end) return true;
        if (!d.creationDate) return false;
        const t = new Date(d.creationDate).getTime();
        if (start && t < start) return false;
        if (end   && t > end  ) return false;
        return true;
      });
      this.filteredCount = this.filteredData.length;
      this.computeKPIs();
      this.$nextTick(() => requestAnimationFrame(() => this.renderCharts()));
    },

    computeKPIs() {
      const totalSpent  = kSum(this.filteredData.map(d => d.totalAmount));
      const totalOrders = this.filteredData.length;

      const catTotals = {};
      this.filteredData.forEach(d => {
        const cat = d.category || 'Unknown';
        catTotals[cat] = (catTotals[cat] || 0) + d.totalAmount;
      });

      const acctTotals = {};
      this.filteredData.forEach(d => {
        const acct = d.accountName || 'Unknown';
        acctTotals[acct] = (acctTotals[acct] || 0) + d.totalAmount;
      });

      const topCategory    = Object.entries(catTotals).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
      const topAccount     = Object.entries(acctTotals).sort((a, b) => b[1] - a[1])[0]?.[0] || '—';
      const avgTransaction = totalOrders > 0 ? totalSpent / totalOrders : 0;
      this.kpis = { totalSpent, totalOrders, topCategory, topAccount, avgTransaction };
    },

    get categoryBreakdown() { return breakdown(this.filteredData, 'category',    this.kpis.totalSpent); },
    get accountBreakdown()  { return breakdown(this.filteredData, 'accountName', this.kpis.totalSpent); },
    get itemBreakdown()     { return breakdown(this.filteredData, 'itemName',    this.kpis.totalSpent); },

    get typeBreakdown() {
      const map = {};
      this.filteredData.forEach(d => {
        const key = animalType(d);
        if (!map[key]) map[key] = { name: key, total: 0, count: 0 };
        map[key].total += d.totalAmount;
        map[key].count += 1;
      });
      const grand = this.kpis.totalSpent;
      return Object.values(map)
        .sort((a, b) => b.total - a.total)
        .map(g => ({
          ...g,
          pct: grand !== 0 ? ((g.total / grand) * 100).toFixed(1) : '0.0',
          avg: g.count  > 0 ? g.total / g.count : 0
        }));
    },

    get animalBreakdown() {
      const types = {};
      this.filteredData.forEach(d => {
        const t = animalType(d);
        if (!types[t]) types[t] = { name: t, total: 0, count: 0, items: {} };
        types[t].total += d.totalAmount;
        types[t].count += 1;
        const item = d.itemName || d.category || 'Unknown';
        if (!types[t].items[item]) types[t].items[item] = { name: item, total: 0, count: 0 };
        types[t].items[item].total += d.totalAmount;
        types[t].items[item].count += 1;
      });
      const grand = this.kpis.totalSpent;
      return Object.values(types)
        .sort((a, b) => b.total - a.total)
        .map(t => ({
          name:  t.name,
          total: t.total,
          count: t.count,
          avg:   t.count > 0 ? t.total / t.count : 0,
          pct:   grand !== 0 ? ((t.total / grand) * 100).toFixed(1) : '0.0',
          items: Object.values(t.items)
            .sort((a, b) => b.total - a.total)
            .map(it => ({
              name:  it.name,
              total: it.total,
              count: it.count,
              avg:   it.count > 0 ? it.total / it.count : 0,
              pct:   t.total !== 0 ? ((it.total / t.total) * 100).toFixed(1) : '0.0'
            }))
        }));
    },

    get filteredTable() {
      const q    = this.tableSearch.trim().toLowerCase();
      const rows = [...this.filteredData].sort((a, b) =>
        (b.creationDate || '').localeCompare(a.creationDate || '')
      );
      if (!q) return rows;
      return rows.filter(r =>
        [r.creationDate, r.category, r.itemName, r.accountName, String(r.accountId), String(r.totalAmount)]
          .some(v => String(v).toLowerCase().includes(q))
      );
    },

    // Each tab renders its OWN canvases, so switching tabs fully swaps the view.
    renderCharts() {
      const fd = this.filteredData;
      const jobs = this.view === 'animal'
        ? [
            () => this.renderBarInto('chartA_Accounts', groupSum(fd, 'accountName').slice(0, 10), '#00A793', true),
            () => this.renderPieInto('chartA_Pie',      groupSum(fd, 'accountName').slice(0, 8)),
            () => this.renderMonthlyInto('chartA_Monthly'),
            () => this.renderBarInto('chartA_Items',    groupSum(fd, 'itemName').slice(0, 10), '#C02184', true),
            () => this.renderBarInto('chartA_Types',    this.typeBreakdown.map(t => ({ name: t.name, total: t.total })), '#771A51', false)
          ]
        : [
            () => this.renderBarInto('chartO_Accounts', groupSum(fd, 'accountName').slice(0, 10), '#00A793', true),
            () => this.renderPieInto('chartO_Category', groupSum(fd, 'category').slice(0, 8)),
            () => this.renderMonthlyInto('chartO_Monthly')
          ];
      jobs.forEach(fn => { try { fn(); } catch (e) { console.error('Chart:', e); } });
    },

    renderMonthlyInto(id) {
      const map = {};
      this.filteredData.forEach(d => {
        if (!d.creationDate) return;
        const key = d.creationDate.slice(0, 7);
        map[key] = (map[key] || 0) + d.totalAmount;
      });
      const keys   = Object.keys(map).sort();
      const data   = keys.map(k => map[k]);
      const labels = keys.map(k => {
        const [yr, mo] = k.split('-');
        return new Date(yr, mo - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      });
      this.replaceChart(id, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label:           'Spend',
            data,
            backgroundColor: data.map(v => v < 0 ? '#D32F2F' : '#0D3551'),
            borderRadius:    4
          }]
        },
        options: chartOpts({ y: true })
      });
    },

    renderBarInto(id, grouped, color, rotate = false) {
      if (!grouped.length) return;
      this.replaceChart(id, {
        type: 'bar',
        data: {
          labels:   grouped.map(g => g.name),
          datasets: [{ label: 'Spend', data: grouped.map(g => g.total), backgroundColor: color, borderRadius: 4 }]
        },
        options: chartOpts({ y: true, rotateLabels: rotate })
      });
    },

    renderPieInto(id, grouped) {
      if (!grouped.length) return;
      this.replaceChart(id, {
        type: 'doughnut',
        data: {
          labels:   grouped.map(g => g.name),
          datasets: [{ data: grouped.map(g => g.total), backgroundColor: palette, borderWidth: 2, borderColor: '#fff' }]
        },
        options: {
          responsive:          true,
          maintainAspectRatio: false,
          layout: { padding: { top: 10, bottom: 10, left: 20, right: 20 } },
          plugins: {
            legend: { position: 'right', labels: { boxWidth: 12, font: { size: 11 }, color: '#555' } },
            tooltip: {
              callbacks: {
                label: ctx => {
                  const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                  const pct   = total ? ((ctx.parsed / total) * 100).toFixed(1) : '0.0';
                  return ` ${ctx.label}: ${fmt(ctx.parsed)} (${pct}%)`;
                }
              }
            }
          }
        }
      });
    },

    fmt(n)     { return fmt(n); },
    fmtDate(s) {
      if (!s) return '—';
      const d = new Date(s);
      return isNaN(d) ? s : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    },

    replaceChart(id, config) {
      const ctx = document.getElementById(id);
      if (!ctx) return;
      const ex = Chart.getChart(ctx);
      if (ex) ex.destroy();
      if (this.charts[id]) {
        try { this.charts[id].destroy(); } catch(e) {}
        this.charts[id] = null;
      }
      this.charts[id] = new Chart(ctx, config);
    }
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function normalizeRow(row) {
  const v = fid => {
    const cell = row[fid];
    if (!cell || cell.value == null) return '';
    if (Array.isArray(cell.value)) return cell.value.join(', ');
    if (typeof cell.value === 'object') return cell.value.email || cell.value.name || cell.value.id || '';
    return cell.value;
  };
  return {
    creationDate: String(v(FIDS.creationDate) || ''),
    category:     String(v(FIDS.category)     || 'Uncategorized'),
    itemName:     String(v(FIDS.itemName)     || ''),
    accountName:  String(v(FIDS.accountName)  || 'Unknown'),
    accountId:    v(FIDS.accountId)            ?? '',
    totalAmount:  Number(v(FIDS.totalAmount))  || 0
  };
}

function breakdown(data, key, grand) {
  const map = {};
  data.forEach(d => {
    const k = d[key] || 'Unknown';
    if (!map[k]) map[k] = { name: k, total: 0, count: 0 };
    map[k].total += d.totalAmount;
    map[k].count += 1;
  });
  return Object.values(map)
    .sort((a, b) => b.total - a.total)
    .map(g => ({
      ...g,
      pct: grand !== 0 ? ((g.total / grand) * 100).toFixed(1) : '0.0',
      avg: g.count  > 0 ? g.total / g.count : 0
    }));
}

function getDateBounds(range, cs, ce) {
  const now = Date.now(), day = 86400000;
  switch (range) {
    case 'last30': return [now - 30 * day, null];
    case 'last90': return [now - 90 * day, null];
    case 'ytd':    return [new Date(new Date().getFullYear(), 0, 1).getTime(), null];
    case 'fy': {
      const m = new Date().getMonth(), yr = new Date().getFullYear();
      return [(m >= 6 ? new Date(yr, 6, 1) : new Date(yr - 1, 6, 1)).getTime(), null];
    }
    case 'all':    return [null, null];
    case 'custom': return [
      cs ? new Date(cs).getTime()           : null,
      ce ? new Date(ce).getTime() + day     : null
    ];
    default: return [null, null];
  }
}

function getFY() {
  const d = new Date();
  return d.getMonth() >= 6
    ? (d.getFullYear() + 1).toString().slice(-2)
    : d.getFullYear().toString().slice(-2);
}

function fmt(n) {
  const num = Number(n) || 0;
  const abs = Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (num < 0 ? '-$' : '$') + abs;
}

function kSum(arr) { return arr.reduce((a, b) => a + (Number(b) || 0), 0); }

function groupSum(data, key) {
  const map = {};
  data.forEach(d => {
    const k = d[key] || 'Unknown';
    if (!map[k]) map[k] = { name: k, total: 0, count: 0 };
    map[k].total += d.totalAmount;
    map[k].count += 1;
  });
  return Object.values(map).sort((a, b) => b.total - a.total);
}

function chartOpts({ y = false, rotateLabels = false } = {}) {
  return {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: y ? {
      y: {
        beginAtZero: true,
        ticks: { color: '#555', callback: v => '$' + v.toLocaleString() },
        grid:  { color: 'rgba(0,0,0,0.06)' }
      },
      x: rotateLabels
        ? { ticks: { color: '#555', maxRotation: 60, minRotation: 45, autoSkip: false, font: { size: 10 } }, grid: { color: 'rgba(0,0,0,0.04)' } }
        : { ticks: { color: '#555' }, grid: { color: 'rgba(0,0,0,0.04)' } }
    } : {}
  };
}

const palette = ['#771A51','#C02184','#0D3551','#00A793','#00A2C2','#F5A623','#D32F2F','#5C6BC0'];
