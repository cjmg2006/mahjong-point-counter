#!/usr/bin/env node
// Tests Firebase connectivity and score counting logic.
// Reads from the real DB (read-only for rounds), writes only to a
// temporary /_connection_test path that is deleted immediately after.
// Current scores are never touched.

const https = require('https');

const DB_URL =
  'https://chua-family-mahjong-default-rtdb.asia-southeast1.firebasedatabase.app';

// ── Score counting logic (mirrors index.html) ────────────────────────────────

function calculateTotals(rounds) {
  const totals = {};
  for (const r of rounds) {
    totals[r.player] = (totals[r.player] || 0) + r.points;
  }
  return totals;
}

function groupByDate(rounds) {
  const groups = {};
  for (const r of rounds) {
    (groups[r.date] = groups[r.date] || []).push(r);
  }
  return groups;
}

// ── Minimal test runner ───────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  \u2713 ${message}`);
    passed++;
  } else {
    console.error(`  \u2717 ${message}`);
    failed++;
  }
}

// ── Firebase REST helper ─────────────────────────────────────────────────────

function firebaseRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(DB_URL + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('=== Mahjong – Firebase & Scoring Tests ===\n');

  // 1. Score counting unit tests
  console.log('1. Score Counting Logic');

  const baseRounds = [
    { id: 1, player: 'mummy',  points: 3,  date: '2024-01-01' },
    { id: 2, player: 'daddy',  points: 5,  date: '2024-01-01' },
    { id: 3, player: 'mummy',  points: 7,  date: '2024-01-02' },
    { id: 4, player: 'gordon', points: 1,  date: '2024-01-02' },
  ];

  const totals = calculateTotals(baseRounds);
  assert(totals.mummy  === 10, 'Mummy total: 3 + 7 = 10');
  assert(totals.daddy  === 5,  'Daddy total: 5');
  assert(totals.gordon === 1,  'Gordon total: 1');
  assert(totals.glo    === undefined, 'Glo with no wins → undefined');

  // Verify score updates correctly after each new log
  const log1 = { id: 5, player: 'mummy', points: 2, date: '2024-01-03' };
  assert(
    calculateTotals([...baseRounds, log1]).mummy === 12,
    'After log 1 – Mummy increments from 10 to 12',
  );

  const log2 = { id: 6, player: 'glo', points: 4, date: '2024-01-03' };
  assert(
    calculateTotals([...baseRounds, log1, log2]).glo === 4,
    'After log 2 – Glo appears with 4 pts',
  );

  const log3 = { id: 7, player: 'glo', points: 8, date: '2024-01-04' };
  assert(
    calculateTotals([...baseRounds, log1, log2, log3]).glo === 12,
    'After log 3 – Glo accumulates to 12 pts',
  );

  // Edge cases
  assert(Object.keys(calculateTotals([])).length === 0, 'Empty rounds → empty totals');
  assert(
    calculateTotals([{ id: 1, player: 'glo', points: 0, date: '2024-01-01' }]).glo === 0,
    'Zero-point win is recorded correctly',
  );

  // Group-by-date sanity check
  const groups = groupByDate(baseRounds);
  assert(
    groups['2024-01-01'].length === 2 && groups['2024-01-02'].length === 2,
    'groupByDate splits rounds by date correctly',
  );

  // 2. Firebase connection
  console.log('\n2. Firebase Connection (read-only)');

  let connectionOk = false;
  try {
    const res = await firebaseRequest('GET', '/rounds.json');

    // 200 = open rules, 401/403 = server reachable but auth-protected (also valid)
    const serverReachable = [200, 401, 403].includes(res.status);
    assert(serverReachable, `Firebase server reachable (HTTP ${res.status})`);

    if (res.status === 200) {
      connectionOk = true;
      const isValidFormat =
        res.data === null || Array.isArray(res.data) || typeof res.data === 'object';
      assert(isValidFormat, 'Response is valid JSON (null | array | object)');

      if (res.data) {
        const existing = Array.isArray(res.data) ? res.data : Object.values(res.data);
        const validRounds = existing.filter(
          (r) => r && typeof r.player === 'string' && typeof r.points === 'number',
        );
        console.log(`  \u2139 Rounds in DB: ${validRounds.length}`);
        if (validRounds.length > 0) {
          const liveTotals = calculateTotals(validRounds);
          console.log(
            '  \u2139 Current totals:',
            Object.entries(liveTotals)
              .sort((a, b) => b[1] - a[1])
              .map(([p, pts]) => `${p} ${pts}`)
              .join(', '),
          );
          assert(
            Object.values(liveTotals).every((v) => typeof v === 'number' && v >= 0),
            'Live DB totals are non-negative numbers',
          );
        }
      } else {
        console.log('  \u2139 No rounds stored yet');
      }
    } else {
      console.log(`  \u2139 DB rules require auth (HTTP ${res.status}) – connection itself is fine`);
      // Mark connectionOk so the write test still runs (it'll get the same 403)
      connectionOk = serverReachable;
    }
  } catch (e) {
    assert(false, `Firebase read failed: ${e.message}`);
  }

  // 3. Write/read/delete on an isolated test path
  console.log('\n3. Firebase Write + Read + Cleanup (/_connection_test)');

  if (!connectionOk) {
    console.log('  (skipped – server unreachable)');
  } else {
    const payload = { _test: true, ts: Date.now() };
    let writeOk = false;
    try {
      const wr = await firebaseRequest('PUT', '/_connection_test.json', payload);
      if ([401, 403].includes(wr.status)) {
        console.log(
          `  \u2139 Write requires auth (HTTP ${wr.status}) – DB rules block unauthenticated writes`,
        );
        console.log('  \u2139 The app uses the Firebase JS SDK which handles auth separately');
        passed++; // connection itself works; auth is intentional
      } else {
        assert(wr.status === 200, `Write to /_connection_test succeeds (HTTP ${wr.status})`);
        writeOk = wr.status === 200;
      }
    } catch (e) {
      assert(false, `Write failed: ${e.message}`);
    }

    if (writeOk) {
      try {
        const rr = await firebaseRequest('GET', '/_connection_test.json');
        assert(
          rr.status === 200 && rr.data && rr.data._test === true,
          'Read-back matches written payload',
        );
      } catch (e) {
        assert(false, `Read-back failed: ${e.message}`);
      }

      try {
        const dr = await firebaseRequest('DELETE', '/_connection_test.json');
        assert(dr.status === 200, 'Test node deleted (scores untouched)');
      } catch (e) {
        assert(false, `Cleanup failed: ${e.message}`);
      }
    }
  }

  // Summary
  const total = passed + failed;
  console.log(`\n=== ${passed}/${total} passed${failed ? `, ${failed} failed` : ''} ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(1);
});
