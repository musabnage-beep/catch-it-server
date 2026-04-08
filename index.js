const express = require('express');
const cors = require('cors');
const initSqlJs = require('sql.js');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Multer for file uploads
const upload = multer({ dest: 'uploads/' });

// Database setup
const dbPath = path.join(__dirname, 'catch_it.db');
let db;

// Helper: save database to file
function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

// Helper: run query and return changes/lastID
function dbRun(sql, params = []) {
  db.run(sql, params);
  const lastId = db.exec("SELECT last_insert_rowid()")[0]?.values[0][0] || 0;
  const changes = db.getRowsModified();
  return { lastInsertRowid: lastId, changes };
}

// Helper: get one row
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

// Helper: get all rows
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

async function initDatabase() {
  const SQL = await initSqlJs();

  // Load existing database or create new
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL,
      full_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS plates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plate_number TEXT UNIQUE NOT NULL,
      letters_arabic TEXT,
      letters_english TEXT NOT NULL,
      numbers TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scan_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      user_name TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT,
      start_location TEXT,
      end_location TEXT,
      start_lat REAL,
      start_lng REAL,
      end_lat REAL,
      end_lng REAL,
      total_scanned INTEGER DEFAULT 0,
      total_matched INTEGER DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scan_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      plate_number TEXT NOT NULL,
      is_matched INTEGER NOT NULL DEFAULT 0,
      scanned_at TEXT NOT NULL,
      latitude REAL,
      longitude REAL,
      location_name TEXT,
      confidence REAL DEFAULT 0.0,
      FOREIGN KEY (session_id) REFERENCES scan_sessions(id)
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_plates_number ON plates(plate_number)');
  db.run('CREATE INDEX IF NOT EXISTS idx_scan_results_session ON scan_results(session_id)');

  // Insert default users
  const existingAdmin = dbGet('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!existingAdmin) {
    dbRun("INSERT INTO users (username, password, role, full_name, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ['admin', 'admin123', 'admin', 'Administrator']);
  }
  const existingEmployee = dbGet('SELECT id FROM users WHERE username = ?', ['employee']);
  if (!existingEmployee) {
    dbRun("INSERT INTO users (username, password, role, full_name, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      ['employee', 'emp123', 'employee', 'Employee']);
  }

  saveDb();
  console.log('Database initialized');
}

// Saudi plate letter mappings
const arabicToEnglish = {
  'ا': 'A', 'أ': 'A', 'إ': 'A', 'آ': 'A',
  'ب': 'B', 'ح': 'J', 'د': 'D', 'ر': 'R',
  'س': 'S', 'ص': 'X', 'ط': 'T', 'ع': 'E',
  'ق': 'G', 'ك': 'K', 'ل': 'L', 'م': 'Z',
  'ن': 'N', 'ه': 'H', 'و': 'U', 'ي': 'V',
};

const validPlateLetters = ['A','B','D','E','G','H','J','K','L','N','R','S','T','U','V','X','Z'];

function normalizePlate(plateNumber) {
  return plateNumber.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function areValidPlateLetters(letters) {
  if (!letters || letters.length === 0 || letters.length > 3) return false;
  for (const c of letters.toUpperCase().split('')) {
    if (!validPlateLetters.includes(c)) return false;
  }
  return true;
}

function convertArabicDigits(text) {
  const map = { '٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9' };
  let result = text;
  for (const [ar, en] of Object.entries(map)) {
    result = result.split(ar).join(en);
  }
  return result;
}

function parsePlateFromExcelCell(value) {
  value = convertArabicDigits(value.toString().trim());
  const cleaned = value.replace(/[^\w\s\u0621-\u064A]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;

  let letters = '';
  let numbers = '';
  for (const char of cleaned.split('')) {
    if (arabicToEnglish[char]) {
      if (letters.length < 3) letters += arabicToEnglish[char];
    } else if (/\d/.test(char)) {
      if (numbers.length < 4) numbers += char;
    }
  }
  if (numbers.length >= 1 && numbers.length <= 4 && letters.length >= 1 && letters.length <= 3 && areValidPlateLetters(letters)) {
    return { numbers, letters, plateNumber: `${numbers} ${letters}` };
  }

  const upper = cleaned.toUpperCase();
  const match1 = upper.match(/^(\d{1,4})\s*([A-Z]{1,3})$/);
  if (match1 && areValidPlateLetters(match1[2])) {
    return { numbers: match1[1], letters: match1[2], plateNumber: `${match1[1]} ${match1[2]}` };
  }
  const match2 = upper.match(/^([A-Z]{1,3})\s*(\d{1,4})$/);
  if (match2 && areValidPlateLetters(match2[1])) {
    return { numbers: match2[2], letters: match2[1], plateNumber: `${match2[2]} ${match2[1]}` };
  }

  const match3 = upper.match(/^(\d{1,4})\s+([A-Z])\s+([A-Z])\s+([A-Z])$/);
  if (match3) {
    const lt = match3[2] + match3[3] + match3[4];
    if (areValidPlateLetters(lt)) {
      return { numbers: match3[1], letters: lt, plateNumber: `${match3[1]} ${lt}` };
    }
  }
  const match4 = upper.match(/^([A-Z])\s+([A-Z])\s+([A-Z])\s+(\d{1,4})$/);
  if (match4) {
    const lt = match4[1] + match4[2] + match4[3];
    if (areValidPlateLetters(lt)) {
      return { numbers: match4[4], letters: lt, plateNumber: `${match4[4]} ${lt}` };
    }
  }

  return null;
}

const englishToArabic = {
  'A': 'ا', 'B': 'ب', 'J': 'ح', 'D': 'د',
  'R': 'ر', 'S': 'س', 'X': 'ص', 'T': 'ط',
  'E': 'ع', 'G': 'ق', 'K': 'ك', 'L': 'ل',
  'Z': 'م', 'N': 'ن', 'H': 'ه', 'U': 'و',
  'V': 'ي',
};

function getArabicLetters(englishLetters) {
  let arabic = '';
  for (const c of englishLetters.split('')) {
    if (englishToArabic[c]) arabic += englishToArabic[c];
  }
  return arabic || null;
}

// ============ AUTH Routes ============
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = dbGet('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ id: user.id, username: user.username, role: user.role, fullName: user.full_name });
});

app.get('/api/users', (req, res) => {
  const users = dbAll('SELECT id, username, role, full_name, created_at FROM users');
  res.json(users);
});

app.post('/api/users', (req, res) => {
  const { username, password, role, fullName } = req.body;
  try {
    const result = dbRun(
      "INSERT INTO users (username, password, role, full_name, created_at) VALUES (?, ?, ?, ?, datetime('now'))",
      [username, password, role, fullName]
    );
    saveDb();
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============ PLATES Routes ============
app.get('/api/plates', (req, res) => {
  const plates = dbAll('SELECT * FROM plates ORDER BY created_at DESC');
  res.json(plates);
});

app.get('/api/plates/count', (req, res) => {
  const result = dbGet('SELECT COUNT(*) as count FROM plates');
  res.json({ count: result ? result.count : 0 });
});

app.get('/api/plates/normalized', (req, res) => {
  const plates = dbAll('SELECT plate_number FROM plates');
  const normalized = plates.map(p => normalizePlate(p.plate_number));
  res.json(normalized);
});

app.post('/api/plates', (req, res) => {
  const { plateNumber, lettersArabic, lettersEnglish, numbers, notes } = req.body;
  try {
    const result = dbRun(
      "INSERT OR IGNORE INTO plates (plate_number, letters_arabic, letters_english, numbers, notes, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
      [plateNumber, lettersArabic || null, lettersEnglish, numbers, notes || null]
    );
    if (result.changes === 0) {
      return res.status(409).json({ error: 'Plate already exists' });
    }
    saveDb();
    res.json({ id: result.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/plates/bulk', (req, res) => {
  const { plates } = req.body;
  let count = 0;
  for (const p of plates) {
    const result = dbRun(
      "INSERT OR IGNORE INTO plates (plate_number, letters_arabic, letters_english, numbers, notes, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
      [p.plateNumber, p.lettersArabic || null, p.lettersEnglish, p.numbers, p.notes || null]
    );
    if (result.changes > 0) count++;
  }
  saveDb();
  res.json({ imported: count, total: plates.length, duplicates: plates.length - count });
});

app.post('/api/plates/import-excel', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = XLSX.readFile(req.file.path);
    const plates = [];
    const seen = new Set();

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      for (const row of rows) {
        if (!row || row.length === 0) continue;

        let found = null;
        for (const cell of row) {
          if (!cell) continue;
          found = parsePlateFromExcelCell(cell.toString());
          if (found) break;
        }

        if (!found && row.length >= 2) {
          let numbers = null, letters = null;
          for (const cell of row) {
            if (!cell) continue;
            const val = convertArabicDigits(cell.toString().trim());
            if (!numbers && /^\d{1,4}$/.test(val)) { numbers = val; continue; }
            const upper = val.toUpperCase().replace(/\s+/g, '');
            if (!letters && /^[A-Z]{1,3}$/.test(upper) && areValidPlateLetters(upper)) { letters = upper; continue; }
            if (!letters) {
              let extracted = '';
              for (const char of val.split('')) {
                if (arabicToEnglish[char]) extracted += arabicToEnglish[char];
              }
              if (extracted.length > 0 && extracted.length <= 3 && areValidPlateLetters(extracted)) {
                letters = extracted;
              }
            }
          }
          if (numbers && letters) {
            found = { numbers, letters, plateNumber: `${numbers} ${letters}` };
          }
        }

        if (found) {
          const norm = normalizePlate(found.plateNumber);
          if (!seen.has(norm)) {
            seen.add(norm);
            plates.push({
              ...found,
              lettersArabic: getArabicLetters(found.letters),
              lettersEnglish: found.letters,
            });
          }
        }
      }
    }

    fs.unlinkSync(req.file.path);

    if (plates.length === 0) {
      return res.json({ imported: 0, total: 0, duplicates: 0 });
    }

    let count = 0;
    for (const p of plates) {
      const result = dbRun(
        "INSERT OR IGNORE INTO plates (plate_number, letters_arabic, letters_english, numbers, notes, created_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
        [p.plateNumber, p.lettersArabic, p.lettersEnglish, p.numbers, null]
      );
      if (result.changes > 0) count++;
    }
    saveDb();

    res.json({ imported: count, total: plates.length, duplicates: plates.length - count });
  } catch (e) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch(_) {}
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/plates/:id', (req, res) => {
  const result = dbRun('DELETE FROM plates WHERE id = ?', [Number(req.params.id)]);
  saveDb();
  res.json({ deleted: result.changes });
});

app.delete('/api/plates', (req, res) => {
  const result = dbRun('DELETE FROM plates');
  saveDb();
  res.json({ deleted: result.changes });
});

app.get('/api/plates/check/:plateNumber', (req, res) => {
  const normalized = normalizePlate(req.params.plateNumber);
  const result = dbGet(
    "SELECT id FROM plates WHERE REPLACE(UPPER(plate_number), ' ', '') = ?",
    [normalized]
  );
  res.json({ exists: !!result });
});

// ============ SCAN SESSION Routes ============
app.post('/api/sessions', (req, res) => {
  const s = req.body;
  const result = dbRun(
    'INSERT INTO scan_sessions (user_id, user_name, start_time, end_time, start_location, end_location, start_lat, start_lng, end_lat, end_lng, total_scanned, total_matched) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [s.userId, s.userName, s.startTime, s.endTime || null, s.startLocation || null, s.endLocation || null,
      s.startLat || null, s.startLng || null, s.endLat || null, s.endLng || null, s.totalScanned || 0, s.totalMatched || 0]
  );
  saveDb();
  res.json({ id: result.lastInsertRowid });
});

app.put('/api/sessions/:id', (req, res) => {
  const s = req.body;
  dbRun(
    'UPDATE scan_sessions SET end_time = ?, end_location = ?, end_lat = ?, end_lng = ?, total_scanned = ?, total_matched = ? WHERE id = ?',
    [s.endTime, s.endLocation || null, s.endLat || null, s.endLng || null, s.totalScanned || 0, s.totalMatched || 0, Number(req.params.id)]
  );
  saveDb();
  res.json({ success: true });
});

app.get('/api/sessions', (req, res) => {
  const sessions = dbAll('SELECT * FROM scan_sessions ORDER BY start_time DESC');
  res.json(sessions);
});

app.get('/api/sessions/:id', (req, res) => {
  const session = dbGet('SELECT * FROM scan_sessions WHERE id = ?', [Number(req.params.id)]);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json(session);
});

// ============ SCAN RESULT Routes ============
app.post('/api/scan-results', (req, res) => {
  const r = req.body;
  const result = dbRun(
    'INSERT INTO scan_results (session_id, plate_number, is_matched, scanned_at, latitude, longitude, location_name, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [r.sessionId, r.plateNumber, r.isMatched ? 1 : 0, r.scannedAt, r.latitude || null, r.longitude || null, r.locationName || null, r.confidence || 0.0]
  );
  saveDb();
  res.json({ id: result.lastInsertRowid });
});

app.post('/api/scan-results/bulk', (req, res) => {
  const { results } = req.body;
  for (const r of results) {
    dbRun(
      'INSERT INTO scan_results (session_id, plate_number, is_matched, scanned_at, latitude, longitude, location_name, confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [r.sessionId, r.plateNumber, r.isMatched ? 1 : 0, r.scannedAt, r.latitude || null, r.longitude || null, r.locationName || null, r.confidence || 0.0]
    );
  }
  saveDb();
  res.json({ inserted: results.length });
});

app.get('/api/scan-results/:sessionId', (req, res) => {
  const results = dbAll('SELECT * FROM scan_results WHERE session_id = ? ORDER BY scanned_at DESC', [Number(req.params.sessionId)]);
  res.json(results);
});

// ============ STATS Routes ============
app.get('/api/stats', (req, res) => {
  const plates = dbGet('SELECT COUNT(*) as count FROM plates');
  const sessions = dbGet('SELECT COUNT(*) as count FROM scan_sessions');
  const scanned = dbGet('SELECT COUNT(*) as count FROM scan_results');
  const matched = dbGet('SELECT COUNT(*) as count FROM scan_results WHERE is_matched = 1');
  res.json({
    totalPlates: plates ? plates.count : 0,
    totalSessions: sessions ? sessions.count : 0,
    totalScanned: scanned ? scanned.count : 0,
    totalMatched: matched ? matched.count : 0,
  });
});

// ============ SYNC Route ============
app.get('/api/sync', (req, res) => {
  const plates = dbAll('SELECT * FROM plates');
  const normalizedSet = plates.map(p => normalizePlate(p.plate_number));
  res.json({
    plates,
    normalizedPlateNumbers: normalizedSet,
    timestamp: new Date().toISOString(),
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Ensure uploads dir exists
if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'));

// Initialize database and start server
initDatabase().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CATCH IT Server running on port ${PORT}`);
    console.log(`http://localhost:${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
