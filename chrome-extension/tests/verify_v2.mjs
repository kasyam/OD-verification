/**
 * Unit tests for PRICE 3.0 Helper Chrome Extension (v2.1.0)
 * Zero external dependencies — runs under Node.js 24+.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Minimal HTML -> DOM Shim for Testing Pure Portal Parsers in Node.js
// ---------------------------------------------------------------------------
class MiniElement {
  constructor(tagName, attrs = {}, parent = null) {
    this.tagName = tagName.toUpperCase();
    this.attrs = { ...attrs };
    this.parentElement = parent;
    this.children = [];
    this._textNodes = [];
  }

  get id() {
    return this.attrs.id || '';
  }

  get value() {
    return this.attrs.value !== undefined ? this.attrs.value : '';
  }

  get className() {
    return this.attrs.class || '';
  }

  get childElementCount() {
    return this.children.length;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  hasAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name);
  }

  get textContent() {
    let out = '';
    const allParts = this._orderedParts || [];
    for (const p of allParts) {
      out += typeof p === 'string' ? p : p.textContent;
    }
    return out;
  }

  get innerText() {
    return this.textContent;
  }

  contains(node) {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }

  matches(selectorGroup) {
    return String(selectorGroup || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .some((sel) => matchesCompoundSelector(this, sel));
  }

  closest(selectorGroup) {
    const selectors = String(selectorGroup || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    let cur = this;
    while (cur) {
      if (selectors.some((sel) => matchesCompoundSelector(cur, sel))) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  cloneNode(deep) {
    const c = new MiniElement(this.tagName, this.attrs, null);
    c._orderedParts = [];
    for (const p of this._orderedParts || []) {
      if (typeof p === 'string') {
        c._orderedParts.push(p);
      } else if (deep) {
        const cc = p.cloneNode(true);
        cc.parentElement = c;
        c.children.push(cc);
        c._orderedParts.push(cc);
      }
    }
    return c;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((x) => x !== this);
    if (this.parentElement._orderedParts) {
      this.parentElement._orderedParts = this.parentElement._orderedParts.filter((x) => x !== this);
    }
  }

  querySelectorAll(selectorGroup) {
    const selectors = selectorGroup
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const out = [];
    const seen = new Set();
    const walk = (node) => {
      for (const ch of node.children) {
        if (selectors.some((sel) => matchesCompoundSelector(ch, sel))) {
          if (!seen.has(ch)) {
            seen.add(ch);
            out.push(ch);
          }
        }
        walk(ch);
      }
    };
    walk(this);
    return out;
  }

  querySelector(selectorGroup) {
    return this.querySelectorAll(selectorGroup)[0] || null;
  }
}

function decodeHtmlEntities(str) {
  return String(str == null ? '' : str)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&amp;/gi, '&');
}

function matchesSimpleSelector(el, sel) {
  let rem = sel.trim();
  if (!rem) return false;
  if (rem.includes(':not([type="hidden"])')) {
    if ((el.getAttribute('type') || '').toLowerCase() === 'hidden') return false;
    rem = rem.replace(':not([type="hidden"])', '');
  }
  const attrMatches = [];
  rem = rem.replace(/\[([^\]]+)\]/g, (_, inner) => {
    attrMatches.push(inner);
    return '';
  });

  const parts = rem.split(/(?=[#.])/);
  for (const p of parts) {
    if (!p) continue;
    if (p.startsWith('#')) {
      if (el.id !== p.slice(1)) return false;
    } else if (p.startsWith('.')) {
      const cls = (el.className || '').split(/\s+/);
      if (!cls.includes(p.slice(1))) return false;
    } else {
      if (el.tagName !== p.toUpperCase()) return false;
    }
  }

  for (const am of attrMatches) {
    const starEq = am.match(/^([a-zA-Z0-9_-]+)\*=["']?([^"']+)["']?$/);
    if (starEq) {
      const v = el.getAttribute(starEq[1]) || '';
      if (!v.includes(starEq[2])) return false;
      continue;
    }
    const eq = am.match(/^([a-zA-Z0-9_-]+)=["']?([^"']+)["']?$/);
    if (eq) {
      if ((el.getAttribute(eq[1]) || '') !== eq[2]) return false;
      continue;
    }
    if (!el.hasAttribute(am)) return false;
  }
  return true;
}

function matchesCompoundSelector(el, sel) {
  const tokens = sel
    .trim()
    .replace(/\s*>\s*/g, ' > ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  if (!matchesSimpleSelector(el, tokens[tokens.length - 1])) return false;
  let cur = el.parentElement;
  for (let i = tokens.length - 2; i >= 0; i--) {
    if (tokens[i] === '>') {
      i--;
      if (i < 0 || !cur || !matchesSimpleSelector(cur, tokens[i])) return false;
      cur = cur.parentElement;
      continue;
    }
    while (cur && !matchesSimpleSelector(cur, tokens[i])) {
      cur = cur.parentElement;
    }
    if (!cur) return false;
    cur = cur.parentElement;
  }
  return true;
}

function parseAttrs(attrStr) {
  const attrs = {};
  const re = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const name = m[1].toLowerCase();
    const val = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
    attrs[name] = decodeHtmlEntities(val);
  }
  return attrs;
}

function parseMiniHtml(html) {
  const root = new MiniElement('DOCUMENT', {}, null);
  root._orderedParts = [];
  const stack = [root];
  const voidTags = new Set(['input', 'br', 'hr', 'img', 'meta', 'link']);
  const tokenRe = /<script[\s\S]*?<\/script>|<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^>]*)?)\s*(\/?)>|([^<]+)/gi;

  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    const raw = m[0];
    if (raw.startsWith('<!--') || raw.toLowerCase().startsWith('<script')) continue;

    if (m[1]) {
      const closeTag = m[1].toUpperCase();
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i].tagName === closeTag) {
          stack.length = i;
          break;
        }
      }
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrs = parseAttrs(m[3] || '');
      const selfClose = Boolean(m[4]) || voidTags.has(tag);
      const parent = stack[stack.length - 1];
      const el = new MiniElement(tag, attrs, parent);
      el._orderedParts = [];
      parent.children.push(el);
      parent._orderedParts.push(el);
      if (!selfClose) {
        stack.push(el);
      }
    } else if (m[5]) {
      const parent = stack[stack.length - 1];
      parent._orderedParts.push(decodeHtmlEntities(m[5]));
    }
  }
  root.body = root.querySelector('body') || root;
  return root;
}

globalThis.DOMParser = class {
  parseFromString(html) {
    return parseMiniHtml(html);
  }
};

// Load extension modules in exact manifest order
const db = require('../db.js');
const extractor = require('../extractor.js');
const register = require('../register.js');
const overlay = require('../overlay.js');

// ---------------------------------------------------------------------------
// 1. SHO Rule, Calendar -1 Day Completion Date & Extension Schedule Tests
// ---------------------------------------------------------------------------
{
  // Case A: Agreement 14/10/2026, Signed 30-10-2026 -> Deemed 24-10-2026 (10th day unchanged)
  const sho1 = extractor.computeEffectiveShoDate({
    agreementDate: '14/10/2026',
    contractorSignedDate: '30-10-2026',
  });
  assert.equal(sho1.deemedShoDate, '24-10-2026');
  assert.equal(sho1.shoDate, '24-10-2026');
  assert.equal(sho1.shoSource, undefined); // Req 5: SHO mode removed

  // Completion excludes last/anniversary day: 24-10-2026 + 6m - 1d => 23-04-2027
  assert.equal(
    extractor.computeCompletionDate(sho1.shoDate, { years: 0, months: 6, days: 0 }),
    '23-04-2027'
  );
  assert.equal(extractor.computeCompletionDate('01-01-2026', { months: 1 }), '31-01-2026');
  assert.equal(extractor.computeCompletionDate('01-01-2026', { years: 1 }), '31-12-2026');
  assert.equal(extractor.computeCompletionDate('24-08-2026', { months: 1 }), '23-09-2026');
  assert.equal(extractor.computeCompletionDate('07-08-2024', { years: 1, months: 6 }), '06-02-2026');
  assert.equal(extractor.computeCompletionDate('10-08-2026', { days: 1 }), '10-08-2026');

  // Case B: Agreement 03/08/2026, Signed 10-08-2026 -> Contractor Signed 10-08-2026
  const sho2 = extractor.computeEffectiveShoDate({
    agreementDate: '03-08-2026',
    contractorSignedDate: '10-08-2026',
  });
  assert.equal(sho2.deemedShoDate, '13-08-2026');
  assert.equal(sho2.shoDate, '10-08-2026');
  assert.equal(sho2.shoSource, undefined);

  // Exact calendar addition edge cases
  assert.equal(extractor.addCalendarPeriod('31-01-2026', { months: 1 }), '28-02-2026');
  assert.equal(extractor.addCalendarPeriod('31-01-2024', { months: 1 }), '29-02-2024');
  assert.equal(extractor.addCalendarPeriod('29-02-2024', { years: 1 }), '28-02-2025');

  // Urgent work without Agreement/History falls back strictly to Site Handover WCA card date
  const shoUrgent = extractor.computeEffectiveShoDate({
    agreementDate: '',
    contractorSignedDate: '',
    wcaShoDate: '24.08.2026',
  });
  assert.equal(shoUrgent.shoDate, '24-08-2026');
  assert.equal(shoUrgent.shoSource, undefined);

  // Sign pending within 10 days -> empty SHO
  const shoPendingWithin = extractor.computeEffectiveShoDate({
    agreementDate: '15-11-2026',
    contractorSignedDate: '',
    referenceTodayDmy: '20-11-2026',
  });
  assert.equal(shoPendingWithin.shoDate, '');
  assert.equal(shoPendingWithin.shoSource, undefined);

  // Schedule status respects extendedCompletionDate
  const schedExt = extractor.computeScheduleStatus('31-08-2026', false, '22-11-2026', '31-12-2026');
  assert.equal(schedExt.key, 'ongoing');
  assert.equal(schedExt.isExtended, true);
  assert.equal(schedExt.effectiveDate, '31-12-2026');
  assert.equal(schedExt.label, 'Due in 39d (Ext)');
}

// ---------------------------------------------------------------------------
// 2. HTML Parsers against Live PRICE 3.0 Fixtures (107175/2021, 14166/2026, 1846/2023)
// ---------------------------------------------------------------------------
{
  // A. Composite Retendered Work (1846/2023) — Last Tender + cwEstId precedence
  const compositeMenuHtml = `
    <ul id="pt-side-menu-full">
      <li>
        <span>Construction of New Building Phase2</span>
        <ul>
          <li>
            <span>Composite Civil Work[PWD/BLDG/EST/1846/2023_9_1_1]</span>
            <ul>
              <li><a onclick="call_basicestimation('tok', '2335025666')">DPR</a></li>
              <li><a onclick="callsbd('tok', '242371')">pre-Tender1</a></li>
              <li><a onclick="callloa_cw('tok', '243304', '2335025666')">Letter of Acceptance</a></li>
              <li><a onclick="callsbd('tok', '243762')">pre-Tender2</a></li>
              <li><a onclick="callloa_cw('tok', '243832', '2335025666')">Letter of Acceptance</a></li>
              <li><a onclick="callpricehandover('tok', '2624712777')">Site Handover</a></li>
              <li><a onclick="callembook('2319515')">eMbook</a></li>
              <li><a onclick="callebill('2319497')">e-Bills</a></li>
            </ul>
          </li>
          <li>
            <span>Composite Primary Component[PWD/BLDG/EST/1846/2023_5_1_1]</span>
            <ul>
              <li><a onclick="call_basicestimation('tok', '231173001')">DPR</a></li>
            </ul>
          </li>
          <li>
            <span>Composite Final Component[PWD/BLDG/EST/1846/2023_23_2_1]</span>
            <ul>
              <li><a onclick="call_basicestimation('tok', '247464430')">DPR</a></li>
              <li><a onclick="callsbd('tok', '242371')">pre-Tender1</a></li>
              <li><a onclick="callloa_cw('tok', '243304', '247464430')">Letter of Acceptance</a></li>
              <li><a onclick="callsbd('tok', '243762')">pre-Tender2</a></li>
              <li><a onclick="callloa_cw('tok', '243832', '247464430')">Letter of Acceptance</a></li>
              <li><a onclick="callpricehandover('tok', '2624712777')">Site Handover</a></li>
              <li><a onclick="callembook('243299')">eMbook</a></li>
              <li><a onclick="callebill('243217')">e-Bills</a></li>
            </ul>
          </li>
        </ul>
      </li>
    </ul>
  `;
  const compStruct = extractor.parseSideMenuStructure(parseMiniHtml(compositeMenuHtml));
  assert.equal(compStruct.hasCompositeFinal, true);
  assert.equal(compStruct.anchorComponent.activityName, 'Composite Final Component');
  assert.equal(compStruct.components.find((c) => c.activityName === 'Composite Primary Component').isHelper, true);

  const compIds = extractor.parseSideMenuIds(parseMiniHtml(compositeMenuHtml));
  assert.equal(compIds.handoverEstId, '2624712777');
  assert.equal(compIds.primarySbdId, '243762'); // last pre-Tender first!
  assert.deepEqual(compIds.sbdIds, ['243762', '242371']);
  assert.equal(compIds.primaryLoa.posttenderid, '243832'); // last LOA first!

  // loa.pro cwEstId precedence over sub-component estId
  const loaHtmlComposite = `
    <a id="agreement_tab" onclick="eagreement('tok','243832','23029701847','243299','2624712777','243217')">EAgreement</a>
    <script>function eagreement(){ var params={ cwEstId:'2624712777' }; }</script>
  `;
  const eagParams = extractor.parseLoaEagreementParams(loaHtmlComposite, {
    posttenderid: '243832',
    cwEstId: '2335025666',
  });
  assert.equal(eagParams.cwEstId, '2624712777');
  assert.equal(eagParams.estmainid, '243217');

  assert.equal(extractor.isPortalErrorHtml('Oops! Something went wrong...'), true);
  assert.equal(extractor.isPortalErrorHtml('Page Exception'), true);
  assert.equal(extractor.isPortalErrorHtml('Ajax Exception'), true);
  assert.equal(extractor.isPortalErrorHtml(loaHtmlComposite), false);

  // B. Multi-activity Urgent Work (14166/2026)
  const urgentMenuHtml = `
    <ul id="pt-side-menu-full">
      <li>
        <span>works at Rest House Aranmula</span>
        <ul>
          <li>
            <span>General Electrical Work[PWD/BLDG/EST/14166/2026_6_1_1]</span>
            <ul>
              <li><a onclick="call_basicestimation('tok','2640822562')">DPR</a></li>
              <li><a onclick="callsbd('tok','2611821')">pre-Tender1</a></li>
              <li><a onclick="callposttender('tok','2611821')">post-Tender1</a>
                <ul>
                  <li><a onclick="callpricehandover('tok','2640822562')">Site Handover</a></li>
                  <li><a onclick="callembook('2615591')">eMbook</a></li>
                  <li><a onclick="callebill('2615630')">e-Bills</a></li>
                </ul>
              </li>
            </ul>
          </li>
          <li>
            <span>Electrical AC Work[PWD/BLDG/EST/14166/2026_13_1_1]</span>
            <ul>
              <li><a onclick="call_basicestimation('tok','2689022557')">DPR</a></li>
              <li><a onclick="callsbd('tok','2611820')">pre-Tender1</a></li>
              <li><a onclick="callposttender('tok','2611820')">post-Tender1</a>
                <ul>
                  <li><a onclick="callpricehandover('tok','2689022557')">Site Handover</a></li>
                  <li><a onclick="callembook('2615592')">eMbook</a></li>
                </ul>
              </li>
            </ul>
          </li>
        </ul>
      </li>
    </ul>
  `;
  const urgentStruct = extractor.parseSideMenuStructure(parseMiniHtml(urgentMenuHtml));
  assert.equal(urgentStruct.components.length, 2);
  assert.equal(urgentStruct.components[0].activityName, 'General Electrical Work');
  assert.equal(urgentStruct.components[0].hasEBillStage, true);
  assert.equal(urgentStruct.components[1].activityName, 'Electrical AC Work');
  assert.equal(urgentStruct.components[1].hasEBillStage, false);
  assert.equal(urgentStruct.components[1].hasEmbook, true);
  assert.deepEqual(urgentStruct.components[1].postTenderSbdIds, ['2611820']);

  // Negotiated Rate + PostTender IDs + Bidder View (without LOA)
  const negRateHtml = `
    <table id="pt-specifications1">
      <thead><tr><th>No</th><th>Bidder</th><th>Estimate PAC</th><th>LMR PAC</th><th>Current SoR PAC</th><th>Quoted Rate (%)</th><th>Quoted PAC</th><th>Remarks</th><th>Negotiated Rate (%)</th><th>Negotiated PAC</th><th>Status</th></tr></thead>
      <tbody>
        <tr><td>1</td><td>XAVIER JOSEPH(BBAPJ6071J)</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td><b>LQI</b></td><td>(+)0</td><td>0</td><td><i class="fa fa-check-circle pt-c-teal me-1"></i></td></tr>
      </tbody>
    </table>
  `;
  const negRes = extractor.parseNegotiatedRateHtml(negRateHtml);
  assert.equal(negRes.contractorName, 'XAVIER JOSEPH');
  assert.equal(negRes.contractorPan, 'BBAPJ6071J');
  assert.equal(negRes.negotiatedRate, '(+)0');

  const ptMainHtml = `<input type="hidden" id="sbdid" name="sbdid1" value="2611821"><input type="hidden" id="ptid" name="ptid1" value="2611002">`;
  const ptIds = extractor.parsePostTenderIdsHtml(ptMainHtml);
  assert.deepEqual(ptIds, { ptid: '2611002', sbdid: '2611821' });

  const bidderHtml = `
    <table id="pd-attachment-table">
      <thead><tr><th>No</th><th>PAN Number</th><th>Bidder Name</th><th>e-mail Id</th><th>Mobile No</th><th>Applicant Type</th><th>Is LCC</th></tr></thead>
      <tbody>
        <tr><td>1</td><td>BBAPJ6071J</td><td>XAVIER JOSEPH</td><td>jobyjoseph55555@gmail.com</td><td>9048696154</td><td>INDIVIDUAL APPLICANT</td><td>No</td></tr>
      </tbody>
    </table>
  `;
  const bidderRes = extractor.parseBidderViewHtml(bidderHtml, 'BBAPJ6071J', 'XAVIER JOSEPH');
  assert.equal(bidderRes.mobile, '9048696154');
  assert.equal(bidderRes.email, 'jobyjoseph55555@gmail.com');

  // C. work_component_analysis.pro & mbook_view.pro (M-Book Closed & SHO Date isolation)
  const wcaClosedHtml = `
    <div class="container-fluid">
      <h5 class="bg-grey p-2 mt-2">Site Handover</h5>
      <div class="row mb-2"><div class="col-md-6"><label>Closed On :</label></div><div class="col-md-6"><b>24-08-2026</b></div></div>
      <div class="row mb-2"><div class="col-md-6"><label>Status :</label></div><div class="col-md-6"><b>Closed</b></div></div>
    </div>
    <div class="container-fluid">
      <h5 class="bg-grey p-2 mt-2">MBook</h5>
      <div class="row mb-2"><div class="col-md-6"><label>Initiated On :</label></div><div class="col-md-6"><b>20-09-2022</b></div></div>
      <div class="row mb-2"><div class="col-md-6"><label>Current Stage :</label></div><div class="col-md-6"><b>eMBook Pending with AE</b></div></div>
      <div class="row mb-2"><div class="col-md-6"><label>Status :</label></div><div class="col-md-6"><b>Closed</b></div></div>
    </div>
  `;
  const wcaParsed = extractor.parseWorkComponentAnalysisHtml(wcaClosedHtml);
  assert.equal(wcaParsed.mbookStatus, 'Closed');
  assert.equal(wcaParsed.wcaShoDate, '24-08-2026');
  assert.equal(wcaParsed.mbookCurrentStage, 'eMBook Pending with AE');

  assert.equal(
    extractor.parseMbookViewClosedHtml('<a onclick="activate_mbook(\'22097319279\')">ACTIVATE MBOOK</a>'),
    true
  );
  assert.equal(extractor.parseMbookViewClosedHtml('<table id="pt-specifications"></table>'), false);

  // Verify Tender Opening Date never enters parseTsFromHandoverHtml / SHO
  const handoverPageWithTenderDate = `
    <table>
      <tr><td>Technical Sanction Number :</td><td><b>14236/2021-2022</b></td></tr>
      <tr><td>Technical Sanction Date :</td><td><b>19-01-2022</b></td></tr>
      <tr><td>Tender Opening Date :</td><td><b>20-01-2022</b></td></tr>
      <tr><td>Agreed PAC :</td><td><b>28375.00</b></td></tr>
    </table>
  `;
  const phParsed = extractor.parseTsFromHandoverHtml(handoverPageWithTenderDate);
  assert.equal(phParsed.tsNo, '14236/2021-2022');
  assert.equal(phParsed.shoDate, undefined);

  // D. Period & Work Priority
  const periodUrgentHtml = `
    <select id="durationYear"><option value="-1">Year</option></select>
    <select id="durationMonth"><option value="1" selected>1</option></select>
    <select id="durationDay"><option value="-1">Day</option></select>
    <select id="workPriorityCode"><option value="3" selected>Urgent Works - VVIP</option></select>
    <select id="workExecutionCode"><option value="2" selected>Quotation</option></select>
  `;
  const pUrgent = extractor.parsePeriodHtml(periodUrgentHtml);
  assert.equal(pUrgent.periodMonths, 1);
  assert.equal(pUrgent.workPriority, 'Urgent Works - VVIP');
  assert.equal(pUrgent.workExecutionMode, 'Quotation');
}

// ---------------------------------------------------------------------------
// 3. M-Book Closed Classification, Missing Fields & Archival Rules
// ---------------------------------------------------------------------------
{
  const completePd = {
    fetchedAt: '2026-11-22T00:00:00Z',
    extractorVersion: 3,
    constituency: 'KONNI',
    asNo: 'AS/10/2025',
    tsNo: 'TS/20/2025',
    periodText: '6 Months',
    shoDate: '10-08-2026',
    contractor: { name: 'ALPHA BUILDERS' },
  };

  // M-Book Closed (without final bill) — PWD/BLDG/FL/107175/2021 pattern
  const w107175 = {
    fileId: '2112638107176',
    fileNumber: 'PWD/BLDG/FL/107175/2021',
    components: [
      {
        estmainid: '21939051',
        hasEBillStage: true,
        hasEmbook: true,
        componentLabel: 'Electrical Lift Work[PWD/BLDG/EST/107175/2021_15_1_1]',
        mbookStatus: 'Closed',
        bills: [],
      },
    ],
    projectDetails: { ...completePd, hasLoa: true, agreementNo: '10/2022' },
  };
  const sum107175 = extractor.analyzeWorkRecord(w107175);
  assert.equal(sum107175.categoryKey, 'mbook_closed_no_final');
  assert.equal(sum107175.label, 'M-Book Closed (No Final Bill)');
  assert.equal(sum107175.hasMbookClosedNoFinal, true);
  assert.equal(sum107175.hasAnyBills, false);
  assert.equal(db.isWorkArchivable(w107175, sum107175), false);

  // Multi-activity 14166/2026: Act 1 Final (Pending) + Act 2 M-Book Closed (No e-Bill stage)
  const w14166 = {
    fileId: '2661614167',
    fileNumber: 'PWD/BLDG/FL/14166/2026',
    components: [
      {
        estmainid: '2615630',
        hasEBillStage: true,
        hasEmbook: true,
        hasPostTender: true,
        componentLabel: 'General Electrical Work[PWD/BLDG/EST/14166/2026_6_1_1]',
        mbookStatus: 'Closed',
        bills: [{ billTypeAndNo: 'PWD/BLDG/EB/14166/2026_6_1_1_Final', status: 'Pending', grandTotal: '314452' }],
        details: { ...completePd, isUrgentPreAgreement: true, hasLoa: false },
      },
      {
        estmainid: null,
        hasEBillStage: false,
        hasEmbook: true,
        hasPostTender: true,
        componentLabel: 'Electrical AC Work[PWD/BLDG/EST/14166/2026_13_1_1]',
        mbookStatus: 'Closed',
        bills: [],
        details: { ...completePd, tsNo: '', isUrgentPreAgreement: true, hasLoa: false },
      },
    ],
    projectDetails: { ...completePd, isUrgentPreAgreement: true, hasLoa: false },
  };
  const sum14166 = extractor.analyzeWorkRecord(w14166);
  assert.equal(sum14166.hasAnyFinal, true);
  assert.equal(sum14166.isFullyFinalized, false);
  assert.equal(sum14166.hasFinal, false); // Work is NOT finalized until all trackable activities are finalized
  assert.equal(sum14166.categoryKey, 'partial_final');
  assert.equal(sum14166.hasMbookClosedNoFinal, true);
  assert.deepEqual(sum14166.activityNames, ['General Electrical Work', 'Electrical AC Work']);
  assert.match(sum14166.label, /Partial Final \(1\/2\).*1 M-Book Closed/);
  assert.equal(db.isWorkArchivable(w14166, sum14166), false);
  assert.equal(extractor.getMissingFields(w14166, sum14166).isIncomplete, false); // Urgent pre-agreement doesn't fail on missing Agreement No

  // Archival requires v3 extractor AND complete core fields
  const mkFinal = (pdOverride) => ({
    fileId: '101',
    fileNumber: 'PWD/BLDG/FL/101/2025',
    components: [
      {
        estmainid: '55',
        hasEBillStage: true,
        componentLabel: 'General Electrical Work[EST/101]',
        bills: [{ billTypeAndNo: 'First & Final', status: 'Submitted to EMILI', grandTotal: '100000' }],
      },
    ],
    projectDetails: { ...completePd, ...pdOverride },
  });

  const wArchOk = mkFinal({});
  assert.equal(db.isWorkArchivable(wArchOk, extractor.analyzeWorkRecord(wArchOk)), true);

  const wPreV3 = mkFinal({ extractorVersion: undefined });
  assert.equal(db.isWorkArchivable(wPreV3, extractor.analyzeWorkRecord(wPreV3)), false);
  assert.equal(extractor.getMissingFields(wPreV3).isIncomplete, true);

  const wMissingCore = mkFinal({ asNo: '', shoDate: '' });
  assert.equal(db.isWorkArchivable(wMissingCore, extractor.analyzeWorkRecord(wMissingCore)), false);
  const mf = extractor.getMissingFields(wMissingCore);
  assert.equal(mf.isIncomplete, true);
  assert.ok(mf.missing.includes('AS No.'));
  assert.ok(mf.missing.includes('SHO Date'));

  // Non-destructive merge preserves userData and existing metadata
  const existingRec = {
    ...wArchOk,
    userData: {
      workStatus: 'Work Completed',
      physicalProgress: 100,
      extensions: [{ order: 1, extendedDate: '31-12-2026', fineAmount: 2500 }],
      updatedAt: '2026-11-22T01:00:00Z',
    },
  };
  const blankIncoming = {
    ...wArchOk,
    projectDetails: {
      fetchedAt: '2026-11-22T02:00:00Z',
      extractorVersion: 3,
      constituency: '',
      asNo: '',
      tsNo: '',
      shoDate: '',
      contractor: { name: '' },
    },
  };
  const merged = db.mergeImportedRecord(existingRec, blankIncoming);
  assert.equal(merged.projectDetails.constituency, 'KONNI');
  assert.equal(merged.projectDetails.asNo, 'AS/10/2025');
  assert.equal(merged.userData.workStatus, 'Work Completed');
  assert.equal(merged.userData.physicalProgress, 100);
  assert.equal(merged.userData.extensions.length, 1);
}

// ---------------------------------------------------------------------------
// 4. Extensions, Progress, Privacy Defaults, Activity Filtering & Reports
// ---------------------------------------------------------------------------
{
  // Privacy & v2.3 Defaults: Contractor Phone, PAN, Email, Bill Status hidden by default;
  // Combined workDetails & agreementNoDate in PWD standard order; Schedule Status & Physical Progress kept
  assert.equal(register.COLUMN_PRESETS.standard.includes('contractorMobile'), false);
  assert.equal(register.COLUMN_PRESETS.standard.includes('contractorPan'), false);
  assert.equal(register.COLUMN_PRESETS.standard.includes('contractorEmail'), false);
  assert.equal(register.COLUMN_PRESETS.standard.includes('billCategory'), false);
  assert.equal(register.COLUMN_PRESETS.standard.includes('shoSource'), false);
  assert.equal(register.COLUMN_PRESETS.agreement_schedule.includes('contractorMobile'), false);
  assert.equal(register.COLUMN_PRESETS.agreement_schedule.includes('contractorEmail'), false);
  assert.equal(register.COLUMN_PRESETS.agreement_schedule.includes('shoSource'), false);
  assert.equal(register.COLUMN_PRESETS.sanctions.includes('contractorPan'), false);
  assert.equal(register.COLUMN_PRESETS.sanctions.includes('contractorEmail'), false);
  assert.equal(register.COLUMN_PRESETS.sanctions.includes('billCategory'), false);
  assert.equal(register.COLUMNS.some((c) => c.key === 'shoSource'), false);
  assert.equal(register.COLUMNS.find((c) => c.key === 'totalActiveAmount').label, 'Financial Status');
  assert.deepEqual(register.COLUMN_PRESETS.standard, [
    'slNo',
    'workDetails',
    'constituency',
    'asNoDate',
    'tsNoDate',
    'agreementNoDate',
    'agreedPac',
    'contractorName',
    'shoDate',
    'periodText',
    'completionDate',
    'extendedCompletionDate',
    'scheduleStatus',
    'workStatus',
    'physicalProgress',
    'totalActiveAmount',
  ]);
  assert.ok(register.COLUMN_PRESETS.standard.includes('workDetails'));
  assert.ok(register.COLUMN_PRESETS.standard.includes('agreementNoDate'));
  assert.ok(register.COLUMN_PRESETS.standard.includes('scheduleStatus'));
  assert.ok(register.COLUMN_PRESETS.standard.includes('physicalProgress'));
  assert.ok(register.COLUMN_PRESETS.standard.includes('totalActiveAmount'));
  assert.ok(register.COLUMN_PRESETS.standard.includes('asNoDate'));
  assert.ok(register.COLUMN_PRESETS.standard.includes('tsNoDate'));
  assert.ok(register.COLUMN_PRESETS.standard.includes('extendedCompletionDate'));
  assert.ok(register.COLUMN_PRESETS.standard.includes('workStatus'));

  const rawWorks = [
    {
      fileId: '1',
      fileNumber: 'PWD/BLDG/FL/1/2026',
      subject: 'Work A (2 Extensions)',
      components: [
        {
          estmainid: '1',
          hasEBillStage: true,
          componentLabel: 'General Electrical Work[EST/1]',
          mbookStatus: 'Active',
          bills: [],
        },
      ],
      projectDetails: {
        fetchedAt: '2026-11-22T00:00:00Z',
        extractorVersion: 3,
        constituency: 'ARANMULA',
        asNo: 'AS/1',
        asDate: '15-01-2026',
        tsNo: 'TS/1',
        tsDate: '20-01-2026',
        agreementNo: '10/2026',
        agreementDate: '20-02-2026',
        agreedPac: '500000',
        contractor: { name: 'ALPHA BUILDERS', mobile: '9991112223', pan: 'ABCDE1234F' },
        periodYears: 0,
        periodMonths: 6,
        periodDays: 0,
        periodText: '6 Months',
        shoDate: '25-02-2026',
      },
      userData: {
        workStatus: 'In Progress',
        physicalProgress: 65,
        extensions: [
          { order: 1, extendedDate: '30-09-2026', fineAmount: 1000, orderNo: 'EXT/1' },
          { order: 2, extendedDate: '31-12-2026', fineAmount: 2500, orderNo: 'EXT/2' },
        ],
      },
    },
    {
      fileId: '2',
      fileNumber: 'PWD/BLDG/FL/2/2026',
      subject: 'Work B (Multi-Activity + M-Book Closed)',
      components: [
        {
          estmainid: '2',
          hasEBillStage: true,
          componentLabel: 'General Electrical Work[EST/2A]',
          mbookStatus: 'Closed',
          bills: [{ billTypeAndNo: 'Final', status: 'Pending', grandTotal: '200000' }],
          details: { asNo: 'AS/2A', asDate: '10-12-2025', tsNo: 'TS/2A', tsDate: '12-12-2025' },
        },
        {
          estmainid: null,
          hasEBillStage: false,
          hasEmbook: true,
          componentLabel: 'Electrical AC Work[EST/2B]',
          mbookStatus: 'Closed',
          bills: [],
          details: { asNo: 'AS/2B', asDate: '15-12-2025' },
        },
      ],
      projectDetails: {
        fetchedAt: '2026-11-22T00:00:00Z',
        extractorVersion: 3,
        constituency: 'KONNI',
        asNo: 'AS/2',
        asDate: '10-12-2025',
        tsNo: 'TS/2',
        tsDate: '12-12-2025',
        agreedPac: '1200000',
        contractor: { name: 'BETA ELECTRICALS', mobile: '8881112223', pan: 'ZZZZZ9999Z' },
        periodYears: 0,
        periodMonths: 3,
        periodDays: 0,
        periodText: '3 Months',
        shoDate: '10-01-2026',
      },
      userData: {
        workStatus: 'Testing & Commissioning',
        physicalProgress: 0,
        extensions: [{ order: 1, extendedDate: '30-11-2026', fineAmount: 500 }],
      },
    },
  ];

  const rows = rawWorks.map((w, i) => register.buildRegisterRow(w, i, '22-11-2026'));

  // Completion date uses -1 day rule
  assert.equal(rows[0].completionDate, '24-08-2026'); // 25-02-2026 + 6m - 1d
  assert.equal(rows[1].completionDate, '09-04-2026'); // 10-01-2026 + 3m - 1d

  // Extensions, fines, and progress
  assert.equal(rows[0].extendedCompletionDate, '31-12-2026');
  assert.equal(rows[0].extensionOrder, 2);
  assert.equal(rows[0].extensionFine, 3500);
  assert.equal(rows[0].workStatus, 'In Progress');
  assert.equal(rows[0].physicalProgress, 65);
  assert.equal(rows[0].scheduleStatusKey, 'ongoing'); // extended date is 31-12-2026 > 22-11-2026
  assert.equal(rows[0].asNoDateText, 'AS/1 (15-01-2026)');

  // Sorting by extendedCompletionDate ascending -> 30-11-2026 before 31-12-2026
  const sortExt = register.sortRegisterRows(rows, 'extendedCompletionDate', 'asc');
  assert.deepEqual(
    sortExt.map((r) => r.fileNumber),
    ['PWD/BLDG/FL/2/2026', 'PWD/BLDG/FL/1/2026']
  );

  // Sorting by physicalProgress ascending -> 0% sorts BEFORE 65%
  const sortProg = register.sortRegisterRows(rows, 'physicalProgress', 'asc');
  assert.deepEqual(
    sortProg.map((r) => r.physicalProgress),
    [0, 65]
  );

  // Filtering by activity & mbook_closed_no_final
  const acRows = register.filterRegisterRows(rows, { activity: 'Electrical AC Work' });
  assert.deepEqual(
    acRows.map((r) => r.fileNumber),
    ['PWD/BLDG/FL/2/2026']
  );
  const mbookClosedRows = register.filterRegisterRows(rows, {
    billCategory: 'mbook_closed_no_final',
  });
  assert.deepEqual(
    mbookClosedRows.map((r) => r.fileNumber),
    ['PWD/BLDG/FL/2/2026']
  );

  // Report HTML: grouped AS/TS, Contractor PAN/Mobile omitted when not selected,
  // expandable activity rows included WITHOUT double-counting totals!
  const reportHtml = register.buildReportHtml({
    title: 'V2.1 Activity Report',
    rows,
    selectedKeys: [
      'slNo',
      'fileNumber',
      'subject',
      'asNoDate',
      'tsNoDate',
      'agreedPac',
      'contractorName',
      'extendedCompletionDate',
      'workStatus',
      'physicalProgress',
    ],
    filterSummary: 'All Works',
    sortSummary: 'Default',
    includeActivities: true,
    activityFilter: 'all',
  });
  assert.ok(reportHtml.includes('V2.1 Activity Report'));
  assert.ok(reportHtml.includes('AS/1'));
  assert.ok(reportHtml.includes('15-01-2026'));
  assert.ok(reportHtml.includes('↳ Electrical AC Work'));
  assert.ok(!reportHtml.includes('9991112223')); // Phone hidden unless selected
  assert.ok(!reportHtml.includes('ABCDE1234F')); // PAN hidden unless selected
  // Total Agreed PAC = 5,00,000 + 12,00,000 = 17,00,000.00 (child activity rows MUST NOT double count!)
  assert.ok(reportHtml.includes('₹17,00,000.00'));
}

// ---------------------------------------------------------------------------
// 5. v2.2.0: 14166/2026 Partial-Final Non-Composite Fix & DPR Stub Handling
// ---------------------------------------------------------------------------
{
  const completePd = {
    fetchedAt: '2026-11-22T00:00:00Z',
    extractorVersion: 3,
    constituency: 'ARANMULA',
    asNo: 'AS/14166',
    tsNo: 'TS/14166',
    tsAmount: '400000',
    periodYears: 0,
    periodMonths: 1,
    periodDays: 0,
    periodText: '1 Month',
    shoDate: '20-08-2026',
    contractor: { name: 'XAVIER JOSEPH' },
    isUrgentPreAgreement: true,
    hasLoa: false,
  };

  // Real 14166/2026 after Act 1 Final Bill is terminally submitted to EMILI while Act 2 has active M-Book
  const w14166EmiliAct1 = {
    fileId: '2661614167',
    fileNumber: 'PWD/BLDG/FL/14166/2026',
    subject: 'VVIP Visit - Rest House Aranmula',
    components: [
      {
        estmainid: '2615630',
        hasEBillStage: true,
        hasEmbook: true,
        hasPostTender: true,
        componentLabel: 'General Electrical Work[PWD/BLDG/EST/14166/2026_6_1_1]',
        mbookStatus: 'Closed',
        bills: [
          {
            billTypeAndNo: 'PWD/BLDG/EB/14166/2026_6_1_1_Final',
            status: 'Submitted to EMILI',
            grandTotal: '314452',
          },
        ],
        details: { ...completePd, tsAmount: '350000', negotiatedRate: '(-)0' },
      },
      {
        estmainid: null,
        hasEBillStage: false,
        hasEmbook: true,
        hasPostTender: true,
        mbookActivityId: '2615592',
        componentLabel: 'Electrical AC Work[PWD/BLDG/EST/14166/2026_13_1_1]',
        mbookStatus: 'Active',
        bills: [],
        details: { ...completePd, tsAmount: '250000', shoDate: '01-11-2026', periodMonths: 1, periodText: '1 Month' },
      },
    ],
    projectDetails: completePd,
  };

  const sum14166 = extractor.analyzeWorkRecord(w14166EmiliAct1);
  assert.equal(sum14166.trackableCompCount, 2);
  assert.equal(sum14166.finalizedTrackableCompCount, 1);
  assert.equal(sum14166.isFullyFinalized, false);
  assert.equal(sum14166.hasPartialFinal, true);
  assert.equal(sum14166.hasFinal, false);
  assert.equal(sum14166.categoryKey, 'partial_final');
  assert.equal(sum14166.label, 'Partial Final (1/2)');
  // MUST NOT auto-archive while Electrical AC Work is unfinalized!
  assert.equal(db.isWorkArchivable(w14166EmiliAct1, sum14166), false);

  // Activity-wise scope routing: Active shows ONLY Electrical AC Work; Finalized/EMILI shows General Electrical Work
  const activeActRows = register.buildActivityRegisterRows([w14166EmiliAct1], 'active', '22-11-2026');
  assert.equal(activeActRows.length, 1);
  assert.equal(activeActRows[0].activityName, 'Electrical AC Work');
  assert.equal(activeActRows[0].isMbookOpen, true);

  const archActRows = register.buildActivityRegisterRows([w14166EmiliAct1], 'archived', '22-11-2026');
  assert.equal(archActRows.length, 1);
  assert.equal(archActRows[0].activityName, 'General Electrical Work');

  // DPR-only superseded stub (e.g., 11051/2024 _6_1_1) does NOT block auto-archival of finalized execution activity
  const w11051 = {
    fileId: '11051',
    fileNumber: 'PWD/BLDG/FL/11051/2024',
    components: [
      {
        estmainid: '9001',
        hasEBillStage: true,
        hasEmbook: true,
        componentLabel: 'General Electrical Work[PWD/BLDG/EST/11051/2024_6_2_1]',
        mbookStatus: 'Closed',
        bills: [{ billTypeAndNo: '1-Final', status: 'Submitted to EMILI', grandTotal: '120000' }],
      },
      {
        estmainid: null,
        hasEBillStage: false,
        hasEmbook: false,
        hasPostTender: false,
        hasPreTender: false,
        componentLabel: 'General Electrical Work[PWD/BLDG/EST/11051/2024_6_1_1]',
        stageName: 'DPR',
        bills: [],
      },
    ],
    projectDetails: { ...completePd, hasLoa: true, agreementNo: '50/2024' },
  };
  const sum11051 = extractor.analyzeWorkRecord(w11051);
  assert.equal(sum11051.trackableCompCount, 1);
  assert.equal(sum11051.isFullyFinalized, true);
  assert.equal(db.isWorkArchivable(w11051, sum11051), true);
}

// ---------------------------------------------------------------------------
// 6. v2.2.0: Activity-Wise Composite Rules & Per-Report Exclusions
// ---------------------------------------------------------------------------
{
  const pdBase = {
    fetchedAt: '2026-11-22T00:00:00Z',
    extractorVersion: 3,
    constituency: 'KONNI',
    asNo: 'AS/COMP',
    tsNo: 'TS/COMP',
    tsAmount: '2000000',
    agreedPac: '2000000',
    negotiatedRate: '(+)0',
    shoDate: '01-06-2026',
    periodMonths: 12,
    periodText: '1 Year',
    contractor: { name: 'COMP BUILDERS' },
  };

  // A. Composite work WITHOUT Final Bill: shows Civil & Electrical components, omits empty Composite Final shell, deduplicates Agreed PAC
  const wCompOngoing = {
    fileId: '1846',
    fileNumber: 'PWD/BLDG/FL/1846/2023',
    subject: 'District Jail Phase 2',
    components: [
      {
        estmainid: '101',
        hasEBillStage: true,
        hasEmbook: true,
        workGroup: 'Phase 2',
        componentLabel: 'Composite Civil Work[EST/1846_9_1_1]',
        mbookStatus: 'Active',
        bills: [{ billTypeAndNo: 'Part-1', status: 'Submitted to EMILI', grandTotal: '500000' }],
        details: pdBase,
      },
      {
        estmainid: '102',
        hasEBillStage: true,
        hasEmbook: true,
        workGroup: 'Phase 2',
        componentLabel: 'Composite Electrical Work[EST/1846_17_1_1]',
        mbookStatus: 'Active',
        bills: [],
        details: pdBase,
      },
      {
        estmainid: '103',
        hasEBillStage: true,
        workGroup: 'Phase 2',
        componentLabel: 'Composite Final Component[EST/1846_23_2_1]',
        bills: [],
        details: pdBase,
      },
    ],
    projectDetails: pdBase,
  };
  const compOngoingActRows = register.buildActivityRegisterRows([wCompOngoing], 'active', '22-11-2026');
  assert.deepEqual(
    compOngoingActRows.map((r) => r.activityName),
    ['Composite Civil Work', 'Composite Electrical Work']
  );

  const compReportHtml = register.buildReportHtml({
    title: 'Activity Composite Ongoing',
    rows: compOngoingActRows,
    selectedKeys: ['slNo', 'fileNumber', 'subject', 'activityName', 'agreedPac', 'totalActiveAmount'],
    viewMode: 'activity',
  });
  // Agreed PAC 20,00,000 MUST NOT double-count to 40,00,000 across Civil + Electrical!
  assert.ok(compReportHtml.includes('₹20,00,000.00'));
  assert.ok(!compReportHtml.includes('₹40,00,000.00'));

  // B. Composite work WITH Composite Final Bill (13252/2022 pattern):
  // Sibling Final bills (Passed/Pending) MUST merge into Composite Final Component,
  // Activity-wise MUST show ONLY Composite Final Component with cumulative Part + Final total!
  const wCompFinalized = {
    fileId: '13252',
    fileNumber: 'PWD/BLDG/FL/13252/2022',
    subject: 'FHC Chittar',
    components: [
      {
        estmainid: '201',
        hasEBillStage: true,
        workGroup: 'FHC',
        componentLabel: 'Composite Civil Work[EST/13252_9_1_1]',
        bills: [
          { billTypeAndNo: '1-CIVIL-Part-1', status: 'Submitted for Payment (Non EMLI)', grandTotal: '400000' },
          { billTypeAndNo: 'Final', status: 'Passed', grandTotal: '600000' },
        ],
        details: pdBase,
      },
      {
        estmainid: '202',
        hasEBillStage: true,
        workGroup: 'FHC',
        componentLabel: 'Composite Electrical Work[EST/13252_17_1_1]',
        bills: [{ billTypeAndNo: 'Final', status: 'Pending', grandTotal: '200000' }],
        details: pdBase,
      },
      {
        estmainid: '203',
        hasEBillStage: true,
        workGroup: 'FHC',
        componentLabel: 'Composite Final Component[EST/13252_23_2_1]',
        bills: [{ billTypeAndNo: 'Final', status: 'Submitted for Payment (Non EMLI)', grandTotal: '800000' }],
        details: pdBase,
      },
    ],
    projectDetails: pdBase,
  };
  const sum13252 = extractor.analyzeWorkRecord(wCompFinalized);
  assert.equal(sum13252.isFullyFinalized, true);
  assert.equal(sum13252.totalActiveAmount, 1200000); // Part-1 (4L) + Composite Final (8L); sibling Passed/Pending Finals merged!
  assert.equal(db.isWorkArchivable(wCompFinalized, sum13252), true);

  const compFinalActRows = register.buildActivityRegisterRows([wCompFinalized], 'archived', '22-11-2026');
  assert.equal(compFinalActRows.length, 1);
  assert.equal(compFinalActRows[0].activityName, 'Composite Final Component');
  assert.equal(compFinalActRows[0].totalActiveAmount, 1200000);

  // C. Per-Report Exclusions: excluded activity is omitted, Sl No renumbered 1..N, totals adjusted
  const exclKey = compOngoingActRows[0].rowKey; // exclude Composite Civil Work (billed 5,00,000)
  const exclCsv = register.generateCsvFromColumns(
    compOngoingActRows,
    ['slNo', 'fileNumber', 'activityName', 'totalActiveAmount'],
    { viewMode: 'activity', excludedKeys: [exclKey] }
  );
  assert.ok(!exclCsv.includes('Composite Civil Work'));
  assert.ok(exclCsv.includes('1,PWD/BLDG/FL/1846/2023,Composite Electrical Work'));

  const exclPdf = register.buildReportHtml({
    title: 'Excluded Check',
    rows: compOngoingActRows,
    selectedKeys: ['slNo', 'fileNumber', 'activityName', 'totalActiveAmount'],
    viewMode: 'activity',
    excludedKeys: [exclKey],
  });
  assert.ok(!exclPdf.includes('Composite Civil Work'));
  assert.ok(exclPdf.includes('1 excluded'));
  assert.ok(!exclPdf.includes('₹5,00,000.00'));
}

// ---------------------------------------------------------------------------
// 7. v2.2.0: Manual Archiving (Work & Activity), Draft Bills & Financial Status
// ---------------------------------------------------------------------------
{
  const pdDraft = {
    fetchedAt: '2026-11-22T00:00:00Z',
    extractorVersion: 3,
    constituency: 'ADOOR',
    asNo: 'AS/93',
    tsNo: 'TS/93',
    tsAmount: '1000000',
    negotiatedRate: '(-)10',
    agreedPac: '900000',
    shoDate: '01-08-2026',
    periodMonths: 6,
    periodText: '6 Months',
    contractor: { name: 'DELTA POWER' },
  };

  // Draft Bill exclusion (93188/2021 pattern + Draft Final test)
  const wDraft = {
    fileId: '93188',
    fileNumber: 'PWD/BLDG/FL/93188/2021',
    subject: 'Draft Bill Exclusion Test',
    components: [
      {
        estmainid: '901',
        hasEBillStage: true,
        hasEmbook: true,
        componentLabel: 'General Electrical Work[EST/93188_6_1_1]',
        mbookStatus: 'Active',
        bills: [
          { billTypeAndNo: 'Part-1', status: 'Submitted to EMILI', grandTotal: '450000' },
          { billTypeAndNo: 'Final', status: 'Draft', grandTotal: '450000' },
        ],
      },
    ],
    projectDetails: pdDraft,
  };
  const sumDraft = extractor.analyzeWorkRecord(wDraft);
  assert.equal(sumDraft.totalActiveAmount, 450000); // Draft excluded!
  assert.equal(sumDraft.isFullyFinalized, false); // Draft Final DOES NOT finalize work!
  assert.equal(sumDraft.hasFinal, false);
  assert.equal(sumDraft.draftCount, 1);

  // Negotiated Rate parsing & Adjusted TS Financial Status (%)
  assert.equal(extractor.parseNegotiatedRatePct('(+)0'), 0);
  assert.equal(extractor.parseNegotiatedRatePct('(+)5.25'), 5.25);
  assert.equal(extractor.parseNegotiatedRatePct('(-)10.5'), -10.5);
  assert.equal(extractor.parseNegotiatedRatePct('8.5% below'), -8.5);
  assert.equal(extractor.parseNegotiatedRatePct('3% above'), 3);
  assert.equal(extractor.parseNegotiatedRatePct('at par'), 0);

  const fin = extractor.computeFinancialStatus(450000, {
    tsAmount: '1000000',
    negotiatedRate: '(-)10',
  });
  assert.equal(fin.adjustedTsAmount, 900000);
  assert.equal(fin.pct, 50);

  const draftRow = register.buildRegisterRow(wDraft, 0, '22-11-2026');
  assert.equal(draftRow.adjustedTsAmount, 900000);
  assert.equal(draftRow.financialPct, 50);

  // Manual Archive (Activity-level & Work-level preservation across merge)
  const wManual = {
    fileId: '555',
    fileNumber: 'PWD/BLDG/FL/555/2026',
    subject: 'Cancelled Activity Work',
    components: [
      {
        estmainid: '5551',
        hasEBillStage: true,
        componentLabel: 'General Electrical Work[EST/555_6_1_1]',
        bills: [{ billTypeAndNo: 'Final', status: 'Submitted to EMILI', grandTotal: '100000' }],
      },
      {
        estmainid: null,
        hasEBillStage: false,
        hasEmbook: true,
        componentLabel: 'Electrical AC Work[EST/555_13_1_1]',
        mbookStatus: 'Active',
        bills: [],
      },
    ],
    projectDetails: pdDraft,
    userData: {
      activityOverrides: {
        'EST/555_13_1_1': {
          manualArchive: { archived: true, reason: 'Abandoned by client', archivedAt: '2026-11-20T10:00:00Z' },
        },
      },
    },
  };
  const sumManual = extractor.analyzeWorkRecord(wManual);
  assert.equal(sumManual.hasAnyManualArchive, true);
  assert.equal(sumManual.isFullyManuallyArchived, false);
  assert.equal(sumManual.isFullyFinalized, true); // Only non-archived activity is finalized
  assert.equal(db.isWorkArchivable(wManual, sumManual), true);

  const manArchActRows = register.buildActivityRegisterRows([wManual], 'manually_archived', '22-11-2026');
  assert.equal(manArchActRows.length, 1);
  assert.equal(manArchActRows[0].activityName, 'Electrical AC Work');
  assert.equal(manArchActRows[0].manualArchiveReason, 'Abandoned by client');

  const mergedManual = db.mergeImportedRecord(wManual, { ...wManual, userData: undefined });
  assert.equal(mergedManual.userData.activityOverrides['EST/555_13_1_1'].manualArchive.reason, 'Abandoned by client');
}

// ---------------------------------------------------------------------------
// 8. v2.2.0: 0-150% Period Progress Bar, Open M-Book >= 75% & Milestone History
// ---------------------------------------------------------------------------
{
  // Period: 01-01-2026 + 100d - 1d => 10-04-2026 (span 99 days; let's use 01-01-2026 to 11-04-2026 = 100 days exact)
  const pGreen = extractor.computePeriodProgress({
    shoDate: '01-01-2026',
    completionDate: '11-04-2026',
    isFinalized: false,
    isManuallyArchived: false,
    isMbookClosed: false,
    referenceTodayDmy: '10-02-2026', // 40 days / 100 = 40%
  });
  assert.equal(pGreen.pct, 40);
  assert.equal(pGreen.remainingPct, 60);
  assert.equal(pGreen.zone, 'green');
  assert.equal(pGreen.reached75, false);

  const pYellow = extractor.computePeriodProgress({
    shoDate: '01-01-2026',
    completionDate: '11-04-2026',
    referenceTodayDmy: '02-03-2026', // 60 days = 60%
  });
  assert.equal(pYellow.pct, 60);
  assert.equal(pYellow.zone, 'yellow');
  assert.equal(pYellow.reached75, false);

  const pOrange = extractor.computePeriodProgress({
    shoDate: '01-01-2026',
    completionDate: '11-04-2026',
    referenceTodayDmy: '27-03-2026', // 85 days = 85%
  });
  assert.equal(pOrange.pct, 85);
  assert.equal(pOrange.zone, 'orange');
  assert.equal(pOrange.reached75, true);

  const pRed125 = extractor.computePeriodProgress({
    shoDate: '01-01-2026',
    completionDate: '11-04-2026',
    referenceTodayDmy: '06-05-2026', // 125 days = 125%
  });
  assert.equal(pRed125.pct, 125);
  assert.equal(pRed125.excessPct, 25);
  assert.equal(pRed125.zone, 'red');
  assert.equal(pRed125.barFillPct, 83.3);

  const pRed180 = extractor.computePeriodProgress({
    shoDate: '01-01-2026',
    completionDate: '11-04-2026',
    referenceTodayDmy: '30-06-2026', // 180 days = 180%, capped at 150% full bar
  });
  assert.equal(pRed180.pct, 180);
  assert.equal(pRed180.barFillPct, 100);

  // Suppressed on finalized, manually archived, or M-Book closed components
  assert.equal(
    extractor.computePeriodProgress({
      shoDate: '01-01-2026',
      completionDate: '11-04-2026',
      isFinalized: true,
      referenceTodayDmy: '27-03-2026',
    }),
    null
  );
  assert.equal(
    extractor.computePeriodProgress({
      shoDate: '01-01-2026',
      completionDate: '11-04-2026',
      isMbookClosed: true,
      referenceTodayDmy: '27-03-2026',
    }),
    null
  );

  // Filter: Open M-Book >= 75% Period
  const mkMbookWork = (fid, mbookStatus, shoDate, periodMonths) => ({
    fileId: fid,
    fileNumber: `PWD/BLDG/FL/${fid}/2026`,
    subject: `Work ${fid}`,
    components: [
      {
        estmainid: null,
        hasEBillStage: false,
        hasEmbook: true,
        mbookActivityId: `mb_${fid}`,
        componentLabel: `General Electrical Work[EST/${fid}]`,
        mbookStatus,
        bills: [],
      },
    ],
    projectDetails: {
      fetchedAt: '2026-11-22T00:00:00Z',
      extractorVersion: 3,
      constituency: 'KONNI',
      asNo: `AS/${fid}`,
      tsNo: `TS/${fid}`,
      tsAmount: '500000',
      shoDate,
      periodMonths,
      periodText: `${periodMonths} Months`,
      contractor: { name: 'TEST' },
    },
  });

  // On 22-11-2026: 01-08-2026 + 4m - 1d = 30-11-2026 -> 113 / 121 = 93.4% (>= 75%!)
  const wOpenOver75 = mkMbookWork('701', 'Active', '01-08-2026', 4);
  const wClosedOver75 = mkMbookWork('702', 'Closed', '01-08-2026', 4);
  // On 22-11-2026: 01-10-2026 + 6m - 1d = 31-03-2027 -> 52 / 181 = 28.7% (< 75%!)
  const wOpenUnder75 = mkMbookWork('703', 'Active', '01-10-2026', 6);

  const actList = register.buildActivityRegisterRows(
    [wOpenOver75, wClosedOver75, wOpenUnder75],
    'active',
    '22-11-2026'
  );
  const m75 = register.filterRegisterRows(actList, { openMbook75: true });
  assert.deepEqual(
    m75.map((r) => r.fileNumber),
    ['PWD/BLDG/FL/701/2026']
  );

  // Report HTML renders plain completion date WITHOUT progress bar badge in Report Generator
  const m75Html = register.buildReportHtml({
    title: 'Due Progress Report',
    rows: m75,
    selectedKeys: ['slNo', 'workDetails', 'agreementNoDate', 'completionDate', 'scheduleStatus', 'physicalProgress'],
    viewMode: 'activity',
  });
  assert.equal(m75Html.includes('p3h-due-bar-badge'), false);
  assert.ok(m75Html.includes('30-11-2026'));
  assert.ok(m75Html.includes('Due in 8d'));
  assert.ok(m75Html.includes('File No, Work Name &amp; Activity'));
  assert.ok(m75Html.includes('Agreement No. &amp; Date'));

  // Timestamped Milestone Chronology
  let hist = [];
  hist = db.appendProgressHistoryEntry(hist, {
    workStatus: 'Site Handed Over',
    physicalProgress: 10,
    remarks: 'Initial layout',
    timestamp: '2026-09-01T09:30:00.000Z',
  });
  hist = db.appendProgressHistoryEntry(hist, {
    workStatus: 'Wiring Completed',
    physicalProgress: 65,
    remarks: 'Main DB installed',
    timestamp: '2026-10-15T14:15:00.000Z',
  });
  assert.equal(hist.length, 2);
  assert.ok(hist[0].timestamp < hist[1].timestamp);
  const summaryStr = db.formatProgressTimelineSummary(hist);
  assert.ok(summaryStr.includes('Site Handed Over'));
  assert.ok(summaryStr.includes('65%'));
  const timelineHtml = register.renderMilestoneTimelineHtml(hist, { allowDelete: true });
  assert.ok(timelineHtml.includes('p3h-milestone-timeline'));
  assert.ok(timelineHtml.includes('+55%'));
  assert.ok(timelineHtml.includes('Main DB installed'));

  const mergedHist = db.mergeProgressHistories(hist, [
    {
      id: 'extra_1',
      timestamp: '2026-11-01T11:00:00.000Z',
      workStatus: 'Testing & Commissioning',
      physicalProgress: 90,
      remarks: 'Megger test OK',
    },
  ]);
  assert.equal(mergedHist.length, 3);
}

// ---------------------------------------------------------------------------
// 9. v2.3.0: Deactivated DPR Hiding, Composite Due Dedup, Multi-Select Filters & Custom Order
// ---------------------------------------------------------------------------
{
  const pdBase = {
    fetchedAt: '2026-11-22T00:00:00Z',
    extractorVersion: 3,
    constituency: 'PATHANAMTHITTA',
    asNo: 'AS/97721',
    asDate: '10-08-2021',
    tsNo: 'TS/97721',
    tsDate: '20-08-2021',
    agreementNo: '45/2021-22',
    agreementDate: '01-09-2021',
    agreedPac: '1500000',
    shoDate: '10-09-2021',
    periodMonths: 6,
    periodText: '6 Months',
    contractor: { name: 'ABC ELECTRIFICATION', email: 'secret@example.com' },
  };

  // A. PWD/BLDG/FL/97721/2021: deactivated DPR (_14_1_1) must be excluded alongside active execution components
  const w97721 = {
    fileId: '210841397722',
    fileNumber: 'PWD/BLDG/FL/97721/2021',
    subject: 'RIDF XXIV - GHSS Kadamanitta',
    components: [
      {
        estmainid: '21384489',
        hasEBillStage: true,
        hasPostTender: true,
        componentLabel: 'General Electrical Work-2[PWD/BLDG/EST/97721/2021_6_2_2]',
        bills: [{ billTypeAndNo: 'Final', status: 'Submitted for Payment (Non EMLI)', grandTotal: '62390' }],
        details: pdBase,
      },
      {
        estmainid: '211597730',
        hasEBillStage: true,
        hasPostTender: true,
        componentLabel: 'General Electrical Work[PWD/BLDG/EST/97721/2021_6_1]',
        bills: [{ billTypeAndNo: 'Final', status: 'Submitted for Payment (Non EMLI)', grandTotal: '1063195' }],
        details: pdBase,
      },
      {
        estmainid: '21999999',
        hasEBillStage: true,
        hasPostTender: true,
        componentLabel: 'Electrical Fire Fighting Work-1[PWD/BLDG/EST/97721/2021_14_2_2]',
        bills: [],
        mbookStatus: 'Active',
        details: { ...pdBase, constituency: 'KONNI', contractor: { name: 'FIRE SYSTEMS' } },
      },
      {
        estmainid: null,
        hasEBillStage: false,
        hasEmbook: false,
        hasSiteHandover: false,
        hasPostTender: false,
        hasPreTender: false,
        stageName: 'DPR',
        componentLabel: 'Electrical Fire Fighting Work[PWD/BLDG/EST/97721/2021_14_1_1]',
        bills: [],
      },
    ],
    projectDetails: pdBase,
  };
  const sum97721 = extractor.analyzeWorkRecord(w97721);
  assert.equal(sum97721.isCompositeWork, false);
  assert.equal(sum97721.activities.length, 3);
  assert.equal(
    sum97721.activities.some((a) => a.estimateCode === 'PWD/BLDG/EST/97721/2021_14_1_1'),
    false
  );
  assert.equal(
    sum97721.components.find((c) => c.estimateCode === 'PWD/BLDG/EST/97721/2021_14_1_1').isDeactivatedDpr,
    true
  );
  assert.deepEqual(sum97721.activityNames, [
    'General Electrical Work-2',
    'General Electrical Work',
    'Electrical Fire Fighting Work-1',
  ]);
  const act97721All = register.buildActivityRegisterRows([w97721], 'all', '22-11-2026');
  assert.equal(act97721All.length, 3);
  assert.equal(
    act97721All.some((r) => r.estimateCode === 'PWD/BLDG/EST/97721/2021_14_1_1'),
    false
  );

  // Legitimate DPR-only work retains its DPR component when no execution components exist
  const wPureDpr = {
    fileId: '999001',
    fileNumber: 'PWD/BLDG/FL/999/2026',
    subject: 'New DPR Work Only',
    components: [
      {
        estmainid: null,
        hasEBillStage: false,
        hasEmbook: false,
        stageName: 'DPR',
        componentLabel: 'General Electrical Work[PWD/BLDG/EST/999/2026_6_1_1]',
        bills: [],
      },
    ],
    projectDetails: { fetchedAt: '2026-11-22T00:00:00Z', extractorVersion: 3, constituency: 'ADOOR' },
  };
  const sumPureDpr = extractor.analyzeWorkRecord(wPureDpr);
  assert.equal(sumPureDpr.categoryKey, 'dpr');
  assert.equal(sumPureDpr.activities.length, 1);

  // B. PWD/BLDG/FL/94274/2021: composite work flag + deduplicated activeDueItems + deactivated DPR omitted
  const w94274 = {
    fileId: '210640994275',
    fileNumber: 'PWD/BLDG/FL/94274/2021',
    subject: 'GOVERNMENT L P SCHOOL VALLICODE',
    components: [
      {
        estmainid: '22218984',
        hasEBillStage: true,
        hasEmbook: true,
        workGroup: 'LPS Vallicode',
        componentLabel: 'Composite Civil Work[PWD/BLDG/EST/94274/2021_9_1_1]',
        mbookStatus: 'Active',
        bills: [{ billTypeAndNo: 'Part-1', status: 'Submitted to EMILI', grandTotal: '1506592' }],
        details: { ...pdBase, shoDate: '01-08-2026', periodMonths: 12, periodText: '1 Year' },
      },
      {
        estmainid: '22218985',
        hasEBillStage: true,
        hasEmbook: true,
        workGroup: 'LPS Vallicode',
        componentLabel: 'Composite Electrical Work[PWD/BLDG/EST/94274/2021_17_1_1]',
        mbookStatus: 'Active',
        bills: [],
        details: { ...pdBase, shoDate: '01-08-2026', periodMonths: 12, periodText: '1 Year' },
      },
      {
        estmainid: '22218986',
        hasEBillStage: true,
        workGroup: 'LPS Vallicode',
        componentLabel: 'Composite Final Component[PWD/BLDG/EST/94274/2021_23_2_1]',
        mbookStatus: 'Active',
        bills: [],
        details: { ...pdBase, shoDate: '01-08-2026', periodMonths: 12, periodText: '1 Year' },
      },
      {
        estmainid: null,
        hasEBillStage: false,
        stageName: 'DPR',
        workGroup: 'LPS Vallicode',
        componentLabel: 'General Civil Work-1[PWD/BLDG/EST/94274/2021_5_1]',
        bills: [],
      },
      {
        estmainid: null,
        hasEBillStage: false,
        stageName: 'DPR',
        workGroup: 'LPS Vallicode',
        componentLabel: 'Composite Primary Component[PWD/BLDG/EST/94274/2021_23_1_1]',
        bills: [],
      },
    ],
    projectDetails: { ...pdBase, shoDate: '01-08-2026', periodMonths: 12, periodText: '1 Year' },
  };
  const sum94274 = extractor.analyzeWorkRecord(w94274);
  assert.equal(sum94274.isCompositeWork, true);
  assert.equal(sum94274.activities.length, 3);
  assert.equal(
    sum94274.activities.some((a) => a.activityName === 'General Civil Work-1'),
    false
  );
  const row94274 = register.buildRegisterRow(w94274, 0, '22-11-2026');
  assert.equal(row94274.activeDueItems.length, 1);

  // C. Multi-activity non-composite 14166/2026 has isCompositeWork === false
  const w14166NonComp = {
    fileId: '2661614167',
    fileNumber: 'PWD/BLDG/FL/14166/2026',
    subject: 'VVIP Visit - Rest House Aranmula',
    components: [
      {
        estmainid: '2615630',
        hasEBillStage: true,
        hasEmbook: true,
        componentLabel: 'General Electrical Work[PWD/BLDG/EST/14166/2026_6_1_1]',
        bills: [{ billTypeAndNo: 'Final', status: 'Pending', grandTotal: '314452' }],
        details: pdBase,
      },
      {
        estmainid: null,
        hasEBillStage: false,
        hasEmbook: true,
        componentLabel: 'Electrical AC Work[PWD/BLDG/EST/14166/2026_13_1_1]',
        mbookStatus: 'Closed',
        bills: [],
        details: pdBase,
      },
    ],
    projectDetails: pdBase,
  };
  assert.equal(extractor.analyzeWorkRecord(w14166NonComp).isCompositeWork, false);

  // D. Multi-select filters (Activity, Constituency, Bill Category, Schedule Status)
  const multiRows = register.buildActivityRegisterRows([w97721, wPureDpr], 'all', '22-11-2026');
  const filteredTwoActs = register.filterRegisterRows(multiRows, {
    activity: ['General Electrical Work-2', 'Electrical Fire Fighting Work-1'],
  });
  assert.deepEqual(
    filteredTwoActs.map((r) => r.activityName),
    ['General Electrical Work-2', 'Electrical Fire Fighting Work-1']
  );

  const filteredTwoLacs = register.filterRegisterRows(multiRows, {
    constituency: ['KONNI', 'ADOOR'],
  });
  assert.deepEqual(
    filteredTwoLacs.map((r) => r.constituency),
    ['KONNI', 'ADOOR']
  );

  const filteredTwoCats = register.filterRegisterRows(multiRows, {
    billCategory: ['final', 'dpr'],
  });
  assert.equal(filteredTwoCats.length, 3);

  const filteredTwoScheds = register.filterRegisterRows(multiRows, {
    scheduleStatus: ['overdue', 'no_date'],
  });
  assert.deepEqual(
    filteredTwoScheds.map((r) => r.activityName),
    ['Electrical Fire Fighting Work-1', 'General Electrical Work']
  );

  // E. Combined columns, hidden Contractor Email, and Custom Column Order in CSV & Report HTML
  const customCols = ['contractorName', 'agreementNoDate', 'workDetails', 'slNo'];
  assert.deepEqual(
    register.getEffectiveColumnsForView(customCols, 'activity', 'active'),
    customCols
  );
  const customCsv = register.generateCsvFromColumns(filteredTwoActs, customCols, {
    viewMode: 'activity',
  });
  const csvLines = customCsv.split('\r\n');
  assert.equal(
    csvLines[0],
    'Contractor Name,Agreement No. & Date,"File No, Work Name & Activity",Sl No'
  );
  assert.ok(csvLines[1].startsWith('ABC ELECTRIFICATION,45/2021-22 (01-09-2021)'));
  assert.ok(!customCsv.includes('secret@example.com'));

  const customReportHtml = register.buildReportHtml({
    title: 'Custom Order Test',
    rows: filteredTwoActs,
    selectedKeys: customCols,
    viewMode: 'activity',
  });
  const idxCtr = customReportHtml.indexOf('<th>Contractor Name</th>');
  const idxAgmt = customReportHtml.indexOf('<th>Agreement No. &amp; Date</th>');
  const idxWork = customReportHtml.indexOf('<th>File No, Work Name &amp; Activity</th>');
  const idxSl = customReportHtml.indexOf('Sl No</th>');
  assert.ok(idxCtr > 0 && idxCtr < idxAgmt && idxAgmt < idxWork && idxWork < idxSl);
  assert.ok(customReportHtml.includes('45/2021-22'));
  assert.ok(customReportHtml.includes('01-09-2021'));
  assert.ok(!customReportHtml.includes('secret@example.com'));
}

// ---------------------------------------------------------------------------
// 10. v2.4.0 Audit Regressions, DPR Deactivation & MV3 Isolation Contracts
// ---------------------------------------------------------------------------
{
  const fs = require('node:fs');
  const path = require('node:path');
  const { fileURLToPath } = require('node:url');

  // A. Object.freeze API immutability
  assert.equal(Object.isFrozen(db), true);
  assert.equal(Object.isFrozen(extractor), true);
  assert.equal(Object.isFrozen(register), true);
  assert.equal(Object.isFrozen(overlay), true);

  // B. XSS HTML escaping (including single-quote) & CSV formula injection protection
  assert.equal(db.escapeHtml(`<script>"'&`), '&lt;script&gt;&quot;&#39;&amp;');
  assert.equal(db.csvEscape('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.equal(db.csvEscape('+1234'), "'+1234");
  assert.equal(db.csvEscape('-cmd'), "'-cmd");
  assert.equal(db.csvEscape('@cmd'), "'@cmd");
  assert.equal(db.csvEscape('\t=bad'), "'\t=bad");
  assert.equal(db.csvEscape(-500), '-500');
  assert.equal(db.csvEscape('a,b'), '"a,b"');

  // C. Prototype-pollution & schema-bounds defense in db.sanitizeWorkRecord
  const maliciousPayload = JSON.parse(
    '{"fileId":"777123","fileNumber":"PWD/BLDG/FL/777/2026","subject":"Test Work","__proto__":{"polluted":true},"components":[{"componentLabel":"Act 1[EST/1]","__proto__":{"polluted":true},"bills":[{"billTypeAndNo":"Part-1","__proto__":{"polluted":true}}],"details":{"asNo":"AS/1","contractor":{"name":"CTR","__proto__":{"polluted":true}}}}],"projectDetails":{"__proto__":{"polluted":true},"constituency":"KONNI"},"userData":{"workStatus":"OK","activityOverrides":{"__proto__":{"workStatus":"EVIL"}}}}'
  );
  const sanitized = db.sanitizeWorkRecord(maliciousPayload, '2026-11-22T00:00:00Z');
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(sanitized, '__proto__'), false);
  assert.equal(Object.hasOwn(sanitized.components[0], '__proto__'), false);
  assert.equal(Object.hasOwn(sanitized.components[0].bills[0], '__proto__'), false);
  assert.equal(Object.hasOwn(sanitized.components[0].details.contractor, '__proto__'), false);
  assert.equal(Object.hasOwn(sanitized.userData.activityOverrides, '__proto__'), false);
  assert.equal(Number.isNaN(db.parseSafeNumber('not-a-number')), true);
  assert.equal(db.parseSafeNumber('12,345.50'), 12345.5);

  // D. C-01 Root Cause: PWD/BLDG/EST/11051/2024_6_1_1 deactivated DPR in mixed side menu & ancestral deactivation
  const deactivatedMenuHtml = `
    <ul id="pt-side-menu-full">
      <li>
        <span>Main Building</span>
        <ul>
          <li>
            <span>General Civil Work[PWD/BLDG/EST/11051/2024_5_1_1]</span>
            <ul>
              <li><a onclick="call_basicestimation('tok','11051001')">DPR</a></li>
              <li><a onclick="callposttender('tok','11051001')">post-Tender1</a>
                <ul>
                  <li><a onclick="callebill('11051009')">e-Bills</a></li>
                </ul>
              </li>
            </ul>
          </li>
          <li title="Deactivated">
            <del><span>General Electrical Work[PWD/BLDG/EST/11051/2024_6_1_1]</span></del>
            <ul>
              <li><a onclick="call_basicestimation('tok','11051002')">DPR</a></li>
            </ul>
          </li>
        </ul>
      </li>
    </ul>
  `;
  const deactStruct = extractor.parseSideMenuStructure(parseMiniHtml(deactivatedMenuHtml));
  assert.equal(deactStruct.components.length, 2);
  const actComp = deactStruct.components.find((c) => c.estimateCode.endsWith('_5_1_1'));
  const deactDpr = deactStruct.components.find((c) => c.estimateCode.endsWith('_6_1_1'));
  assert.equal(actComp.isDeactivated, false);
  assert.equal(deactDpr.isDeactivated, true);
  assert.equal(deactDpr.stageName, 'DPR');

  const mixedWork11051 = {
    fileId: '11051',
    fileNumber: 'PWD/BLDG/FL/11051/2024',
    subject: 'Mixed Deactivated DPR + Final Work',
    components: [
      {
        ...actComp,
        mbookStatus: 'Closed',
        bills: [{ billTypeAndNo: 'Final', status: 'Submitted to EMILI', grandTotal: '500000' }],
        details: {
          constituency: 'KONNI',
          asNo: 'AS/11051',
          tsNo: 'TS/11051',
          shoDate: '01-01-2025',
          periodMonths: 6,
          contractor: { name: 'ABC' },
        },
      },
      {
        ...deactDpr,
        bills: [],
      },
    ],
    projectDetails: {
      fetchedAt: '2026-11-22T00:00:00Z',
      extractorVersion: 3,
      constituency: 'KONNI',
      asNo: 'AS/11051',
      tsNo: 'TS/11051',
      periodText: '6 Months',
      shoDate: '01-01-2025',
      periodMonths: 6,
      contractor: { name: 'ABC' },
    },
  };
  const sum11051 = extractor.analyzeWorkRecord(mixedWork11051);
  assert.equal(sum11051.categoryKey, 'final');
  assert.equal(sum11051.isFullyFinalized, true);
  assert.equal(sum11051.activities.length, 1);
  assert.equal(
    sum11051.components.find((c) => c.estimateCode.endsWith('_6_1_1')).isDeactivatedDpr,
    true
  );
  assert.equal(db.isWorkArchivable(mixedWork11051, sum11051), true);

  // Work where ALL non-helper components are deactivated -> categoryKey: 'deactivated'
  const pureDeactWork = {
    fileId: '11052',
    fileNumber: 'PWD/BLDG/FL/11052/2024',
    components: [{ ...deactDpr, bills: [] }],
    projectDetails: { fetchedAt: '2026-11-22T00:00:00Z', extractorVersion: 3 },
  };
  const sumPureDeact = extractor.analyzeWorkRecord(pureDeactWork);
  assert.equal(sumPureDeact.categoryKey, 'deactivated');
  assert.equal(sumPureDeact.allNonHelperDeactivated, true);
  assert.equal(sumPureDeact.isFullyFinalized, false);
  assert.equal(sumPureDeact.activities.length, 0);

  // E. H-11 Nested-table & prototype-safe HTML table parsing + H-12 Portal error detection
  const nestedTsHtml = `
    <table id="outer">
      <tr>
        <td>TS Details</td>
        <td><table><tr><td>__proto__:</td><td>evil</td></tr></table></td>
      </tr>
      <tr><td>Technical Sanction Number :</td><td><b>TS/NESTED/1</b></td></tr>
      <tr><td>Technical Sanction Date :</td><td><b>05-05-2025</b></td></tr>
      <tr><td>Agreed PAC :</td><td><b>750000.00</b></td></tr>
    </table>
  `;
  const parsedNested = extractor.parseTsFromHandoverHtml(nestedTsHtml);
  assert.equal(parsedNested.tsNo, 'TS/NESTED/1');
  assert.equal(({}).polluted, undefined);
  assert.equal(
    extractor.isPortalErrorHtml('<html><body>Oops! Something went wrong HTTP Status 500</body></html>'),
    true
  );

  // F. H-07 Negotiated rate signed zero & above/below estimate + H-06 early contractor signing SHO
  assert.equal(extractor.parseNegotiatedRatePct('(+)12.5%'), 12.5);
  assert.equal(extractor.parseNegotiatedRatePct('(-)8.25%'), -8.25);
  assert.equal(extractor.parseNegotiatedRatePct('-0%'), 0);
  const signedBeforeDeemed = extractor.computeEffectiveShoDate({
    agreementDate: '14-10-2026',
    contractorSignedDate: '20-10-2026',
    referenceTodayDmy: '22-11-2026',
  });
  assert.equal(signedBeforeDeemed.shoDate, '20-10-2026');
  assert.equal(signedBeforeDeemed.deemedShoDate, '24-10-2026');

  // G. Register report fixes: Total in col 0 without slNo + CSP print btn without inline onclick
  const noSlHtml = register.buildReportHtml({
    title: 'Report <Check>',
    rows: register.buildActivityRegisterRows([mixedWork11051], 'all', '22-11-2026'),
    selectedKeys: ['contractorName', 'totalActiveAmount'],
    viewMode: 'activity',
  });
  assert.ok(noSlHtml.includes('id="p3h-report-print-btn"'));
  assert.equal(noSlHtml.includes('onclick='), false);
  assert.ok(noSlHtml.includes('<th>Total</th><th class="num">₹5,00,000.00</th>'));

  // G2. Report header cleanup, prominent project name, and >=75% font-size floor
  const actRows11051 = register.buildActivityRegisterRows([mixedWork11051], 'all', '22-11-2026');
  const workDetailsReportHtml = register.buildReportHtml({
    title: 'Project Prominence Check',
    rows: actRows11051,
    selectedKeys: ['slNo', 'workDetails', 'totalActiveAmount'],
    filterSummary: 'View: Activity-wise | Scope: active',
    sortSummary: 'Constituency (LAC) (Ascending)',
    viewMode: 'activity',
  });
  assert.equal(workDetailsReportHtml.includes('Generated:'), false);
  assert.equal(workDetailsReportHtml.includes('Sorted By:'), false);
  assert.equal(workDetailsReportHtml.includes('Applied Filters:'), false);
  assert.equal(workDetailsReportHtml.includes('class="meta"'), false);
  const subjTag = '<div class="p3h-work-cell-subj">Mixed Deactivated DPR + Final Work</div>';
  const fileTag = '<div class="p3h-work-cell-file">PWD/BLDG/FL/11051/2024</div>';
  assert.ok(workDetailsReportHtml.includes(subjTag));
  assert.ok(workDetailsReportHtml.includes(fileTag));
  assert.ok(workDetailsReportHtml.indexOf(subjTag) < workDetailsReportHtml.indexOf(fileTag));

  const standaloneSubjHtml = register.buildReportHtml({
    title: 'Standalone Subject Check',
    rows: actRows11051,
    selectedKeys: ['slNo', 'fileNumber', 'subject'],
    filterSummary: 'All Works',
    sortSummary: 'Default',
    viewMode: 'activity',
  });
  assert.ok(standaloneSubjHtml.includes(subjTag));

  const styleMatch = workDetailsReportHtml.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(styleMatch);
  const styleText = styleMatch[1];
  const subjRuleMatch = styleText.match(/\.p3h-work-cell-subj\s*\{([^}]+)\}/);
  assert.ok(subjRuleMatch);
  assert.ok(/font-size:\s*13px/.test(subjRuleMatch[1]));
  assert.ok(/font-weight:\s*700/.test(subjRuleMatch[1]));
  const fontSizes = Array.from(styleText.matchAll(/font-size:\s*([0-9.]+)px/g), (m) => Number(m[1]));
  assert.ok(fontSizes.length > 0);
  const minAllowedPx = 13 * 0.75;
  fontSizes.forEach((sz) => {
    assert.ok(sz >= minAllowedPx, `Expected report font-size ${sz}px >= ${minAllowedPx}px`);
  });

  // H. Overlay exported filter helpers
  assert.equal(overlay.isFullyManuallyArchived(mixedWork11051, sum11051), false);
  assert.equal(overlay.matchesFilter(sum11051, mixedWork11051, 'final', 'all'), true);
  assert.equal(overlay.matchesFilter(sum11051, mixedWork11051, 'not_final', 'all'), false);
  assert.equal(overlay.matchesFilter(sumPureDeact, pureDeactWork, 'dpr', 'all'), false);
  const queueRows = overlay.getTargetedQueueRows(
    [{ fileId: '11051' }, { fileId: '999999' }],
    ['unscanned'],
    {}
  );
  assert.deepEqual(
    queueRows.map((q) => q.fileId),
    ['11051', '999999']
  );

  // I. MV3 Origin Isolation manifest validation
  const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, '2.4.0');
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.equal(manifest.content_scripts.length, 2);
  assert.equal(manifest.content_scripts[0].world, 'MAIN');
  assert.equal(manifest.content_scripts[0].run_at, 'document_start');
  assert.deepEqual(manifest.content_scripts[0].js, ['page-bridge.js']);
  assert.equal(manifest.content_scripts[1].world, undefined);
  assert.deepEqual(manifest.content_scripts[1].js, [
    'db.js',
    'extractor.js',
    'register.js',
    'overlay.js',
  ]);

  // J. Background Service Worker RPC origin & method allowlist enforcement in vm context
  const vm = require('node:vm');
  let swListener = null;
  const swSandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        id: 'ext-p3h-test-id',
        onMessage: {
          addListener: (fn) => {
            swListener = fn;
          },
        },
      },
    },
  };
  swSandbox.self = swSandbox;
  swSandbox.globalThis = swSandbox;
  vm.createContext(swSandbox);
  swSandbox.importScripts = (...files) => {
    for (const f of files) {
      vm.runInContext(fs.readFileSync(path.join(extDir, f), 'utf8'), swSandbox, {
        filename: f,
      });
    }
  };
  vm.runInContext(
    fs.readFileSync(path.join(extDir, 'background.js'), 'utf8'),
    swSandbox,
    { filename: 'background.js' }
  );
  assert.equal(typeof swListener, 'function');

  const invokeRpc = (msg, sender) =>
    new Promise((resolve) => {
      swListener(msg, sender, resolve);
    });

  const evilOriginResp = await invokeRpc(
    { type: 'P3H_DB_RPC', method: 'getWorksByFileIds', args: [[]] },
    { id: 'ext-p3h-test-id', url: 'https://evil.example/price3_pwd/index.pro' }
  );
  assert.equal(evilOriginResp.ok, false);
  assert.match(evilOriginResp.error, /Unauthorized/i);

  const wrongExtResp = await invokeRpc(
    { type: 'P3H_DB_RPC', method: 'getWorksByFileIds', args: [[]] },
    { id: 'other-ext', url: 'https://price3.kerala.gov.in/price3_pwd/index.pro' }
  );
  assert.equal(wrongExtResp.ok, false);

  const protoMethodResp = await invokeRpc(
    { type: 'P3H_DB_RPC', method: '__proto__', args: [] },
    { id: 'ext-p3h-test-id', url: 'https://price3.kerala.gov.in/price3_pwd/index.pro' }
  );
  assert.equal(protoMethodResp.ok, false);

  const evalMethodResp = await invokeRpc(
    { type: 'P3H_DB_RPC', method: 'eval', args: [] },
    { id: 'ext-p3h-test-id', url: 'https://price3.kerala.gov.in/price3_pwd/index.pro' }
  );
  assert.equal(evalMethodResp.ok, false);

  const okRpcResp = await invokeRpc(
    { type: 'P3H_DB_RPC', method: 'getWorksByFileIds', args: [[]] },
    { id: 'ext-p3h-test-id', url: 'https://price3.kerala.gov.in/price3_pwd/index.pro' }
  );
  assert.equal(okRpcResp.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(okRpcResp.result)),
    { worksByFileId: {}, archivedIds: [] }
  );
}

// ---------------------------------------------------------------------------
// 11. Wave-Barrier Batching, Endpoint Consolidation & Codebase Gap Regressions
// ---------------------------------------------------------------------------
{
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const { fileURLToPath } = require('node:url');

  // A. db.extractEstimateCode whitespace/suffix & db.sanitizeWorkRecord rowNo preservation
  assert.equal(
    db.extractEstimateCode('General Electrical Work[ PWD/BLDG/EST/15325/2026_6_1_1 ]'),
    'PWD/BLDG/EST/15325/2026_6_1_1'
  );
  assert.equal(
    db.extractEstimateCode('General Electrical Work[EST/999/2026_6_1_1] (Deactivated)'),
    'EST/999/2026_6_1_1'
  );
  const recWithRowNo = db.sanitizeWorkRecord(
    { fileId: '5001', rowNo: '42', fileNumber: 'PWD/BLDG/FL/5001/2026', subject: 'Row Check' },
    '2026-11-22T00:00:00Z'
  );
  assert.equal(recWithRowNo.rowNo, '42');

  // B. getMissingFields terminates cleanly for 100%-deactivated & 0-component v3 works
  const emptyWork = {
    fileId: '8801',
    fileNumber: 'PWD/BLDG/FL/8801/2026',
    components: [],
    projectDetails: { fetchedAt: '2026-11-22T00:00:00Z', extractorVersion: 3 },
  };
  assert.equal(extractor.getMissingFields(emptyWork).isIncomplete, false);

  const allDeactWork = {
    fileId: '8802',
    fileNumber: 'PWD/BLDG/FL/8802/2026',
    components: [
      {
        componentLabel: 'General Electrical Work[EST/8802_6_1_1]',
        isDeactivated: true,
        bills: [],
      },
    ],
    projectDetails: { fetchedAt: '2026-11-22T00:00:00Z', extractorVersion: 3 },
  };
  const sumDeact = extractor.analyzeWorkRecord(allDeactWork);
  assert.equal(sumDeact.allNonHelperDeactivated, true);
  assert.equal(extractor.getMissingFields(allDeactWork, sumDeact).isIncomplete, false);

  // C. Parser enhancements: hidden #estpac and WCA AS/TS approvers & pending info
  const eagWithHiddenEstpac = `
    <table>
      <tr><td>Agreement Number :</td><td><input id="agreementNo" value="11/EL/AEE/2026-27" /></td></tr>
      <tr><td>Agreement Date :</td><td><input id="agreementDate" value="20-05-2026" /></td></tr>
      <tr><td>Agreed PAC :</td><td>81025</td></tr>
      <tr><td>Neogotiated Rate :</td><td>(-) 0.30%</td></tr>
      <tr><td>Bidder Name :</td><td>ALPHA ELECTRICALS</td></tr>
      <tr><td>Contractor PAN :</td><td>ABCDE1234F</td></tr>
    </table>
    <input type="hidden" id="estpac" name="estpac" value="81268.92" />
  `;
  const parsedEag = extractor.parseAgreementAndContractorHtml(eagWithHiddenEstpac);
  assert.equal(parsedEag.agreementNo, '11/EL/AEE/2026-27');
  assert.equal(parsedEag.agreedPac, '81025');
  assert.equal(parsedEag.estimatePac, '81268.92');

  const wcaFullHtml = `
    <div class="container-fluid">
      <h5>Estimate</h5>
      <div class="row"><div class="col-md-6"><label>AS Approved On :</label></div><div class="col-md-6"><b>16-02-2026</b></div></div>
      <div class="row"><div class="col-md-6"><label>AS Approved By :</label></div><div class="col-md-6"><b>Chief Engineer Buildings</b></div></div>
      <div class="row"><div class="col-md-6"><label>TS Approved On :</label></div><div class="col-md-6"><b>05-03-2026</b></div></div>
      <div class="row"><div class="col-md-6"><label>TS Approved By :</label></div><div class="col-md-6"><b>AEE Electrical PTA</b></div></div>
    </div>
    <div class="container-fluid">
      <h5>MBook</h5>
      <div class="row"><div class="col-md-6"><label>Pending With :</label></div><div class="col-md-6"><b>AE Electrical PTA</b></div></div>
      <div class="row"><div class="col-md-6"><label>Pending Since :</label></div><div class="col-md-6"><b>09-06-2026</b></div></div>
      <div class="row"><div class="col-md-6"><label>Current Stage :</label></div><div class="col-md-6"><b>eMBook Pending with AE</b></div></div>
      <div class="row"><div class="col-md-6"><label>Status :</label></div><div class="col-md-6"><b>Active</b></div></div>
    </div>
  `;
  const parsedWcaFull = extractor.parseWorkComponentAnalysisHtml(wcaFullHtml);
  assert.equal(parsedWcaFull.asApprovedOn, '16-02-2026');
  assert.equal(parsedWcaFull.asApprovedBy, 'Chief Engineer Buildings');
  assert.equal(parsedWcaFull.tsApprovedOn, '05-03-2026');
  assert.equal(parsedWcaFull.tsApprovedBy, 'AEE Electrical PTA');
  assert.equal(parsedWcaFull.mbookPendingWith, 'AE Electrical PTA');
  assert.equal(parsedWcaFull.mbookPendingSince, '09-06-2026');

  // D. Token extraction & Tomcat 2-header race resolution
  assert.equal(
    extractor.resolveWaveWinningToken([
      { ok: true, finishedSeq: 1, tokens: { headerToken: 'T1a', htmlToken: 'T1b', jsonToken: '' } },
      { ok: true, finishedSeq: 2, tokens: { headerToken: 'T1b', htmlToken: 'T1b', jsonToken: '' } },
      { ok: true, finishedSeq: 3, tokens: { headerToken: '', htmlToken: 'T1b', jsonToken: '' } },
    ]),
    'T1b'
  );
  assert.equal(
    extractor.resolveWaveWinningToken([
      { ok: true, finishedSeq: 1, tokens: { headerToken: 'T_HDR_ONLY', htmlToken: '', jsonToken: '' } },
    ]),
    'T_HDR_ONLY'
  );

  // E. Mocked fetch suite for postBatchWave, error/abort/session semantics & fetchBatchWorksFromPortal
  const origFetch = globalThis.fetch;
  const origGtoken = globalThis.GTOKEN;
  const mkRes = ({ status = 200, url = 'https://price3.kerala.gov.in/price3_pwd/mock.pro', headers = {}, body = '' }) => ({
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (name) => {
        const lower = String(name || '').toLowerCase();
        for (const k of Object.keys(headers)) {
          if (k.toLowerCase() === lower) return headers[k];
        }
        return null;
      },
    },
    text: async () => body,
  });

  try {
    // E1. Normal 6-way wave + 2-header Tomcat race token update
    globalThis.GTOKEN = 'T0';
    let waveCallIdx = 0;
    const seenSentTokens = [];
    globalThis.fetch = async (url, init) => {
      seenSentTokens.push(init.headers.price_token);
      waveCallIdx++;
      if (waveCallIdx === 1) {
        return mkRes({
          headers: { price_token: 'T1a' },
          body: `<div id="pt-info">ok1</div><script>var GTOKEN='T1b';</script>`,
        });
      }
      if (waveCallIdx === 2) {
        return mkRes({
          headers: { price_token: 'T1b' },
          body: `<div id="pt-info">ok2</div><script>var GTOKEN='T1b';</script>`,
        });
      }
      return mkRes({
        body: `<div id="pt-info">ok${waveCallIdx}</div><script>var GTOKEN='T1b';</script>`,
      });
    };
    const wSpecs = [1, 2, 3, 4, 5, 6].map((n) => ({
      endpoint: 'addattribute_view.pro',
      params: { estid: String(n) },
      isAjax: true,
    }));
    const wRes = await extractor.postBatchWave(wSpecs, { concurrency: 6 });
    assert.equal(wRes.resultsByKey.size, 6);
    assert.equal(wRes.errorsByKey.size, 0);
    assert.deepEqual(seenSentTokens, ['T0', 'T0', 'T0', 'T0', 'T0', 'T0']);
    assert.equal(extractor.getToken(), 'T1b');

    // E2. Transient HTTP 503 inside a 6-item wave automatically retries sequentially and succeeds
    let retriedOnce = false;
    globalThis.GTOKEN = 'T_RETRY_0';
    globalThis.fetch = async (url, init) => {
      const bodyStr = String(init.body || '');
      if (bodyStr.includes('estid=3') && !retriedOnce) {
        retriedOnce = true;
        return mkRes({ status: 503, body: 'Service Unavailable' });
      }
      if (retriedOnce && bodyStr.includes('estid=3')) {
        assert.equal(init.headers.price_token, 'T_RETRY_1');
        return mkRes({
          headers: { price_token: 'T_RETRY_2' },
          body: `<div id="pt-info">recovered3</div><script>var GTOKEN='T_RETRY_2';</script>`,
        });
      }
      return mkRes({
        headers: bodyStr.includes('estid=1') ? { price_token: 'T_RETRY_1' } : {},
        body: `<div id="pt-info">ok</div><script>var GTOKEN='T_RETRY_1';</script>`,
      });
    };
    const retryRes = await extractor.postBatchWave(wSpecs, { concurrency: 6 });
    assert.equal(retriedOnce, true);
    assert.equal(retryRes.resultsByKey.size, 6);
    assert.equal(retryRes.errorsByKey.size, 0);
    assert.equal(extractor.getToken(), 'T_RETRY_2');

    // E3. AJAX JSON instant-login payload triggers SESSION_EXPIRED
    globalThis.GTOKEN = 'T_SESS';
    globalThis.fetch = async () =>
      mkRes({ body: JSON.stringify({ status: 'A', token: 'NEW_LOGIN_TOK' }) });
    await assert.rejects(
      () => extractor.postBatchWave([{ endpoint: 'showbilllist.pro', params: { estmainid: '1' } }]),
      (err) => err && err.message === 'SESSION_EXPIRED'
    );

    // E4. Mid-flight AbortController.abort() propagates ABORTED (never swallowed)
    globalThis.GTOKEN = 'T_ABORT';
    const abortCtrl = new AbortController();
    globalThis.fetch = async (_url, init) =>
      new Promise((_resolve, reject) => {
        if (init.signal) {
          init.signal.addEventListener('abort', () => reject(new Error('DomAbort')), { once: true });
        }
        setTimeout(() => abortCtrl.abort(), 5);
      });
    await assert.rejects(
      () =>
        extractor.fetchBatchWorksFromPortal([{ fileId: '900', fileNumber: 'PWD/900' }], {
          concurrency: 6,
          signal: abortCtrl.signal,
        }),
      (err) => err && err.message === 'ABORTED'
    );

    // E5. Full fetchBatchWorksFromPortal integration:
    //   - Work 1 (Standard w/ LOA & all IDs): skips loa.pro AND pricehandeover.do, parses #estpac
    //   - Work 2 (Direct calleagreement empty -> falls back to loa.pro -> calleagreement, missing TS/PAC -> falls back to pricehandeover.do)
    //   - Work 3 (Composite retendered + deactivated DPR stub): anchor->sibling inheritance, cross-work dedup
    //   - Work 4 (Urgent pre-agreement + no SBD): WCA AS/TS fallback + negotiatedetilsview + posttendermain + bidderview
    const fetchLog = [];
    let tokSeq = 1;
    globalThis.GTOKEN = 'T_BATCH_0';
    globalThis.fetch = async (url, init) => {
      const endpoint = url.split('/').pop();
      const params = Object.fromEntries(new URLSearchParams(init.body || ''));
      fetchLog.push({ endpoint, params });
      const nextTok = `T_BATCH_${++tokSeq}`;
      const wrapTok = (html) => `${html}<script>var GTOKEN='${nextTok}';</script>`;

      if (endpoint === 'getworkfiledetails.pro') {
        if (params.fileId === '1001') {
          return mkRes({
            headers: { price_token: nextTok },
            body: wrapTok(`
              <ul id="pt-side-menu-full">
                <li>
                  <span>General Electrical Work[PWD/BLDG/EST/1001/2026_6_1_1]</span>
                  <ul>
                    <li><a onclick="call_basicestimation('t','100101')">DPR</a></li>
                    <li><a onclick="callsbd('t','100102')">pre-Tender1</a></li>
                    <li><a onclick="callloa('t','100103')">Letter of Acceptance</a></li>
                    <li><a onclick="callpricehandover('t','100104')">Site Handover</a></li>
                    <li><a onclick="callembook('100105')">eMbook</a></li>
                    <li><a onclick="callebill('100106')">e-Bills</a></li>
                  </ul>
                </li>
              </ul>`),
          });
        }
        if (params.fileId === '1002') {
          return mkRes({
            body: wrapTok(`
              <ul id="pt-side-menu-full">
                <li>
                  <span>General Electrical Work[PWD/BLDG/EST/1002/2026_6_1_1]</span>
                  <ul>
                    <li><a onclick="call_basicestimation('t','100201')">DPR</a></li>
                    <li><a onclick="callsbd('t','100202')">pre-Tender1</a></li>
                    <li><a onclick="callloa('t','100203')">Letter of Acceptance</a></li>
                    <li><a onclick="callpricehandover('t','100204')">Site Handover</a></li>
                    <li><a onclick="callembook('100205')">eMbook</a></li>
                    <li><a onclick="callebill('100206')">e-Bills</a></li>
                  </ul>
                </li>
              </ul>`),
          });
        }
        if (params.fileId === '1003') {
          return mkRes({
            body: wrapTok(`
              <ul id="pt-side-menu-full">
                <li>
                  <span>Phase 2 Building</span>
                  <ul>
                    <li>
                      <span>Composite Civil Work[PWD/BLDG/EST/1003/2026_9_1_1]</span>
                      <ul>
                        <li><a onclick="call_basicestimation('t','100301')">DPR</a></li>
                        <li><a onclick="callsbd('t','100302')">pre-Tender1</a></li>
                        <li><a onclick="callloa_cw('t','100303','100301')">Letter of Acceptance</a></li>
                        <li><a onclick="callpricehandover('t','100304')">Site Handover</a></li>
                        <li><a onclick="callembook('100305')">eMbook</a></li>
                        <li><a onclick="callebill('100306')">e-Bills</a></li>
                      </ul>
                    </li>
                    <li>
                      <span>Composite Final Component[PWD/BLDG/EST/1003/2026_23_2_1]</span>
                      <ul>
                        <li><a onclick="call_basicestimation('t','100311')">DPR</a></li>
                        <li><a onclick="callsbd('t','100302')">pre-Tender1</a></li>
                        <li><a onclick="callloa_cw('t','100303','100304')">Letter of Acceptance</a></li>
                        <li><a onclick="callpricehandover('t','100304')">Site Handover</a></li>
                        <li><a onclick="callembook('100315')">eMbook</a></li>
                        <li><a onclick="callebill('100316')">e-Bills</a></li>
                      </ul>
                    </li>
                    <li title="Deactivated">
                      <del><span>Old Civil[PWD/BLDG/EST/1003/2026_5_1_1]</span></del>
                      <ul><li><a onclick="call_basicestimation('t','100399')">DPR</a></li></ul>
                    </li>
                  </ul>
                </li>
              </ul>`),
          });
        }
        if (params.fileId === '1004') {
          return mkRes({
            body: wrapTok(`
              <ul id="pt-side-menu-full">
                <li>
                  <span>Electrical AC Work[PWD/BLDG/EST/1004/2026_13_1_1]</span>
                  <ul>
                    <li><a onclick="call_basicestimation('t','100401')">DPR</a></li>
                    <li><a onclick="callposttender('t','100402')">post-Tender1</a>
                      <ul>
                        <li><a onclick="callpricehandover('t','100404')">Site Handover</a></li>
                        <li><a onclick="callembook('100405')">eMbook</a></li>
                      </ul>
                    </li>
                  </ul>
                </li>
              </ul>`),
          });
        }
      }

      if (endpoint === 'addattribute_view.pro') {
        const isUrgent = params.estid === '100401';
        return mkRes({
          body: wrapTok(`
            <select id="durationYear"><option value="-1">Year</option></select>
            <select id="durationMonth"><option value="3" selected>3</option></select>
            <select id="durationDay"><option value="-1">Day</option></select>
            <select id="workPriorityCode"><option value="1" selected>${isUrgent ? 'Urgent Works - VVIP' : 'Normal'}</option></select>
          `),
        });
      }

      if (endpoint === 'addattribute_constituency_view.pro') {
        return mkRes({
          body: wrapTok(`
            <select name="assemblyConstituencyCode" id="ac1"><option value="1" selected>KONNI</option></select>
            <select name="parlConstituencyCode" id="pc1"><option value="1" selected>PATHANAMTHITTA</option></select>
          `),
        });
      }

      if (endpoint === 'generatedraft.pro') {
        if (params.sbdId === '100202') {
          // Work 2: AS present, TS blank -> forces pricehandeover.do fallback
          return mkRes({
            body: wrapTok(`
              <table>
                <tr><td>Administrative Sanction Number :</td><td><b>AS/1002</b></td></tr>
                <tr><td>Administrative Sanction Date :</td><td><b>01-02-2026</b></td></tr>
              </table>
            `),
          });
        }
        return mkRes({
          body: wrapTok(`
            <table>
              <tr><td>Administrative Sanction Number :</td><td><b>AS/${params.sbdId}</b></td></tr>
              <tr><td>Administrative Sanction Date :</td><td><b>01-01-2026</b></td></tr>
              <tr><td>Administrative Sanction Amount :</td><td><b>500000</b></td></tr>
              <tr><td>Administrative Sanction Authority :</td><td><b>CE Buildings</b></td></tr>
              <tr><td>Technical Sanction Number :</td><td><label id="tsNumber">TS/${params.sbdId}</label></td></tr>
              <tr><td>Technical Sanction Date :</td><td><b>10-01-2026</b></td></tr>
              <tr><td>Technical Sanction Amount :</td><td><b>450000</b></td></tr>
              <tr><td>Technical Sanction Authority :</td><td><b>EE Electrical</b></td></tr>
            </table>
          `),
        });
      }

      if (endpoint === 'work_component_analysis.pro') {
        if (params.workactivityId === '100405') {
          return mkRes({ body: wrapTok(wcaFullHtml) });
        }
        return mkRes({
          body: wrapTok(`
            <h5>Site Handover</h5>
            <div class="row"><div class="col-md-6"><label>Closed On :</label></div><div class="col-md-6"><b>01-03-2026</b></div></div>
            <h5>MBook</h5>
            <div class="row"><div class="col-md-6"><label>Status :</label></div><div class="col-md-6"><b>Active</b></div></div>
          `),
        });
      }

      if (endpoint === 'calleagreement.pro') {
        // Work 2 direct call (estmainid === '100206') returns empty/no agreement; LOA fallback uses estmainid === '991002'
        if (params.posttenderid === '100203' && params.estmainid === '100206') {
          return mkRes({ body: wrapTok(`<div id="pt-info">no direct agreement</div>`) });
        }
        if (params.posttenderid === '100203' && params.estmainid === '991002') {
          return mkRes({
            body: wrapTok(`
              <table>
                <tr><td>Agreement Number :</td><td><input id="agreementNo" value="AG/1002-FALLBACK" /></td></tr>
                <tr><td>Agreement Date :</td><td><input id="agreementDate" value="15-02-2026" /></td></tr>
                <tr><td>Bidder Name :</td><td>BETA POWER</td></tr>
              </table>
            `),
          });
        }
        return mkRes({
          body: wrapTok(`
            <table>
              <tr><td>Agreement Number :</td><td><input id="agreementNo" value="AG/${params.posttenderid}" /></td></tr>
              <tr><td>Agreement Date :</td><td><input id="agreementDate" value="10-02-2026" /></td></tr>
              <tr><td>Agreed PAC :</td><td>81025</td></tr>
              <tr><td>Neogotiated Rate :</td><td>(-) 0.30%</td></tr>
              <tr><td>Bidder Name :</td><td>CTR_${params.posttenderid}</td></tr>
            </table>
            <input type="hidden" id="estpac" name="estpac" value="81268.92" />
          `),
        });
      }

      if (endpoint === 'loa.pro') {
        return mkRes({
          body: wrapTok(
            `<a onclick="eagreement('t','100203','1002','100205','100204','991002')">EAgreement</a>`
          ),
        });
      }

      if (endpoint === 'pricehandeover.do') {
        return mkRes({
          body: wrapTok(`
            <table>
              <tr><td>Technical Sanction Number :</td><td><b>TS/1002-HO</b></td></tr>
              <tr><td>Technical Sanction Date :</td><td><b>05-02-2026</b></td></tr>
              <tr><td>Technical Sanction Amount :</td><td><b>200000</b></td></tr>
              <tr><td>Agreed PAC :</td><td>195000.50</td></tr>
            </table>
          `),
        });
      }

      if (endpoint === 'handoverhistory.pro') {
        return mkRes({
          body: wrapTok(`
            <table id="pt-history_table">
              <tbody><tr><td>12-02-2026</td><td>For Counter Signinig</td><td>AE</td><td>EE</td><td>Signed by contractor</td></tr></tbody>
            </table>
          `),
        });
      }

      if (endpoint === 'negotiatedetilsview.pro') {
        return mkRes({
          body: wrapTok(`
            <table id="pt-specifications1">
              <thead><tr><th>No</th><th>Bidder</th><th>Estimate PAC</th><th>LMR PAC</th><th>Current SoR PAC</th><th>Quoted Rate (%)</th><th>Quoted PAC</th><th>Remarks</th><th>Negotiated Rate (%)</th><th>Negotiated PAC</th><th>Status</th></tr></thead>
              <tbody>
                <tr><td>1</td><td>XAVIER JOSEPH(BBAPJ6071J)</td><td>0</td><td>0</td><td>0</td><td>0</td><td>0</td><td><b>LQI</b></td><td>(+)0</td><td>0</td><td><i class="fa fa-check-circle pt-c-teal me-1"></i></td></tr>
              </tbody>
            </table>
          `),
        });
      }
      if (endpoint === 'posttendermain.pro') {
        return mkRes({
          body: wrapTok(
            `<input type="hidden" id="sbdid" name="sbdid1" value="100402"><input type="hidden" id="ptid" name="ptid1" value="2611002">`
          ),
        });
      }
      if (endpoint === 'bidderview.pro') {
        return mkRes({
          body: wrapTok(`
            <table id="pd-attachment-table">
              <thead><tr><th>No</th><th>PAN Number</th><th>Bidder Name</th><th>e-mail Id</th><th>Mobile No</th><th>Applicant Type</th><th>Is LCC</th></tr></thead>
              <tbody>
                <tr><td>1</td><td>BBAPJ6071J</td><td>XAVIER JOSEPH</td><td>jobyjoseph55555@gmail.com</td><td>9048696154</td><td>INDIVIDUAL APPLICANT</td><td>No</td></tr>
              </tbody>
            </table>
          `),
        });
      }
      if (endpoint === 'showbilllist.pro') {
        if (params.estmainid === '100106') {
          return mkRes({
            body: wrapTok(`
              <table id="pt-file_table_list"><tbody>
                <tr><td>1</td><td>First &amp; Final</td><td>81000</td><td>0</td><td>81000</td><td>AE</td><td>01-04-2026</td><td>02-04-2026</td><td>EE</td><td>Submitted to EMILI</td></tr>
              </tbody></table>
            `),
          });
        }
        return mkRes({
          body: wrapTok(`<table id="pt-file_table_list"><tbody><tr><td class="dataTables_empty">No data available</td></tr></tbody></table>`),
        });
      }
      return mkRes({ body: wrapTok(`<div id="pt-info">ok</div>`) });
    };

    const batchRes = await extractor.fetchBatchWorksFromPortal(
      [
        { fileId: '1001', rowNo: '1', fileNumber: 'PWD/BLDG/FL/1001/2026', subject: 'Work 1' },
        { fileId: '1002', rowNo: '2', fileNumber: 'PWD/BLDG/FL/1002/2026', subject: 'Work 2' },
        { fileId: '1003', rowNo: '3', fileNumber: 'PWD/BLDG/FL/1003/2026', subject: 'Work 3' },
        { fileId: '1004', rowNo: '4', fileNumber: 'PWD/BLDG/FL/1004/2026', subject: 'Work 4' },
      ],
      { concurrency: 6, delayMs: 0, includeDetails: true }
    );
    assert.equal(batchRes.errors.length, 0);
    assert.equal(batchRes.results.length, 4);

    // Work 1 assertions: skipped loa.pro and pricehandeover.do, parsed hidden #estpac
    const w1 = batchRes.results[0];
    assert.equal(w1.projectDetails.agreementNo, 'AG/100103');
    assert.equal(w1.projectDetails.estimatePac, '81268.92');
    assert.equal(w1.projectDetails.agreedPac, '81025');
    assert.equal(w1.projectDetails.shoDate, '12-02-2026');
    assert.equal(w1.components[0].bills.length, 1);
    assert.equal(
      fetchLog.some((x) => x.endpoint === 'loa.pro' && x.params.posttenderid === '100103'),
      false
    );
    assert.equal(
      fetchLog.some((x) => x.endpoint === 'pricehandeover.do' && x.params.estid === '100104'),
      false
    );

    // Work 2 assertions: direct failed -> fell back to loa.pro -> calleagreement(991002) & pricehandeover.do
    const w2 = batchRes.results[1];
    assert.equal(w2.projectDetails.agreementNo, 'AG/1002-FALLBACK');
    assert.equal(w2.projectDetails.contractor.name, 'BETA POWER');
    assert.equal(w2.projectDetails.tsNo, 'TS/1002-HO');
    assert.equal(w2.projectDetails.agreedPac, '195000.50');
    assert.equal(
      fetchLog.some((x) => x.endpoint === 'loa.pro' && x.params.posttenderid === '100203'),
      true
    );

    // Work 3 assertions: composite sibling inherited from anchor without duplicate fetches
    const w3 = batchRes.results[2];
    const w3Civil = w3.components.find((c) => c.activityName === 'Composite Civil Work');
    const w3Final = w3.components.find((c) => c.activityName === 'Composite Final Component');
    assert.equal(w3Final.details.contractor.name, 'CTR_100303');
    assert.equal(w3Civil.details.contractor.name, 'CTR_100303');
    assert.equal(w3Civil.details.constituency, 'KONNI');
    assert.equal(
      fetchLog.filter((x) => x.endpoint === 'calleagreement.pro' && x.params.posttenderid === '100303').length,
      1
    );

    // Work 4 assertions: WCA AS/TS date & authority fallback + urgent bidderview
    const w4 = batchRes.results[3];
    assert.equal(w4.projectDetails.asDate, '16-02-2026');
    assert.equal(w4.projectDetails.asAuthority, 'Chief Engineer Buildings');
    assert.equal(w4.projectDetails.tsDate, '05-03-2026');
    assert.equal(w4.projectDetails.tsAuthority, 'AEE Electrical PTA');
    assert.equal(w4.projectDetails.isUrgentPreAgreement, true);
    assert.equal(w4.projectDetails.contractor.name, 'XAVIER JOSEPH');
    assert.equal(w4.projectDetails.contractor.mobile, '9048696154');

    // E6. includeDetails: false detects Open ('Active') -> 'Closed' M-Book transition
    globalThis.fetch = async (url) => {
      const endpoint = url.split('/').pop();
      const nextTok = `T_QUICK_${++tokSeq}`;
      if (endpoint === 'getworkfiledetails.pro') {
        return mkRes({
          headers: { price_token: nextTok },
          body: `<ul id="pt-side-menu-full"><li><span>General Electrical Work[EST/2001_6_1_1]</span><ul><li><a onclick="callembook('200105')">eMbook</a></li><li><a onclick="callebill('200106')">e-Bills</a></li></ul></li></ul><script>var GTOKEN='${nextTok}';</script>`,
        });
      }
      if (endpoint === 'work_component_analysis.pro') {
        return mkRes({
          body: `<h5>MBook</h5><div class="row"><div class="col-md-6"><label>Status :</label></div><div class="col-md-6"><b>Closed</b></div></div><script>var GTOKEN='${nextTok}';</script>`,
        });
      }
      if (endpoint === 'showbilllist.pro') {
        return mkRes({
          body: `<table id="pt-file_table_list"><tbody><tr><td class="dataTables_empty">No data available</td></tr></tbody></table><script>var GTOKEN='${nextTok}';</script>`,
        });
      }
      return mkRes({ body: `<div id="pt-info">ok</div><script>var GTOKEN='${nextTok}';</script>` });
    };
    const quickUpdated = await extractor.fetchSingleWorkFromPortal(
      { fileId: '2001', fileNumber: 'PWD/BLDG/FL/2001/2026' },
      {
        includeDetails: false,
        existingRecord: {
          fileId: '2001',
          components: [
            {
              estimateCode: 'EST/2001_6_1_1',
              mbookStatus: 'Active',
              wcaStage: 'eMBook Pending with AE',
              details: { mbookStatus: 'Active', wcaStage: 'eMBook Pending with AE' },
            },
          ],
          projectDetails: { fetchedAt: '2026-11-20T00:00:00Z', extractorVersion: 3 },
        },
      }
    );
    assert.equal(quickUpdated.components[0].mbookStatus, 'Closed');
    assert.equal(quickUpdated.components[0].details.mbookStatus, 'Closed');
  } finally {
    globalThis.fetch = origFetch;
    globalThis.GTOKEN = origGtoken;
  }

  // F. In-memory IndexedDB verification of db.putWorksBatch({ returnRecords: true }) + background.js RPC
  const createMockIndexedDb = () => {
    const storesData = { active_works: new Map(), archived_works: new Map(), settings: new Map() };
    const mkReq = (fn) => {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        try {
          req.result = fn();
          if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
        } catch (err) {
          req.error = err;
          if (typeof req.onerror === 'function') req.onerror({ target: req });
        }
      });
      return req;
    };
    return {
      open: () => {
        const req = {
          result: null,
          error: null,
          onupgradeneeded: null,
          onblocked: null,
          onsuccess: null,
          onerror: null,
        };
        const dbConn = {
          objectStoreNames: { contains: () => true },
          onversionchange: null,
          onclose: null,
          close: () => {},
          transaction: (storeNames) => {
            const names = Array.isArray(storeNames) ? storeNames : [storeNames];
            const tx = { oncomplete: null, onerror: null, onabort: null };
            let pending = 0;
            const scheduleComplete = () => {
              pending++;
              queueMicrotask(() => {
                pending--;
                if (pending === 0 && typeof tx.oncomplete === 'function') tx.oncomplete();
              });
            };
            tx.objectStore = (name) => {
              if (!names.includes(name)) throw new Error('Unknown store: ' + name);
              const map = storesData[name];
              const keyPath = name === 'settings' ? 'key' : 'fileId';
              return {
                get: (k) => {
                  scheduleComplete();
                  return mkReq(() => map.get(String(k)));
                },
                put: (val) => {
                  scheduleComplete();
                  return mkReq(() => {
                    map.set(String(val[keyPath]), val);
                    return val[keyPath];
                  });
                },
                delete: (k) => {
                  scheduleComplete();
                  return mkReq(() => map.delete(String(k)));
                },
                getAll: () => {
                  scheduleComplete();
                  return mkReq(() => Array.from(map.values()));
                },
                count: () => {
                  scheduleComplete();
                  return mkReq(() => map.size);
                },
                index: (idxName) => ({
                  count: (val) => {
                    scheduleComplete();
                    return mkReq(() => Array.from(map.values()).filter((r) => r[idxName] === val).length);
                  },
                  getAll: (val) => {
                    scheduleComplete();
                    return mkReq(() => Array.from(map.values()).filter((r) => r[idxName] === val));
                  },
                }),
              };
            };
            return tx;
          },
        };
        queueMicrotask(() => {
          req.result = dbConn;
          if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
        });
        return req;
      },
    };
  };

  const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let swListener2 = null;
  const swSandbox2 = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    indexedDB: createMockIndexedDb(),
    chrome: {
      runtime: {
        id: 'ext-p3h-test-id',
        onMessage: { addListener: (fn) => { swListener2 = fn; } },
      },
    },
  };
  swSandbox2.self = swSandbox2;
  swSandbox2.globalThis = swSandbox2;
  vm.createContext(swSandbox2);
  swSandbox2.importScripts = (...files) => {
    for (const f of files) {
      vm.runInContext(fs.readFileSync(path.join(extDir, f), 'utf8'), swSandbox2, { filename: f });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(extDir, 'background.js'), 'utf8'), swSandbox2, {
    filename: 'background.js',
  });

  const batchPutResp = await new Promise((resolve) => {
    swListener2(
      {
        type: 'P3H_DB_RPC',
        method: 'putWorksBatch',
        args: [
          [
            {
              fileId: '3001',
              rowNo: '7',
              fileNumber: 'PWD/BLDG/FL/3001/2026',
              subject: 'Batch Saved Active',
              components: [{ componentLabel: 'General Electrical Work[EST/3001]', bills: [] }],
              projectDetails: { fetchedAt: '2026-11-22T00:00:00Z', extractorVersion: 3 },
            },
          ],
          { returnRecords: true },
        ],
      },
      { id: 'ext-p3h-test-id', url: 'https://price3.kerala.gov.in/price3_pwd/index.pro' },
      resolve
    );
  });
  assert.equal(batchPutResp.ok, true);
  assert.equal(batchPutResp.result.inserted, 1);
  assert.equal(batchPutResp.result.activePlaced, 1);
  assert.equal(batchPutResp.result.recordsByFileId['3001'].rowNo, '7');
  assert.equal(batchPutResp.result.recordsByFileId['3001'].isArchived, false);
}

// ---------------------------------------------------------------------------
// 12. UI Cleanup, Multi-Component Detail Isolation (14166/2026) & Stage Removal
// ---------------------------------------------------------------------------
{
  const fs = require('node:fs');
  const path = require('node:path');
  const { fileURLToPath } = require('node:url');

  // Req 1: Clean scan progress messages & absence of batch/rate/token jargon
  const msg1 = overlay.formatScanProgressMessage({
    startIndex: 0,
    sliceCount: 6,
    total: 50,
    firstFileNumber: 'PWD/BLDG/FL/14166/2026',
    processed: 0,
    batchSize: 6,
    elapsedSec: 0,
  });
  assert.equal(msg1, 'Scanning 1–6/50: PWD/BLDG/FL/14166/2026...');
  assert.equal(/batch|works\/s|works\/sec|×|token/i.test(msg1), false);

  const msg2 = overlay.formatScanProgressMessage({
    startIndex: 6,
    sliceCount: 6,
    total: 50,
    firstFileNumber: 'PWD/BLDG/FL/14166/2026',
    processed: 6,
    batchSize: 6,
    elapsedSec: 5,
  });
  assert.equal(msg2, 'Scanning 7–12/50 (~37s left): PWD/BLDG/FL/14166/2026...');
  assert.equal(/batch|works\/s|works\/sec|×|token/i.test(msg2), false);

  const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const overlaySrc = fs.readFileSync(path.join(extDir, 'overlay.js'), 'utf8');
  assert.equal(overlaySrc.includes('works/s'), false);
  assert.equal(overlaySrc.includes('× batch'), false);
  assert.equal(overlaySrc.includes('(token protected)'), false);
  assert.equal(overlaySrc.includes('Fast Batch'), false);
  assert.equal(overlaySrc.includes('Turbo Batch'), false);
  assert.equal(overlaySrc.includes('Safe Sequential'), false);

  // Req 2 & Req 3: PWD/BLDG/FL/14166/2026 multi-component isolation & no "Stage:" clutter
  const comp1Pd = {
    fetchedAt: '2026-11-22T00:00:00Z',
    extractorVersion: 3,
    constituency: 'ARANMULA',
    parliamentConstituency: 'PATHANAMTHITTA',
    asNo: 'AS/14166/1',
    asDate: '10-08-2026',
    tsNo: 'TS/14166/1',
    tsDate: '12-08-2026',
    tsAmount: '350000',
    agreedPac: '314452',
    negotiatedRate: '(+)0',
    contractor: { name: 'XAVIER JOSEPH', mobile: '9048696154' },
    periodYears: 0,
    periodMonths: 1,
    periodDays: 0,
    periodText: '1 Month',
    shoDate: '24-08-2026',
    isUrgentPreAgreement: true,
    hasLoa: false,
  };
  const comp2Pd = {
    fetchedAt: '2026-11-22T00:00:00Z',
    extractorVersion: 3,
    constituency: 'ARANMULA',
    parliamentConstituency: 'PATHANAMTHITTA',
    asNo: 'AS/14166/2',
    asDate: '15-08-2026',
    tsNo: '',
    tsDate: '',
    tsAmount: '',
    agreedPac: '',
    negotiatedRate: '',
    contractor: { name: 'AC TECH CORP' },
    periodYears: 0,
    periodMonths: 0,
    periodDays: 0,
    periodText: '',
    shoDate: '',
    isUrgentPreAgreement: true,
    hasLoa: false,
  };
  const w14166Split = {
    fileId: '2661614167',
    fileNumber: 'PWD/BLDG/FL/14166/2026',
    subject: 'VVIP Visit - Rest House Aranmula',
    components: [
      {
        estmainid: '2615630',
        hasEBillStage: true,
        hasEmbook: true,
        hasPostTender: true,
        componentLabel: 'General Electrical Work[PWD/BLDG/EST/14166/2026_6_1_1]',
        mbookStatus: 'Closed',
        wcaStage: 'eMBook Pending with AE | Activate eMBook to AE | EST TS AE level | For TS Estimate',
        bills: [
          {
            billTypeAndNo: 'PWD/BLDG/EB/14166/2026_6_1_1_Final',
            status: 'Pending',
            grandTotal: '314452',
          },
        ],
        details: comp1Pd,
      },
      {
        estmainid: null,
        hasEBillStage: false,
        hasEmbook: true,
        hasPostTender: true,
        componentLabel: 'Electrical AC Work[PWD/BLDG/EST/14166/2026_13_1_1]',
        mbookStatus: 'Active',
        wcaStage: 'eMBook Pending with AE | Activate eMBook to AE | EST TS AE level | For TS Estimate',
        bills: [],
        details: comp2Pd,
      },
    ],
    projectDetails: { ...comp1Pd },
  };
  const sum14166Split = extractor.analyzeWorkRecord(w14166Split);
  assert.equal(sum14166Split.hasIndependentActivities, true);

  // hasIndependentActivities is false for single-component & single-group composite works
  const wSingle = {
    fileId: '107175',
    fileNumber: 'PWD/BLDG/FL/107175/2021',
    components: [
      {
        estmainid: '21939051',
        hasEBillStage: true,
        componentLabel: 'Electrical Lift Work[PWD/BLDG/EST/107175/2021_15_1_1]',
        wcaStage: 'eMBook Pending with AE | Activate eMBook to AE | EST TS AE level | For TS Estimate',
        bills: [],
        details: comp1Pd,
      },
    ],
    projectDetails: comp1Pd,
  };
  const sumSingle = extractor.analyzeWorkRecord(wSingle);
  assert.equal(sumSingle.hasIndependentActivities, false);

  const wCompSingleGroup = {
    fileId: '1846',
    fileNumber: 'PWD/BLDG/FL/1846/2023',
    components: [
      {
        estmainid: '101',
        hasEBillStage: true,
        workGroup: 'Phase 2',
        componentLabel: 'Composite Civil Work[EST/1846_9_1_1]',
        bills: [],
        details: comp1Pd,
      },
      {
        estmainid: '102',
        hasEBillStage: true,
        workGroup: 'Phase 2',
        componentLabel: 'Composite Electrical Work[EST/1846_17_1_1]',
        bills: [],
        details: comp1Pd,
      },
      {
        estmainid: '103',
        hasEBillStage: true,
        workGroup: 'Phase 2',
        componentLabel: 'Composite Final Component[EST/1846_23_2_1]',
        bills: [],
        details: comp1Pd,
      },
    ],
    projectDetails: comp1Pd,
  };
  const sumCompSingleGroup = extractor.analyzeWorkRecord(wCompSingleGroup);
  assert.equal(sumCompSingleGroup.isCompositeWork, true);
  assert.equal(sumCompSingleGroup.hasIndependentActivities, false);

  // Drawer top card shows Project Overview WITHOUT Component 1 details
  const overviewHtml = overlay.renderProjectDetailsCard(w14166Split, sum14166Split);
  assert.ok(overviewHtml.includes('Project Overview'));
  assert.ok(overviewHtml.includes('ARANMULA'));
  assert.ok(overviewHtml.includes('2 Activities'));
  assert.equal(overviewHtml.includes('TS/14166/1'), false);
  assert.equal(overviewHtml.includes('XAVIER JOSEPH'), false);
  assert.equal(overviewHtml.includes('24-08-2026'), false);
  assert.equal(overviewHtml.includes('23-09-2026'), false);

  // Drawer component cards render concerned activity's own details cleanly & omit Stage: clutter
  const cardsHtml = overlay.renderComponentCardsHtml(w14166Split, sum14166Split);
  const splitCards = cardsHtml.split('<div class="p3h-comp-card">').slice(1);
  assert.equal(splitCards.length, 2);
  assert.ok(splitCards[0].includes('AS/14166/1'));
  assert.ok(splitCards[0].includes('TS/14166/1'));
  assert.ok(splitCards[0].includes('XAVIER JOSEPH'));
  assert.ok(splitCards[0].includes('24-08-2026'));
  assert.ok(splitCards[0].includes('23-09-2026'));

  assert.ok(splitCards[1].includes('AS/14166/2'));
  assert.ok(splitCards[1].includes('AC TECH CORP'));
  assert.equal(splitCards[1].includes('AS/14166/1'), false);
  assert.equal(splitCards[1].includes('TS/14166/1'), false);
  assert.equal(splitCards[1].includes('XAVIER JOSEPH'), false);
  assert.equal(splitCards[1].includes('24-08-2026'), false);
  assert.equal(splitCards[1].includes('23-09-2026'), false);

  for (const html of [cardsHtml, overlay.renderComponentCardsHtml(wSingle, sumSingle)]) {
    assert.equal(html.includes('Stage:'), false);
    assert.equal(html.includes('eMBook Pending with AE'), false);
    assert.equal(html.includes('Activate eMBook to AE'), false);
    assert.equal(html.includes('EST TS AE level'), false);
    assert.equal(html.includes('For TS Estimate'), false);
  }

  // Register isolation for Activity-wise & File-wise views
  const actRows14166 = register.buildActivityRegisterRows([w14166Split], 'all', '22-11-2026');
  assert.equal(actRows14166.length, 2);
  assert.equal(actRows14166[1].activityName, 'Electrical AC Work');
  assert.equal(actRows14166[1].asNo, 'AS/14166/2');
  assert.equal(actRows14166[1].tsNo, '');
  assert.equal(actRows14166[1].periodText, '');
  assert.equal(actRows14166[1].shoDate, '');
  assert.equal(actRows14166[1].completionDate, '');
  assert.equal(actRows14166[1].contractorName, 'AC TECH CORP');

  const fileRow14166 = register.buildRegisterRow(w14166Split, 0, '22-11-2026');
  assert.equal(fileRow14166.hasSplitActivityDetails, true);
  assert.equal(fileRow14166.constituency, 'ARANMULA');
  assert.equal(fileRow14166.tsNo, '');
  assert.equal(fileRow14166.contractorName, '');
  assert.equal(fileRow14166.shoDate, '');
  assert.equal(fileRow14166.completionDate, '');
  assert.equal(fileRow14166.scheduleStatusLabel, 'Per Activity');
  assert.equal(fileRow14166.financialPct, null);

  // Deactivation detection via wcaStage still works internally
  const deactViaWca = extractor.analyzeWorkRecord({
    fileId: '991',
    fileNumber: 'PWD/BLDG/FL/991/2026',
    components: [
      {
        componentLabel: 'General Electrical Work[EST/991]',
        wcaStage: 'Deactivated',
        bills: [],
      },
    ],
    projectDetails: comp1Pd,
  });
  assert.equal(deactViaWca.components[0].isDeactivated, true);

  // Ongoing Works table row badges isolate per-component bills, financial %, and due dates
  const w14166BadgeTest = {
    ...w14166Split,
    components: [
      w14166Split.components[0],
      {
        ...w14166Split.components[1],
        details: {
          ...comp2Pd,
          periodYears: 0,
          periodMonths: 1,
          periodDays: 0,
          periodText: '1 Month',
          shoDate: '25-08-2026',
        },
      },
    ],
  };
  const sum14166Badge = extractor.analyzeWorkRecord(w14166BadgeTest);
  const badgeHtml = overlay.renderWorkRowBadgesHtml(w14166BadgeTest, sum14166Badge, '01-09-2026');
  const [topProjectHtml, actLinesSection = ''] = badgeHtml.split('<div class="p3h-comp-status-lines">');
  const actLineHtmls = actLinesSection.split('<div class="p3h-comp-status-line">').slice(1);
  assert.equal(actLineHtmls.length, 2);

  assert.ok(topProjectHtml.includes('Partial Final (1/2)'));
  assert.ok(topProjectHtml.includes('Bill Details'));
  assert.equal(topProjectHtml.includes('Pending'), false);
  assert.equal(topProjectHtml.includes('3,14,452.00'), false);
  assert.equal(topProjectHtml.includes('89.8%'), false);
  assert.equal(topProjectHtml.includes('23-09-2026'), false);
  assert.equal(topProjectHtml.includes('24-09-2026'), false);

  assert.ok(actLineHtmls[0].includes('General Electrical Work: Final (1)'));
  assert.ok(actLineHtmls[0].includes('Pending'));
  assert.ok(actLineHtmls[0].includes('₹3,14,452.00 (89.8%)'));
  assert.equal(actLineHtmls[0].includes('24-09-2026'), false);

  assert.ok(actLineHtmls[1].includes('Electrical AC Work:'));
  assert.ok(actLineHtmls[1].includes('24-09-2026'));
  assert.equal(actLineHtmls[1].includes('Pending'), false);
  assert.equal(actLineHtmls[1].includes('3,14,452.00'), false);
  assert.equal(actLineHtmls[1].includes('23-09-2026'), false);

  // Pagination scroll reset: scrollWorksTableToTop blurs paginate focus, resets scrollBody, and scrolls to toolbar
  const origWin = globalThis.window;
  const origDoc = globalThis.document;
  try {
    let blurred = false;
    let scrolledArgs = null;
    const paginateBtn = {
      closest: (sel) => (sel === '.dataTables_paginate' ? {} : null),
      blur: () => {
        blurred = true;
      },
    };
    const scrollBody = {
      scrollTop: 420,
      scrollHeight: 1200,
      clientHeight: 400,
    };
    const toolbarEl = {
      parentElement: null,
      getBoundingClientRect: () => ({ top: -480 }),
    };
    const mockTable = {
      closest: (sel) => (sel === '.dataTables_scrollBody' ? scrollBody : null),
    };
    globalThis.document = {
      activeElement: paginateBtn,
      body: {},
      documentElement: {},
      getElementById: (id) => (id === 'p3h-toolbar' ? toolbarEl : null),
    };
    globalThis.window = {
      scrollY: 1000,
      getComputedStyle: () => ({ overflowY: 'visible' }),
      scrollTo: (opts) => {
        scrolledArgs = opts;
      },
    };
    overlay.scrollWorksTableToTop(mockTable);
    assert.equal(blurred, true);
    assert.equal(scrollBody.scrollTop, 0);
    assert.deepEqual(scrolledArgs, { top: 508, behavior: 'auto' });
  } finally {
    if (origWin === undefined) delete globalThis.window;
    else globalThis.window = origWin;
    if (origDoc === undefined) delete globalThis.document;
    else globalThis.document = origDoc;
  }

  // page-bridge.js emits p3h:dt:draw with pageChanged: true after page.dt -> draw.dt, and false on plain draw.dt
  const vm = require('node:vm');
  const bridgeListeners = {};
  const dispatchedEvents = [];
  const jqHandlers = {};
  const mockTableNode = { id: 'pt-file_table_list' };
  const mockDt = {
    rows: () => ({ nodes: () => ({ each: () => {} }) }),
  };
  const bridgeSandbox = {
    Symbol,
    Set,
    WeakMap,
    Array,
    JSON,
    String,
    Boolean,
    Number,
    Error,
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    document: {
      querySelector: (sel) => (sel === '#pt-file_table_list' ? mockTableNode : null),
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener: (name, fn) => {
        bridgeListeners[name] = fn;
      },
      dispatchEvent: (ev) => {
        dispatchedEvents.push(ev);
      },
    },
    window: {},
  };
  const jqFn = (el) => ({
    DataTable: () => mockDt,
    off: () => jqFn(el),
    on: (evName, fn) => {
      jqHandlers[evName] = fn;
      return jqFn(el);
    },
  });
  jqFn.fn = {
    dataTable: {
      isDataTable: () => true,
      ext: { search: [] },
    },
  };
  bridgeSandbox.window.jQuery = jqFn;
  vm.createContext(bridgeSandbox);
  vm.runInContext(fs.readFileSync(path.join(extDir, 'page-bridge.js'), 'utf8'), bridgeSandbox, {
    filename: 'page-bridge.js',
  });
  bridgeListeners['p3h:bridge:req']({
    detail: JSON.stringify({ id: 'b1', action: 'dt:ensure', payload: { selector: '#pt-file_table_list' } }),
  });
  const res1 = dispatchedEvents.find((e) => e.type === 'p3h:bridge:res');
  assert.ok(res1);
  assert.equal(JSON.parse(res1.detail).result.newlyBound, true);

  dispatchedEvents.length = 0;
  bridgeListeners['p3h:bridge:req']({
    detail: JSON.stringify({ id: 'b2', action: 'dt:ensure', payload: { selector: '#pt-file_table_list' } }),
  });
  const res2 = dispatchedEvents.find((e) => e.type === 'p3h:bridge:res');
  assert.ok(res2);
  assert.equal(JSON.parse(res2.detail).result.newlyBound, false);

  dispatchedEvents.length = 0;

  jqHandlers['page.dt.p3h']();
  jqHandlers['draw.dt.p3h']();
  const drawEv1 = dispatchedEvents.find((e) => e.type === 'p3h:dt:draw');
  assert.ok(drawEv1);
  assert.equal(JSON.parse(drawEv1.detail).pageChanged, true);

  dispatchedEvents.length = 0;
  jqHandlers['draw.dt.p3h']();
  const drawEv2 = dispatchedEvents.find((e) => e.type === 'p3h:dt:draw');
  assert.ok(drawEv2);
  assert.equal(JSON.parse(drawEv2.detail).pageChanged, false);
}

console.log('ALL_P3H_V2_UNIT_TESTS_PASSED');
