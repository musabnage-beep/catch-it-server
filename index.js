const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
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

// ============ MongoDB Connection ============
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/catch_it';

mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => {
    console.error('MongoDB connection error:', err);
    process.exit(1);
  });

// ============ Mongoose Schemas ============
const counterSchema = new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 }
});
const Counter = mongoose.model('Counter', counterSchema);

async function getNextId(name) {
  const counter = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return counter.seq;
}

const userSchema = new mongoose.Schema({
  id: { type: Number, unique: true },
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  role: { type: String, required: true },
  full_name: String,
  created_at: { type: String, default: () => new Date().toISOString() }
});
userSchema.pre('save', async function(next) {
  if (!this.id) this.id = await getNextId('users');
  next();
});
const User = mongoose.model('User', userSchema);

const plateSchema = new mongoose.Schema({
  id: { type: Number, unique: true },
  plate_number: { type: String, unique: true, required: true },
  letters_arabic: String,
  letters_english: { type: String, required: true },
  numbers: { type: String, required: true },
  notes: String,
  organization: String,
  created_at: { type: String, default: () => new Date().toISOString() }
});
plateSchema.pre('save', async function(next) {
  if (!this.id) this.id = await getNextId('plates');
  next();
});
plateSchema.index({ plate_number: 1 });
const Plate = mongoose.model('Plate', plateSchema);

const scanSessionSchema = new mongoose.Schema({
  id: { type: Number, unique: true },
  user_id: { type: Number, required: true },
  user_name: String,
  start_time: { type: String, required: true },
  end_time: String,
  start_location: String,
  end_location: String,
  start_lat: Number,
  start_lng: Number,
  end_lat: Number,
  end_lng: Number,
  total_scanned: { type: Number, default: 0 },
  total_matched: { type: Number, default: 0 }
});
scanSessionSchema.pre('save', async function(next) {
  if (!this.id) this.id = await getNextId('scan_sessions');
  next();
});
const ScanSession = mongoose.model('ScanSession', scanSessionSchema);

const scanResultSchema = new mongoose.Schema({
  id: { type: Number, unique: true },
  session_id: { type: Number, required: true },
  plate_number: { type: String, required: true },
  is_matched: { type: Number, default: 0 },
  scanned_at: { type: String, required: true },
  latitude: Number,
  longitude: Number,
  location_name: String,
  confidence: { type: Number, default: 0.0 }
});
scanResultSchema.pre('save', async function(next) {
  if (!this.id) this.id = await getNextId('scan_results');
  next();
});
scanResultSchema.index({ session_id: 1 });
const ScanResult = mongoose.model('ScanResult', scanResultSchema);

// ============ Seed Default Users ============
async function seedDefaults() {
  const adminExists = await User.findOne({ username: 'admin' });
  if (!adminExists) {
    await new User({ username: 'admin', password: 'admin123', role: 'admin', full_name: 'Administrator' }).save();
  }
  const empExists = await User.findOne({ username: 'employee' });
  if (!empExists) {
    await new User({ username: 'employee', password: 'emp123', role: 'employee', full_name: 'Employee' }).save();
  }
  console.log('Default users ready');
}

// ============ Saudi Plate Helpers ============
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
    // REVERSE letters: Arabic RTL reading order → English LTR plate order
    const reversedLetters = letters.split('').reverse().join('');
    return { numbers, letters: reversedLetters, plateNumber: `${numbers} ${reversedLetters}` };
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

// Helper: convert Mongoose doc to plain object with 'id' field (like SQLite)
function toPlain(doc) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  delete obj._id;
  delete obj.__v;
  return obj;
}

function toPlainArray(docs) {
  return docs.map(d => toPlain(d));
}

// ============ AUTH Routes ============
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    res.json({ id: user.id, username: user.username, role: user.role, fullName: user.full_name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find({}, 'id username role full_name created_at');
    res.json(toPlainArray(users));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const { username, password, role, fullName } = req.body;
    const user = new User({ username, password, role, full_name: fullName });
    await user.save();
    res.json({ id: user.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const user = await User.findOne({ id });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.username === 'admin') {
      return res.status(403).json({ error: 'Cannot delete the default admin user' });
    }
    await User.deleteOne({ id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ PLATES Routes ============
app.get('/api/plates', async (req, res) => {
  try {
    const plates = await Plate.find({}).sort({ created_at: -1 });
    res.json(toPlainArray(plates));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/plates/count', async (req, res) => {
  try {
    const count = await Plate.countDocuments({});
    res.json({ count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/plates/normalized', async (req, res) => {
  try {
    const plates = await Plate.find({}, 'plate_number');
    const normalized = plates.map(p => normalizePlate(p.plate_number));
    res.json(normalized);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/plates', async (req, res) => {
  try {
    const { plateNumber, lettersArabic, lettersEnglish, numbers, notes, organization } = req.body;
    const existing = await Plate.findOne({ plate_number: plateNumber });
    if (existing) return res.status(409).json({ error: 'Plate already exists' });

    const plate = new Plate({
      plate_number: plateNumber,
      letters_arabic: lettersArabic || null,
      letters_english: lettersEnglish,
      numbers,
      notes: notes || null,
      organization: organization || null
    });
    await plate.save();
    res.json({ id: plate.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/plates/bulk', async (req, res) => {
  try {
    const { plates } = req.body;
    let count = 0;
    for (const p of plates) {
      try {
        const existing = await Plate.findOne({ plate_number: p.plateNumber });
        if (existing) continue;
        const plate = new Plate({
          plate_number: p.plateNumber,
          letters_arabic: p.lettersArabic || null,
          letters_english: p.lettersEnglish,
          numbers: p.numbers,
          notes: p.notes || null,
          organization: p.organization || null
        });
        await plate.save();
        count++;
      } catch (_) { /* skip duplicates */ }
    }
    res.json({ imported: count, total: plates.length, duplicates: plates.length - count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Detect which column index in the header row contains "organization" / "مؤسسة"
function findOrganizationColumn(headerRow) {
  if (!headerRow) return -1;
  const keywords = ['مؤسسة', 'المؤسسة', 'organization', 'company', 'الشركة', 'شركة', 'الجهة', 'جهة'];
  for (let i = 0; i < headerRow.length; i++) {
    const v = headerRow[i];
    if (!v) continue;
    const txt = v.toString().trim().toLowerCase();
    if (keywords.some(k => txt.includes(k.toLowerCase()))) return i;
  }
  return -1;
}

app.post('/api/plates/import-excel', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const workbook = XLSX.readFile(req.file.path);
    const plates = [];
    const seen = new Set();

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

      // Detect organization column from header row (first row), if present
      const orgColIndex = rows.length > 0 ? findOrganizationColumn(rows[0]) : -1;

      for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        if (!row || row.length === 0) continue;
        // Skip the header row itself (we won't try to parse a plate from it)
        if (rowIdx === 0 && orgColIndex !== -1) continue;

        let found = null;
        for (let cIdx = 0; cIdx < row.length; cIdx++) {
          if (cIdx === orgColIndex) continue; // skip org column
          const cell = row[cIdx];
          if (!cell) continue;
          found = parsePlateFromExcelCell(cell.toString());
          if (found) break;
        }

        if (!found && row.length >= 2) {
          let numbers = null, letters = null;
          for (let cIdx = 0; cIdx < row.length; cIdx++) {
            if (cIdx === orgColIndex) continue; // skip org column
            const cell = row[cIdx];
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
            // Extract organization value from designated column for this row
            let organization = null;
            if (orgColIndex !== -1 && row[orgColIndex]) {
              const v = row[orgColIndex].toString().trim();
              if (v) organization = v;
            }
            plates.push({
              ...found,
              lettersArabic: getArabicLetters(found.letters),
              lettersEnglish: found.letters,
              organization,
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
      try {
        const existing = await Plate.findOne({ plate_number: p.plateNumber });
        if (existing) continue;
        const plate = new Plate({
          plate_number: p.plateNumber,
          letters_arabic: p.lettersArabic,
          letters_english: p.lettersEnglish,
          numbers: p.numbers,
          notes: null,
          organization: p.organization || null
        });
        await plate.save();
        count++;
      } catch (_) { /* skip duplicates */ }
    }

    res.json({ imported: count, total: plates.length, duplicates: plates.length - count });
  } catch (e) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch(_) {}
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/plates/:id', async (req, res) => {
  try {
    const result = await Plate.deleteOne({ id: Number(req.params.id) });
    res.json({ deleted: result.deletedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/plates', async (req, res) => {
  try {
    const result = await Plate.deleteMany({});
    res.json({ deleted: result.deletedCount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/plates/check/:plateNumber', async (req, res) => {
  try {
    const normalized = normalizePlate(req.params.plateNumber);
    const plates = await Plate.find({}, 'plate_number');
    const exists = plates.some(p => normalizePlate(p.plate_number) === normalized);
    res.json({ exists });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ SCAN SESSION Routes ============
app.post('/api/sessions', async (req, res) => {
  try {
    const s = req.body;
    const session = new ScanSession({
      user_id: s.userId,
      user_name: s.userName,
      start_time: s.startTime,
      end_time: s.endTime || null,
      start_location: s.startLocation || null,
      end_location: s.endLocation || null,
      start_lat: s.startLat || null,
      start_lng: s.startLng || null,
      end_lat: s.endLat || null,
      end_lng: s.endLng || null,
      total_scanned: s.totalScanned || 0,
      total_matched: s.totalMatched || 0
    });
    await session.save();
    res.json({ id: session.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/sessions/:id', async (req, res) => {
  try {
    const s = req.body;
    await ScanSession.updateOne({ id: Number(req.params.id) }, {
      end_time: s.endTime,
      end_location: s.endLocation || null,
      end_lat: s.endLat || null,
      end_lng: s.endLng || null,
      total_scanned: s.totalScanned || 0,
      total_matched: s.totalMatched || 0
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await ScanSession.find({}).sort({ start_time: -1 });
    res.json(toPlainArray(sessions));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sessions/:id', async (req, res) => {
  try {
    const session = await ScanSession.findOne({ id: Number(req.params.id) });
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(toPlain(session));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ SCAN RESULT Routes ============
app.post('/api/scan-results', async (req, res) => {
  try {
    const r = req.body;
    const result = new ScanResult({
      session_id: r.sessionId,
      plate_number: r.plateNumber,
      is_matched: r.isMatched ? 1 : 0,
      scanned_at: r.scannedAt,
      latitude: r.latitude || null,
      longitude: r.longitude || null,
      location_name: r.locationName || null,
      confidence: r.confidence || 0.0
    });
    await result.save();
    res.json({ id: result.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/scan-results/bulk', async (req, res) => {
  try {
    const { results } = req.body;
    for (const r of results) {
      const result = new ScanResult({
        session_id: r.sessionId,
        plate_number: r.plateNumber,
        is_matched: r.isMatched ? 1 : 0,
        scanned_at: r.scannedAt,
        latitude: r.latitude || null,
        longitude: r.longitude || null,
        location_name: r.locationName || null,
        confidence: r.confidence || 0.0
      });
      await result.save();
    }
    res.json({ inserted: results.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/scan-results/:sessionId', async (req, res) => {
  try {
    const results = await ScanResult.find({ session_id: Number(req.params.sessionId) }).sort({ scanned_at: -1 });
    res.json(toPlainArray(results));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ STATS Routes ============
app.get('/api/stats', async (req, res) => {
  try {
    const totalPlates = await Plate.countDocuments({});
    const totalSessions = await ScanSession.countDocuments({});
    const totalScanned = await ScanResult.countDocuments({});
    const totalMatched = await ScanResult.countDocuments({ is_matched: 1 });
    res.json({ totalPlates, totalSessions, totalScanned, totalMatched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============ SYNC Route ============
app.get('/api/sync', async (req, res) => {
  try {
    const plates = await Plate.find({});
    const plainPlates = toPlainArray(plates);
    const normalizedSet = plainPlates.map(p => normalizePlate(p.plate_number));
    res.json({
      plates: plainPlates,
      normalizedPlateNumbers: normalizedSet,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', timestamp: new Date().toISOString() });
});

// Ensure uploads dir exists
if (!fs.existsSync(path.join(__dirname, 'uploads'))) fs.mkdirSync(path.join(__dirname, 'uploads'));

// Start server after DB connection
mongoose.connection.once('open', async () => {
  await seedDefaults();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`CATCH IT Server running on port ${PORT}`);
    console.log(`http://localhost:${PORT}`);
    console.log('Connected to MongoDB Atlas');
  });
});
