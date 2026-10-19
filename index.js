const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const createAdminRouter = require('./admin');

const app = express();

// Basic middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Mongoose Connection with global caching ---
let cached = globalThis.__mongoose_cached;
if (!cached) {
  cached = globalThis.__mongoose_cached = { conn: null, promise: null };
}

async function connectDB() {
  if (cached.conn && mongoose.connection.readyState === 1) {
    return cached.conn;
  }
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is not set');
  }
  if (!cached.promise) {
    cached.promise = mongoose
      .connect(process.env.MONGODB_URI, {
        bufferCommands: false,
      })
      .then(async (m) => {
        cached.conn = m;
        await seedDatabase();
        return m;
      })
      .catch((err) => {
        cached.promise = null;
        throw err;
      });
  }
  cached.conn = await cached.promise;
  return cached.conn;
}

// Database check middleware: returns 503 JSON if connection fails
async function dbMiddleware(req, res, next) {
  try {
    await connectDB();
    next();
  } catch (err) {
    return res.status(503).json({
      error: 'Database connection failed',
      message: err.message || 'Unable to connect to MongoDB cluster.',
    });
  }
}

// Apply dbMiddleware to API, admin, and main routes
app.use(dbMiddleware);

// --- Data Models ---

const serviceSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  durationMinutes: { type: Number, default: 30 },
  priceText: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
});

const dentistSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  qualification: { type: String, default: '' },
  specialty: { type: String, default: '' },
  photoUrl: { type: String, default: '' },
  workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] }, // 0 = Sunday, 1..6 = Mon..Sat
  isActive: { type: Boolean, default: true },
});

const appointmentSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  patientName: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
  phone: { type: String, required: true },
  email: { type: String, default: '' },
  age: { type: Number, default: null },
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service', required: true },
  dentistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dentist', required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  startTime: { type: String, required: true }, // HH:mm
  durationMinutes: { type: Number, required: true },
  notes: { type: String, default: '', maxlength: 500 },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'completed', 'cancelled', 'no-show'],
    default: 'pending',
  },
  consentGiven: { type: Boolean, required: true },
  createdAt: { type: Date, default: Date.now },
});

// Partial unique index to prevent duplicate non-cancelled bookings for same dentist, date and startTime
appointmentSchema.index(
  { dentistId: 1, date: 1, startTime: 1 },
  { unique: true, partialFilterExpression: { status: { $ne: 'cancelled' } } }
);

const settingsSchema = new mongoose.Schema({
  clinicName: { type: String, default: 'Dhuliyan Diagnostic & Health Care (DDH)' },
  legalName: { type: String, default: 'Dhuliyan Diagnostic & Health Care Private Limited' },
  tagline: { type: String, default: '' },
  phone: { type: String, default: '+91 77973 49196' },
  email: { type: String, default: '' },
  whatsapp: { type: String, default: '' },
  address: {
    type: String,
    default:
      'Old Dakbanglow, Dakbanglow Main Road, Dhuliyan, P.O. Ratan Pur Dhuliyan, P.S. Samserganj, Murshidabad, West Bengal 742202, India',
  },
  latitude: { type: Number, default: 24.660543 },
  longitude: { type: Number, default: 87.947218 },
  mapsLink: {
    type: String,
    default: 'https://www.google.com/maps/dir/?api=1&destination=24.660543%2C87.947218',
  },
  hours: [
    {
      day: Number, // 0 = Sunday, 1 = Monday, etc.
      dayName: String,
      open: String,
      close: String,
      isClosed: Boolean,
    },
  ],
  slotMinutes: { type: Number, default: 30 },
  minNoticeHours: { type: Number, default: 2 },
  bookingWindowDays: { type: Number, default: 30 },
  holidays: { type: [String], default: [] }, // Array of YYYY-MM-DD
});

const Service = mongoose.models.Service || mongoose.model('Service', serviceSchema);
const Dentist = mongoose.models.Dentist || mongoose.model('Dentist', dentistSchema);
const Appointment = mongoose.models.Appointment || mongoose.model('Appointment', appointmentSchema);
const Settings = mongoose.models.Settings || mongoose.model('Settings', settingsSchema);

// --- Idempotent Seeding ---
async function seedDatabase() {
  const serviceCount = await Service.countDocuments();
  if (serviceCount === 0) {
    const defaultServices = [
      { name: 'Dental checkup and consultation', durationMinutes: 30, priceText: '', sortOrder: 1 },
      { name: 'Teeth cleaning, scaling and polishing', durationMinutes: 45, priceText: '', sortOrder: 2 },
      { name: 'Tooth filling', durationMinutes: 45, priceText: '', sortOrder: 3 },
      { name: 'Root canal treatment', durationMinutes: 60, priceText: '', sortOrder: 4 },
      { name: 'Tooth extraction', durationMinutes: 45, priceText: '', sortOrder: 5 },
      { name: 'Teeth whitening', durationMinutes: 60, priceText: '', sortOrder: 6 },
      { name: 'Orthodontic (braces) consultation', durationMinutes: 30, priceText: '', sortOrder: 7 },
      { name: 'Dental implant consultation', durationMinutes: 30, priceText: '', sortOrder: 8 },
      { name: 'Children’s dental care', durationMinutes: 30, priceText: '', sortOrder: 9 },
      { name: 'Emergency dental care', durationMinutes: 30, priceText: '', sortOrder: 10 },
    ];
    await Service.insertMany(defaultServices);
  }

  const dentistCount = await Dentist.countDocuments();
  if (dentistCount === 0) {
    const defaultDentists = [
      {
        name: 'Dr. [Name to be provided]',
        qualification: '[To be provided]',
        specialty: '[To be provided]',
        workingDays: [1, 2, 3, 4, 5, 6],
        isActive: true,
      },
      {
        name: 'Dr. [Name to be provided]',
        qualification: '[To be provided]',
        specialty: '[To be provided]',
        workingDays: [1, 2, 3, 4, 5, 6],
        isActive: true,
      },
    ];
    await Dentist.insertMany(defaultDentists);
  }

  const settingsCount = await Settings.countDocuments();
  if (settingsCount === 0) {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const defaultHours = dayNames.map((name, idx) => ({
      day: idx,
      dayName: name,
      open: '10:00',
      close: '20:00',
      isClosed: idx === 0, // Sunday closed
    }));

    await Settings.create({
      clinicName: 'Dhuliyan Diagnostic & Health Care (DDH)',
      legalName: 'Dhuliyan Diagnostic & Health Care Private Limited',
      tagline: '',
      phone: '+91 77973 49196',
      email: '',
      whatsapp: '',
      address:
        'Old Dakbanglow, Dakbanglow Main Road, Dhuliyan, P.O. Ratan Pur Dhuliyan, P.S. Samserganj, Murshidabad, West Bengal 742202, India',
      latitude: 24.660543,
      longitude: 87.947218,
      mapsLink: 'https://www.google.com/maps/dir/?api=1&destination=24.660543%2C87.947218',
      hours: defaultHours,
      slotMinutes: 30,
      minNoticeHours: 2,
      bookingWindowDays: 30,
      holidays: [],
    });
  }
}

// --- Date & Time in Asia/Kolkata timezone helpers ---
function getKolkataNow() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 330 * 60000);
}

function getKolkataDateString(d = getKolkataNow()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getKolkataMinutesNow() {
  const d = getKolkataNow();
  return d.getHours() * 60 + d.getMinutes();
}

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function getDayOfWeek(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 is Sunday
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Reference generator: DDH-XXXXXX (excluding O, 0, I, 1)
function generateReference() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return `DDH-${code}`;
}

// --- Mount Admin Router ---
app.use('/admin', createAdminRouter({ Service, Dentist, Appointment, Settings }));

// --- Public API Endpoints ---

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

// GET /api/services - active services only
app.get('/api/services', async (req, res) => {
  try {
    const services = await Service.find({ isActive: true })
      .select('name description durationMinutes priceText sortOrder')
      .sort({ sortOrder: 1, name: 1 })
      .lean();
    res.json(services);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch services' });
  }
});

// GET /api/dentists - active dentists only
app.get('/api/dentists', async (req, res) => {
  try {
    const dentists = await Dentist.find({ isActive: true })
      .select('name qualification specialty photoUrl workingDays')
      .sort({ name: 1 })
      .lean();
    res.json(dentists);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch dentists' });
  }
});

// GET /api/availability?date=YYYY-MM-DD&dentistId=ID&serviceId=ID
app.get('/api/availability', async (req, res) => {
  try {
    const { date, dentistId, serviceId } = req.query;

    if (!date || !dentistId || !serviceId) {
      return res.status(400).json({ error: 'Missing required query parameters: date, dentistId, serviceId' });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format. Expected YYYY-MM-DD' });
    }

    const settings = await Settings.findOne().lean();
    const service = await Service.findById(serviceId).lean();
    const dentist = await Dentist.findById(dentistId).lean();

    if (!service || !service.isActive) {
      return res.status(404).json({ error: 'Selected service is inactive or not found' });
    }
    if (!dentist || !dentist.isActive) {
      return res.status(404).json({ error: 'Selected dentist is inactive or not found' });
    }

    const todayStr = getKolkataDateString();
    if (date < todayStr) {
      return res.json({ date, slots: [], error: 'Appointments cannot be booked for past dates.' });
    }

    // Booking window check
    const kolkataNow = getKolkataNow();
    const maxDate = new Date(kolkataNow);
    maxDate.setDate(kolkataNow.getDate() + (settings.bookingWindowDays || 30));
    const maxDateStr = getKolkataDateString(maxDate);

    if (date > maxDateStr) {
      return res.json({ date, slots: [], error: `Date is outside the ${settings.bookingWindowDays || 30}-day booking window.` });
    }

    // Holiday check
    if (settings.holidays && settings.holidays.includes(date)) {
      return res.json({ date, slots: [], error: 'Clinic is closed on this scheduled holiday.' });
    }

    // Weekday hours check
    const dow = getDayOfWeek(date);
    const dayHours = (settings.hours || []).find((h) => h.day === dow) || { isClosed: dow === 0, open: '10:00', close: '20:00' };

    if (dayHours.isClosed) {
      return res.json({ date, slots: [], error: 'Clinic is closed on this day of the week.' });
    }

    // Dentist working days check
    if (!dentist.workingDays || !dentist.workingDays.includes(dow)) {
      return res.json({ date, slots: [], error: 'Selected dentist does not work on this day.' });
    }

    const openMin = timeToMinutes(dayHours.open || '10:00');
    const closeMin = timeToMinutes(dayHours.close || '20:00');
    const slotStep = settings.slotMinutes || 30;
    const duration = service.durationMinutes || 30;

    // Fetch existing non-cancelled bookings for this dentist on this date
    const existing = await Appointment.find({
      dentistId,
      date,
      status: { $ne: 'cancelled' },
    })
      .select('startTime durationMinutes')
      .lean();

    const existingIntervals = existing.map((a) => {
      const s = timeToMinutes(a.startTime);
      return { start: s, end: s + a.durationMinutes };
    });

    const isToday = date === todayStr;
    const nowMins = getKolkataMinutesNow();
    const noticeMins = (settings.minNoticeHours != null ? settings.minNoticeHours : 2) * 60;
    const minAllowedStart = nowMins + noticeMins;

    const availableSlots = [];

    for (let slotStart = openMin; slotStart + duration <= closeMin; slotStart += slotStep) {
      // Notice requirement for today
      if (isToday && slotStart < minAllowedStart) {
        continue;
      }

      const slotEnd = slotStart + duration;

      // Overlap check with any non-cancelled appointment: [slotStart, slotEnd) vs [start, end)
      const hasOverlap = existingIntervals.some((appSlot) => {
        return slotStart < appSlot.end && slotEnd > appSlot.start;
      });

      if (!hasOverlap) {
        availableSlots.push(minutesToTime(slotStart));
      }
    }

    res.json({
      date,
      slotCount: availableSlots.length,
      slots: availableSlots,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to calculate slot availability', message: err.message });
  }
});

// Rate limit POST /api/appointments: 10 requests per 15 minutes per IP
const appointmentRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too many requests',
    message: 'Too many booking attempts from this network. Please wait a few minutes before trying again.',
  },
});

// POST /api/appointments - create a booking
app.post('/api/appointments', appointmentRateLimiter, async (req, res) => {
  try {
    const {
      patientName,
      phone,
      email,
      age,
      serviceId,
      dentistId,
      date,
      startTime,
      notes,
      consentGiven,
      website, // Honeypot field
    } = req.body;

    // Honeypot check: reject bots silently or with 400
    if (website) {
      return res.status(400).json({ error: 'Submission rejected' });
    }

    // Consent check
    if (consentGiven !== true && consentGiven !== 'true') {
      return res.status(400).json({ error: 'Patient consent must be provided to schedule an appointment.' });
    }

    // Name validation: 2-80 characters
    const cleanName = String(patientName || '').trim();
    if (cleanName.length < 2 || cleanName.length > 80) {
      return res.status(400).json({ error: 'Patient name must be between 2 and 80 characters.' });
    }

    // Phone validation: Indian mobile /^[6-9]\d{9}$/ after stripping spaces, dashes, +91, 0
    let cleanPhone = String(phone || '').replace(/[\s\-()]/g, '');
    if (cleanPhone.startsWith('+91')) {
      cleanPhone = cleanPhone.slice(3);
    } else if (cleanPhone.startsWith('91') && cleanPhone.length === 12) {
      cleanPhone = cleanPhone.slice(2);
    } else if (cleanPhone.startsWith('0') && cleanPhone.length === 11) {
      cleanPhone = cleanPhone.slice(1);
    }

    if (!/^[6-9]\d{9}$/.test(cleanPhone)) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit Indian mobile number.' });
    }
    const formattedPhone = `+91${cleanPhone}`;

    // Date & Time validation
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'Invalid date format.' });
    }
    if (!/^\d{2}:\d{2}$/.test(startTime)) {
      return res.status(400).json({ error: 'Invalid start time format.' });
    }

    const settings = await Settings.findOne().lean();
    const service = await Service.findById(serviceId).lean();
    const dentist = await Dentist.findById(dentistId).lean();

    if (!service || !service.isActive) {
      return res.status(400).json({ error: 'Selected service is inactive or not found.' });
    }
    if (!dentist || !dentist.isActive) {
      return res.status(400).json({ error: 'Selected dentist is inactive or not found.' });
    }

    const todayStr = getKolkataDateString();
    if (date < todayStr) {
      return res.status(400).json({ error: 'Appointments cannot be booked for past dates.' });
    }

    // Booking window check
    const kolkataNow = getKolkataNow();
    const maxDate = new Date(kolkataNow);
    maxDate.setDate(kolkataNow.getDate() + (settings.bookingWindowDays || 30));
    const maxDateStr = getKolkataDateString(maxDate);

    if (date > maxDateStr) {
      return res.status(400).json({ error: 'Booking date exceeds maximum advance booking window.' });
    }

    // Holiday check
    if (settings.holidays && settings.holidays.includes(date)) {
      return res.status(400).json({ error: 'Clinic is closed on this scheduled holiday.' });
    }

    // Weekday check
    const dow = getDayOfWeek(date);
    const dayHours = (settings.hours || []).find((h) => h.day === dow) || { isClosed: dow === 0, open: '10:00', close: '20:00' };

    if (dayHours.isClosed) {
      return res.status(400).json({ error: 'Clinic is closed on this day of the week.' });
    }

    if (!dentist.workingDays || !dentist.workingDays.includes(dow)) {
      return res.status(400).json({ error: 'Selected dentist is not available on this day.' });
    }

    const slotStartMin = timeToMinutes(startTime);
    const duration = service.durationMinutes || 30;
    const slotEndMin = slotStartMin + duration;
    const openMin = timeToMinutes(dayHours.open || '10:00');
    const closeMin = timeToMinutes(dayHours.close || '20:00');

    if (slotStartMin < openMin || slotEndMin > closeMin) {
      return res.status(400).json({ error: 'Requested appointment time is outside clinic working hours.' });
    }

    // Notice check for today
    if (date === todayStr) {
      const nowMins = getKolkataMinutesNow();
      const minNotice = (settings.minNoticeHours != null ? settings.minNoticeHours : 2) * 60;
      if (slotStartMin < nowMins + minNotice) {
        return res.status(400).json({ error: `Bookings require at least ${settings.minNoticeHours} hours advance notice.` });
      }
    }

    // Overlap check in code against existing active appointments
    const overlapping = await Appointment.find({
      dentistId,
      date,
      status: { $ne: 'cancelled' },
    })
      .select('startTime durationMinutes')
      .lean();

    const hasConflict = overlapping.some((a) => {
      const s = timeToMinutes(a.startTime);
      const e = s + a.durationMinutes;
      return slotStartMin < e && slotEndMin > s;
    });

    if (hasConflict) {
      return res.status(409).json({
        error: 'Slot already taken',
        message: 'This time slot is no longer available. Please select another time.',
      });
    }

    // Generate unique reference
    let reference = generateReference();
    let isUnique = false;
    let attempts = 0;
    while (!isUnique && attempts < 5) {
      const existingRef = await Appointment.findOne({ reference }).lean();
      if (!existingRef) {
        isUnique = true;
      } else {
        reference = generateReference();
        attempts++;
      }
    }

    const cleanNotes = String(notes || '').trim().slice(0, 500);
    const cleanEmail = String(email || '').trim();
    const cleanAge = age ? Number(age) : null;

    const appointment = new Appointment({
      reference,
      patientName: cleanName,
      phone: formattedPhone,
      email: cleanEmail,
      age: cleanAge,
      serviceId,
      dentistId,
      date,
      startTime,
      durationMinutes: duration,
      notes: cleanNotes,
      consentGiven: true,
      status: 'pending',
    });

    await appointment.save();

    res.status(201).json({
      success: true,
      reference: appointment.reference,
      message: 'Your dental appointment has been successfully scheduled! Please save your reference code.',
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        error: 'Slot already taken',
        message: 'This time slot was just booked by another patient. Please pick another available time slot.',
      });
    }
    res.status(500).json({ error: 'Failed to create appointment', message: err.message });
  }
});

// --- Server-Rendered Landing Page (GET /) ---
app.get('/', async (req, res) => {
  try {
    let settings = await Settings.findOne().lean();
    if (!settings) {
      settings = {
        clinicName: 'Dhuliyan Diagnostic & Health Care (DDH)',
        legalName: 'Dhuliyan Diagnostic & Health Care Private Limited',
        phone: '+91 77973 49196',
        email: '',
        address:
          'Old Dakbanglow, Dakbanglow Main Road, Dhuliyan, P.O. Ratan Pur Dhuliyan, P.S. Samserganj, Murshidabad, West Bengal 742202, India',
        latitude: 24.660543,
        longitude: 87.947218,
        mapsLink: 'https://www.google.com/maps/dir/?api=1&destination=24.660543%2C87.947218',
        hours: [
          { day: 0, dayName: 'Sunday', open: '10:00', close: '20:00', isClosed: true },
          { day: 1, dayName: 'Monday', open: '10:00', close: '20:00', isClosed: false },
          { day: 2, dayName: 'Tuesday', open: '10:00', close: '20:00', isClosed: false },
          { day: 3, dayName: 'Wednesday', open: '10:00', close: '20:00', isClosed: false },
          { day: 4, dayName: 'Thursday', open: '10:00', close: '20:00', isClosed: false },
          { day: 5, dayName: 'Friday', open: '10:00', close: '20:00', isClosed: false },
          { day: 6, dayName: 'Saturday', open: '10:00', close: '20:00', isClosed: false },
        ],
      };
    }

    const [services, dentists] = await Promise.all([
      Service.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).lean(),
      Dentist.find({ isActive: true }).sort({ name: 1 }).lean(),
    ]);

    const clinicPhone = settings.phone || '+91 77973 49196';
    const cleanPhoneDigits = clinicPhone.replace(/[^0-9+]/g, '');
    const currentYear = new Date().getFullYear();

    // Compute display hours string
    const monHours = (settings.hours || []).find((h) => h.day === 1);
    const satHours = (settings.hours || []).find((h) => h.day === 6);
    const sunHours = (settings.hours || []).find((h) => h.day === 0);
    const hoursSummary =
      monHours && !monHours.isClosed
        ? `Mon–Sat: ${monHours.open}–${monHours.close} (Sun: ${sunHours?.isClosed ? 'Closed' : 'Open'})`
        : 'Mon–Sat: 10:00–20:00, Sun: Closed';

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dental Appointment Booking - ${escapeHtml(settings.clinicName)}</title>
  <meta name="description" content="Book your dental appointment online at ${escapeHtml(settings.clinicName)}. Simple, friendly dental care in Dhuliyan.">
  
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;600;700;800&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">

  <style>
    :root {
      --mint: #A8E6CF;
      --peach: #FFD3B6;
      --lavender: #C7B8F5;
      --sky: #BDE0FE;
      --butter: #FFF1B5;
      --rose: #FFC6D9;
      --text: #2D3A4A;
      --bg: #F7F4FF;
      --clay-shadow: 14px 14px 28px rgba(60,50,90,0.12), -10px -10px 24px rgba(255,255,255,0.9), inset 6px 6px 12px rgba(255,255,255,0.7), inset -6px -6px 12px rgba(60,50,90,0.08);
      --clay-btn: 6px 6px 16px rgba(60,50,90,0.14), -6px -6px 14px rgba(255,255,255,0.95), inset 3px 3px 6px rgba(255,255,255,0.8), inset -3px -3px 6px rgba(60,50,90,0.08);
      --glass-bg: rgba(255,255,255,0.45);
      --glass-border: 1px solid rgba(255,255,255,0.6);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: 'Nunito', sans-serif;
      background: linear-gradient(135deg, #F7F4FF 0%, #EEF9FF 100%);
      color: var(--text);
      line-height: 1.6;
      min-height: 100vh;
      overflow-x: hidden;
    }

    h1, h2, h3, h4, .brand-font {
      font-family: 'Baloo 2', cursive, sans-serif;
      line-height: 1.25;
      color: var(--text);
    }

    /* Accessibility focus rings */
    a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: 3px solid #7C3AED;
      outline-offset: 3px;
    }

    /* Glass Navbar */
    .navbar {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(255, 255, 255, 0.45);
      backdrop-filter: blur(16px) saturate(160%);
      -webkit-backdrop-filter: blur(16px) saturate(160%);
      border-bottom: 1px solid rgba(255, 255, 255, 0.6);
      transition: all 0.3s ease;
      padding: 0.85rem 1.5rem;
    }
    .navbar.scrolled {
      background: rgba(255, 255, 255, 0.85);
      box-shadow: 0 10px 25px rgba(60,50,90,0.08);
    }
    .nav-inner {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 1rem;
    }
    .badge-logo {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      text-decoration: none;
      background: linear-gradient(135deg, var(--mint), var(--sky));
      padding: 0.45rem 1.1rem;
      border-radius: 24px;
      box-shadow: var(--clay-btn);
      font-family: 'Baloo 2', cursive;
      font-size: 1.35rem;
      font-weight: 800;
      color: var(--text);
    }
    .badge-logo span.sub {
      font-size: 0.85rem;
      font-family: 'Nunito', sans-serif;
      font-weight: 700;
      opacity: 0.85;
    }
    .nav-menu {
      display: flex;
      align-items: center;
      gap: 1.5rem;
      list-style: none;
    }
    .nav-link {
      text-decoration: none;
      color: var(--text);
      font-weight: 700;
      font-size: 1rem;
      transition: color 0.2s, transform 0.2s;
    }
    .nav-link:hover {
      color: #5B45BA;
      transform: translateY(-1px);
    }
    .btn-call-nav {
      background: linear-gradient(135deg, var(--peach), var(--butter));
      padding: 0.5rem 1.25rem;
      border-radius: 24px;
      text-decoration: none;
      color: var(--text);
      font-weight: 800;
      font-size: 0.95rem;
      box-shadow: var(--clay-btn);
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      transition: transform 0.2s;
    }
    .btn-call-nav:hover {
      transform: translateY(-2px);
    }

    /* Clay Cards and Buttons */
    .clay-card {
      background: rgba(255,255,255,0.72);
      border-radius: 32px;
      padding: 2.25rem;
      box-shadow: var(--clay-shadow);
      border: 1px solid rgba(255,255,255,0.7);
      transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease;
    }
    .clay-card.interactive:hover {
      transform: translateY(-6px) scale(1.02);
      box-shadow: 18px 18px 34px rgba(60,50,90,0.15), -12px -12px 28px rgba(255,255,255,0.95);
    }
    .clay-card.interactive:active {
      transform: scale(0.98);
    }
    .clay-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.85rem 1.75rem;
      border-radius: 28px;
      border: none;
      font-family: 'Baloo 2', cursive;
      font-size: 1.15rem;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      box-shadow: var(--clay-btn);
      transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease;
    }
    .clay-btn:hover {
      transform: translateY(-3px) scale(1.02);
    }
    .clay-btn:active {
      transform: scale(0.97);
    }
    .clay-btn.primary { background: linear-gradient(135deg, var(--lavender), var(--sky)); color: var(--text); }
    .clay-btn.mint { background: linear-gradient(135deg, var(--mint), #C7F9CC); color: #0C6B45; }
    .clay-btn.peach { background: linear-gradient(135deg, var(--peach), var(--rose)); color: var(--text); }
    .clay-btn.secondary { background: rgba(255,255,255,0.85); color: var(--text); border: 1px solid rgba(255,255,255,0.9); }

    /* Layout Containers & Spacing */
    .section-wrap {
      max-width: 1200px;
      margin: 0 auto;
      padding: 5.5rem 1.5rem;
    }
    .section-header {
      text-align: center;
      max-width: 650px;
      margin: 0 auto 3rem auto;
    }
    .section-title {
      font-size: 2.5rem;
      margin-bottom: 0.75rem;
    }
    .section-subtitle {
      font-size: 1.1rem;
      color: #556270;
    }

    /* 1. Hero Section */
    .hero-grid {
      display: grid;
      grid-template-columns: 1.2fr 0.8fr;
      align-items: center;
      gap: 3.5rem;
      min-height: 75vh;
      padding: 3rem 0;
    }
    .hero-headline {
      font-size: 3.4rem;
      line-height: 1.15;
      margin-bottom: 1.25rem;
    }
    .hero-headline span.word {
      display: inline-block;
      opacity: 0;
      transform: translateY(20px);
      animation: wordFade 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    }
    .hero-headline span.word:nth-child(1) { animation-delay: 0.1s; }
    .hero-headline span.word:nth-child(2) { animation-delay: 0.2s; }
    .hero-headline span.word:nth-child(3) { animation-delay: 0.3s; }
    .hero-headline span.word:nth-child(4) { animation-delay: 0.4s; }
    .hero-headline span.word:nth-child(5) { animation-delay: 0.5s; }
    .hero-headline span.word:nth-child(6) { animation-delay: 0.6s; }
    .hero-headline span.word:nth-child(7) { animation-delay: 0.7s; }

    @keyframes wordFade {
      to { opacity: 1; transform: translateY(0); }
    }

    .hero-sub {
      font-size: 1.25rem;
      color: #4A5568;
      margin-bottom: 2rem;
      max-width: 520px;
    }
    .hero-ctas {
      display: flex;
      gap: 1.25rem;
      flex-wrap: wrap;
    }

    /* Floating illustration */
    .hero-art {
      display: flex;
      justify-content: center;
      align-items: center;
      position: relative;
    }
    .floating-clay {
      width: 100%;
      max-width: 380px;
      animation: floatArt 9s ease-in-out infinite;
    }
    @keyframes floatArt {
      0%, 100% { transform: translateY(0) rotate(0deg); }
      50% { transform: translateY(-16px) rotate(2deg); }
    }

    /* 2. Info Strip */
    .info-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 1.5rem;
      margin-top: -1.5rem;
      margin-bottom: 3.5rem;
    }
    .glass-pill {
      background: var(--glass-bg);
      backdrop-filter: blur(14px) saturate(150%);
      -webkit-backdrop-filter: blur(14px) saturate(150%);
      border: var(--glass-border);
      border-radius: 26px;
      padding: 1.25rem 1.5rem;
      box-shadow: 8px 8px 20px rgba(60,50,90,0.06), -6px -6px 16px rgba(255,255,255,0.85);
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .pill-icon {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.4rem;
      flex-shrink: 0;
      box-shadow: var(--clay-btn);
    }
    .pill-icon.mint { background: var(--mint); color: #0C6B45; }
    .pill-icon.peach { background: var(--peach); color: #8F4617; }
    .pill-icon.lavender { background: var(--lavender); color: #4B3F72; }

    /* 3. Services Grid */
    .services-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(270px, 1fr));
      gap: 1.75rem;
    }
    .service-card {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      height: 100%;
    }
    .service-icon-box {
      width: 56px;
      height: 56px;
      border-radius: 20px;
      background: linear-gradient(135deg, var(--mint), var(--sky));
      box-shadow: var(--clay-btn);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.6rem;
      margin-bottom: 1.25rem;
    }
    .service-duration {
      display: inline-block;
      background: var(--butter);
      color: #7B6200;
      font-weight: 700;
      font-size: 0.85rem;
      padding: 0.25rem 0.75rem;
      border-radius: 14px;
      margin-top: 0.5rem;
      margin-bottom: 1.25rem;
    }

    /* 4. Dentists Grid */
    .dentists-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 2rem;
    }
    .dentist-card {
      text-align: center;
      padding: 2.5rem 1.5rem;
    }
    .dentist-avatar {
      width: 86px;
      height: 86px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--lavender), var(--rose));
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 2.2rem;
      font-family: 'Baloo 2', cursive;
      font-weight: 800;
      margin: 0 auto 1.25rem auto;
      box-shadow: var(--clay-btn);
    }

    /* 5. Booking Wizard */
    .wizard-card {
      max-width: 840px;
      margin: 0 auto;
      background: rgba(255,255,255,0.85);
      border-radius: 36px;
      padding: 2.5rem;
      box-shadow: var(--clay-shadow);
      border: 1px solid rgba(255,255,255,0.8);
      position: relative;
    }
    .progress-bar-container {
      background: rgba(60,50,90,0.08);
      border-radius: 20px;
      height: 10px;
      margin-bottom: 2rem;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--mint), var(--lavender));
      width: 25%;
      border-radius: 20px;
      transition: width 0.4s ease;
    }
    .wizard-step-labels {
      display: flex;
      justify-content: space-between;
      margin-bottom: 2rem;
    }
    .step-pill {
      font-size: 0.85rem;
      font-weight: 700;
      color: #6B7280;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    .step-pill.active {
      color: #5B45BA;
    }
    .step-pill.active span.circle {
      background: var(--lavender);
      color: var(--text);
    }
    .step-pill span.circle {
      width: 26px;
      height: 26px;
      border-radius: 50%;
      background: rgba(60,50,90,0.1);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.8rem;
    }

    .form-group {
      margin-bottom: 1.35rem;
    }
    .form-label {
      display: block;
      font-weight: 700;
      margin-bottom: 0.45rem;
      font-size: 0.95rem;
    }
    .form-control {
      width: 100%;
      padding: 0.85rem 1.15rem;
      border-radius: 20px;
      border: 1px solid rgba(60,50,90,0.15);
      background: white;
      font-family: inherit;
      font-size: 1rem;
      color: var(--text);
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .form-control:focus {
      border-color: var(--lavender);
      box-shadow: 0 0 0 3px rgba(199,184,245,0.5);
    }

    /* Slot chips */
    .slots-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(95px, 1fr));
      gap: 0.75rem;
      margin-top: 1rem;
    }
    .slot-chip {
      padding: 0.7rem 0.5rem;
      text-align: center;
      background: white;
      border-radius: 18px;
      border: 1px solid rgba(60,50,90,0.12);
      font-weight: 800;
      font-size: 0.95rem;
      cursor: pointer;
      box-shadow: 4px 4px 10px rgba(60,50,90,0.06);
      transition: all 0.2s;
    }
    .slot-chip:hover {
      transform: translateY(-2px);
      border-color: var(--lavender);
    }
    .slot-chip.selected {
      background: linear-gradient(135deg, var(--mint), var(--sky));
      border-color: #60A5FA;
      box-shadow: var(--clay-btn);
    }

    /* Shimmer Skeleton */
    .shimmer {
      background: linear-gradient(90deg, #f0f0f5 25%, #e4e4ed 50%, #f0f0f5 75%);
      background-size: 200% 100%;
      animation: shimmer 1.5s infinite;
      border-radius: 16px;
      height: 44px;
    }
    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }

    /* 6. Why Book With Us */
    .features-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 2rem;
    }
    .feature-tile {
      padding: 2.25rem;
      border-radius: 30px;
    }

    /* 7. FAQ Accordion */
    .faq-list {
      max-width: 800px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }
    .faq-item {
      background: rgba(255,255,255,0.7);
      border-radius: 24px;
      border: 1px solid rgba(255,255,255,0.7);
      box-shadow: 8px 8px 20px rgba(60,50,90,0.08);
      overflow: hidden;
      transition: all 0.3s;
    }
    .faq-trigger {
      width: 100%;
      text-align: left;
      padding: 1.35rem 1.75rem;
      background: none;
      border: none;
      font-family: 'Baloo 2', cursive;
      font-size: 1.35rem;
      font-weight: 700;
      color: var(--text);
      cursor: pointer;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .faq-trigger span.icon {
      font-size: 1.5rem;
      transition: transform 0.3s;
    }
    .faq-item.open .faq-trigger span.icon {
      transform: rotate(45deg);
    }
    .faq-body {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.4s ease, padding 0.3s ease;
      padding: 0 1.75rem;
      color: #4A5568;
      font-size: 1.05rem;
    }
    .faq-item.open .faq-body {
      max-height: 250px;
      padding-bottom: 1.5rem;
    }

    /* 8. Visit Us */
    .visit-grid {
      display: grid;
      grid-template-columns: 1fr 1.2fr;
      gap: 2.5rem;
      align-items: center;
    }
    .map-frame {
      width: 100%;
      height: 380px;
      border-radius: 30px;
      border: 1px solid rgba(255,255,255,0.8);
      box-shadow: var(--clay-shadow);
      overflow: hidden;
    }

    /* 9. Footer */
    .site-footer {
      background: rgba(255,255,255,0.65);
      backdrop-filter: blur(14px);
      border-top: 1px solid rgba(255,255,255,0.8);
      padding: 3rem 1.5rem 2rem 1.5rem;
      margin-top: 4rem;
    }
    .footer-inner {
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1.5rem;
    }
    .legal-text {
      font-size: 0.9rem;
      color: #6B7280;
    }

    /* Toasts */
    .toast-container {
      position: fixed;
      top: 1.5rem;
      right: 1.5rem;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      pointer-events: none;
    }
    .toast {
      pointer-events: auto;
      background: white;
      border-radius: 20px;
      padding: 1rem 1.5rem;
      box-shadow: 0 10px 30px rgba(60,50,90,0.15);
      border: 1px solid rgba(60,50,90,0.1);
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-weight: 700;
      animation: slideIn 0.3s ease forwards;
    }
    .toast.success { border-left: 6px solid #10B981; }
    .toast.error { border-left: 6px solid #EF4444; }
    @keyframes slideIn {
      from { transform: translateX(100%); opacity: 0; }
      to { transform: translateX(0); opacity: 1; }
    }

    /* Scroll reveal transitions */
    .reveal {
      opacity: 0;
      transform: translateY(24px);
      transition: opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1), transform 0.6s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .reveal.active {
      opacity: 1;
      transform: translateY(0);
    }

    /* Reduced Motion Accessibility */
    @media (prefers-reduced-motion: reduce) {
      *, ::before, ::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
        scroll-behavior: auto !important;
      }
      .floating-clay { animation: none !important; }
      .reveal { opacity: 1 !important; transform: none !important; }
    }

    /* Mobile Responsive adjustments */
    @media (max-width: 900px) {
      .hero-grid { grid-template-columns: 1fr; text-align: center; gap: 2.5rem; }
      .hero-sub { margin-left: auto; margin-right: auto; }
      .hero-ctas { justify-content: center; }
      .visit-grid { grid-template-columns: 1fr; }
      .hero-headline { font-size: 2.5rem; }
      .section-wrap { padding: 4rem 1.25rem; }
      .nav-menu { display: none; }
    }
    @media (max-width: 480px) {
      .hero-headline { font-size: 2.1rem; }
      .section-title { font-size: 2rem; }
      .clay-card { padding: 1.5rem; border-radius: 24px; }
      .wizard-card { padding: 1.5rem 1rem; border-radius: 28px; }
    }
  </style>
</head>
<body>

  <!-- Toast Notification Container -->
  <div class="toast-container" id="toastContainer"></div>

  <!-- 1. Glass Navbar -->
  <header class="navbar" id="navbar">
    <div class="nav-inner">
      <a href="/" class="badge-logo">
        <span>DDH</span>
        <span class="sub">Dental Care</span>
      </a>

      <nav>
        <ul class="nav-menu">
          <li><a href="#services" class="nav-link">Services</a></li>
          <li><a href="#dentists" class="nav-link">Dentists</a></li>
          <li><a href="#book" class="nav-link">Book</a></li>
          <li><a href="#visit" class="nav-link">Visit</a></li>
          <li><a href="#faq" class="nav-link">FAQ</a></li>
        </ul>
      </nav>

      <a href="tel:${escapeHtml(cleanPhoneDigits)}" class="btn-call-nav">Call now</a>
    </div>
  </header>

  <main>
    <!-- 2. Hero Section -->
    <section class="section-wrap" style="padding-top:2rem;">
      <div class="hero-grid">
        <div>
          <h1 class="hero-headline" id="heroHeadline">Gentle dental care, booked in a minute</h1>
          <p class="hero-sub">
            Experience friendly, modern dentistry at Dhuliyan Diagnostic & Health Care. Choose your dental service and time slot with instant online confirmation.
          </p>
          <div class="hero-ctas">
            <a href="#book" class="clay-btn primary" style="font-size:1.25rem; padding:0.95rem 2.2rem;">Book appointment</a>
            <a href="tel:${escapeHtml(cleanPhoneDigits)}" class="clay-btn secondary">Call ${escapeHtml(clinicPhone)}</a>
          </div>
        </div>

        <div class="hero-art">
          <div class="floating-clay">
            <svg viewBox="0 0 400 400" width="100%" height="100%" fill="none" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <filter id="clayShadow" x="-20%" y="-20%" width="140%" height="140%">
                  <feDropShadow dx="12" dy="16" stdDeviation="14" flood-color="#3c325a" flood-opacity="0.16"/>
                </filter>
                <linearGradient id="toothGrad" x1="50" y1="50" x2="350" y2="350" gradientUnits="userSpaceOnUse">
                  <stop stop-color="#FFFFFF"/>
                  <stop offset="0.6" stop-color="#EBF4FF"/>
                  <stop offset="1" stop-color="#C7B8F5"/>
                </linearGradient>
                <linearGradient id="sparkGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop stop-color="#FFF1B5"/>
                  <stop offset="1" stop-color="#FFD3B6"/>
                </linearGradient>
                <linearGradient id="mintGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop stop-color="#A8E6CF"/>
                  <stop offset="1" stop-color="#BDE0FE"/>
                </linearGradient>
              </defs>

              <!-- Floating Pastel Background Blobs -->
              <circle cx="80" cy="110" r="42" fill="url(#mintGrad)" opacity="0.85" filter="url(#clayShadow)"/>
              <circle cx="330" cy="270" r="48" fill="url(#sparkGrad)" opacity="0.9" filter="url(#clayShadow)"/>
              <circle cx="310" cy="80" r="28" fill="#FFC6D9" opacity="0.75" filter="url(#clayShadow)"/>

              <!-- Central Clay Tooth Illustration -->
              <g filter="url(#clayShadow)">
                <path d="M140 100 C100 100, 80 145, 80 185 C80 230, 105 275, 125 315 C135 335, 150 335, 160 305 C170 275, 185 240, 200 240 C215 240, 230 275, 240 305 C250 335, 265 335, 275 315 C295 275, 320 230, 320 185 C320 145, 300 100, 260 100 C225 100, 210 120, 200 120 C190 120, 175 100, 140 100 Z"
                      fill="url(#toothGrad)" stroke="rgba(255,255,255,0.9)" stroke-width="6"/>
                <!-- Tooth Highlights -->
                <path d="M125 130 C110 150, 105 180, 110 205" stroke="#FFFFFF" stroke-width="8" stroke-linecap="round" opacity="0.85"/>
                <circle cx="150" cy="180" r="7" fill="#4B3F72"/>
                <circle cx="250" cy="180" r="7" fill="#4B3F72"/>
                <!-- Smile -->
                <path d="M175 205 Q200 225 225 205" stroke="#4B3F72" stroke-width="5" stroke-linecap="round" fill="none"/>
                <!-- Cheeks -->
                <ellipse cx="140" cy="200" rx="10" ry="6" fill="#FFC6D9"/>
                <ellipse cx="260" cy="200" rx="10" ry="6" fill="#FFC6D9"/>
              </g>

              <!-- Sparkle Star -->
              <path d="M290 120 L296 138 L314 144 L296 150 L290 168 L284 150 L266 144 L284 138 Z" fill="#FFF1B5" filter="url(#clayShadow)"/>
            </svg>
          </div>
        </div>
      </div>

      <!-- 3. Info Strip -->
      <div class="info-strip reveal">
        <div class="glass-pill">
          <div class="pill-icon mint">🕒</div>
          <div>
            <div style="font-size:0.8rem; font-weight:700; color:#556270; text-transform:uppercase;">Clinic Hours</div>
            <div style="font-weight:800; font-size:1rem;">${escapeHtml(hoursSummary)}</div>
          </div>
        </div>

        <div class="glass-pill">
          <div class="pill-icon peach">📍</div>
          <div>
            <div style="font-size:0.8rem; font-weight:700; color:#556270; text-transform:uppercase;">Dhuliyan Clinic</div>
            <div style="font-weight:800; font-size:1rem;">Old Dakbanglow, Murshidabad</div>
          </div>
        </div>

        <div class="glass-pill">
          <div class="pill-icon lavender">📞</div>
          <div>
            <div style="font-size:0.8rem; font-weight:700; color:#556270; text-transform:uppercase;">Reception Line</div>
            <div style="font-weight:800; font-size:1rem;">
              <a href="tel:${escapeHtml(cleanPhoneDigits)}" style="color:inherit; text-decoration:none;">${escapeHtml(clinicPhone)}</a>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 4. Services Section -->
    <section class="section-wrap" id="services">
      <div class="section-header reveal">
        <h2 class="section-title">Our Dental Services</h2>
        <p class="section-subtitle">From routine dental checkups to specialized treatments, choose the care you need.</p>
      </div>

      <div class="services-grid">
        ${services
          .map(
            (s, idx) => `
          <div class="clay-card interactive service-card reveal" style="transition-delay: ${idx * 60}ms;">
            <div>
              <div class="service-icon-box">🦷</div>
              <h3 style="font-size:1.35rem; margin-bottom:0.35rem;">${escapeHtml(s.name)}</h3>
              <div class="service-duration">⏱️ ${s.durationMinutes} Minutes</div>
              <p style="color:#556270; font-size:0.95rem; margin-bottom:1.5rem;">
                ${escapeHtml(s.description || 'Comprehensive dental assessment and professional treatment tailored to your oral health.')}
              </p>
            </div>
            <div>
              <button class="clay-btn mint" style="width:100%; font-size:1rem; padding:0.65rem 1rem;" onclick="selectServiceAndScroll('${s._id}')">
                Book this
              </button>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
    </section>

    <!-- 5. Dentists Section -->
    <section class="section-wrap" id="dentists">
      <div class="section-header reveal">
        <h2 class="section-title">Meet Our Dental Team</h2>
        <p class="section-subtitle">Dedicated dental practitioners providing gentle and personalized treatment.</p>
      </div>

      <div class="dentists-grid">
        ${dentists
          .map(
            (d, idx) => `
          <div class="clay-card interactive dentist-card reveal" style="transition-delay: ${idx * 80}ms;">
            <div class="dentist-avatar">
              ${escapeHtml((d.name || 'D').replace(/^Dr\.\s*/, '').charAt(0) || 'D')}
            </div>
            <h3 style="font-size:1.4rem; margin-bottom:0.25rem;">${escapeHtml(d.name)}</h3>
            <div style="font-weight:700; color:#5B45BA; margin-bottom:0.35rem;">${escapeHtml(d.qualification || 'Dental Surgeon')}</div>
            <div style="color:#556270; font-size:0.95rem; margin-bottom:1.25rem;">${escapeHtml(d.specialty || 'General & Cosmetic Dentistry')}</div>
            <button class="clay-btn lavender" style="font-size:0.95rem; padding:0.5rem 1.25rem;" onclick="selectDentistAndScroll('${d._id}')">
              Select Dentist
            </button>
          </div>
        `
          )
          .join('')}
      </div>
    </section>

    <!-- 6. Booking Wizard Section -->
    <section class="section-wrap" id="book">
      <div class="section-header reveal">
        <h2 class="section-title">Book Your Appointment</h2>
        <p class="section-subtitle">Complete 4 quick steps to schedule your dental visit online.</p>
      </div>

      <div class="wizard-card reveal" id="wizardCard">
        <!-- Progress Bar -->
        <div class="progress-bar-container">
          <div class="progress-fill" id="progressFill"></div>
        </div>

        <div class="wizard-step-labels">
          <div class="step-pill active" id="pill1"><span class="circle">1</span> Service</div>
          <div class="step-pill" id="pill2"><span class="circle">2</span> Dentist</div>
          <div class="step-pill" id="pill3"><span class="circle">3</span> Date & Time</div>
          <div class="step-pill" id="pill4"><span class="circle">4</span> Details</div>
        </div>

        <!-- Wizard Forms Container -->
        <div id="wizardStepContainer">

          <!-- Step 1: Select Service -->
          <div id="step1">
            <h3 style="font-size:1.4rem; margin-bottom:1rem;">Step 1: Choose Dental Service</h3>
            <div class="form-group">
              <label class="form-label" for="bookingService">Select Service *</label>
              <select id="bookingService" class="form-control" onchange="onServiceChanged()">
                <option value="">-- Please select a service --</option>
                ${services
                  .map(
                    (s) => `
                  <option value="${s._id}" data-duration="${s.durationMinutes}">
                    ${escapeHtml(s.name)} (${s.durationMinutes} min)
                  </option>
                `
                  )
                  .join('')}
              </select>
            </div>
            <div style="display:flex; justify-content:flex-end; margin-top:1.5rem;">
              <button class="clay-btn primary" onclick="goToStep(2)">Next: Choose Dentist →</button>
            </div>
          </div>

          <!-- Step 2: Select Dentist -->
          <div id="step2" style="display:none;">
            <h3 style="font-size:1.4rem; margin-bottom:1rem;">Step 2: Choose Your Dentist</h3>
            <div class="form-group">
              <label class="form-label" for="bookingDentist">Select Dentist *</label>
              <select id="bookingDentist" class="form-control" onchange="onDentistChanged()">
                <option value="">-- Any Available Dental Practitioner --</option>
                ${dentists
                  .map(
                    (d) => `
                  <option value="${d._id}">
                    ${escapeHtml(d.name)} - ${escapeHtml(d.specialty || 'General Dentistry')}
                  </option>
                `
                  )
                  .join('')}
              </select>
            </div>
            <div style="display:flex; justify-content:space-between; margin-top:1.5rem;">
              <button class="clay-btn secondary" onclick="goToStep(1)">← Back</button>
              <button class="clay-btn primary" onclick="goToStep(3)">Next: Date & Time →</button>
            </div>
          </div>

          <!-- Step 3: Date and Time Slot -->
          <div id="step3" style="display:none;">
            <h3 style="font-size:1.4rem; margin-bottom:1rem;">Step 3: Select Date & Available Slot</h3>
            
            <div class="form-group">
              <label class="form-label" for="bookingDate">Appointment Date *</label>
              <input type="date" id="bookingDate" class="form-control" onchange="fetchAvailableSlots()">
            </div>

            <div style="margin-top:1.25rem;">
              <label class="form-label">Available Time Slots *</label>
              <div id="slotsLoading" style="display:none;" class="shimmer"></div>
              <div id="slotsContainer" class="slots-grid"></div>
              <div id="slotsMessage" style="color:#556270; font-size:0.95rem; margin-top:0.5rem;">
                Select a date above to display available times.
              </div>
            </div>

            <input type="hidden" id="selectedStartTime" value="">

            <div style="display:flex; justify-content:space-between; margin-top:2rem;">
              <button class="clay-btn secondary" onclick="goToStep(2)">← Back</button>
              <button class="clay-btn primary" onclick="goToStep(4)">Next: Patient Details →</button>
            </div>
          </div>

          <!-- Step 4: Patient Details -->
          <div id="step4" style="display:none;">
            <h3 style="font-size:1.4rem; margin-bottom:1rem;">Step 4: Patient Information</h3>

            <!-- Honeypot -->
            <input type="text" id="hpWebsite" name="website" style="display:none;" tabindex="-1" autocomplete="off">

            <div class="form-group">
              <label class="form-label" for="patientName">Full Name *</label>
              <input type="text" id="patientName" class="form-control" placeholder="e.g. Rahul Sharma" required minlength="2" maxlength="80">
            </div>

            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1rem;">
              <div class="form-group">
                <label class="form-label" for="patientPhone">Mobile Number (India) *</label>
                <input type="tel" id="patientPhone" class="form-control" placeholder="10-digit mobile number" required>
              </div>
              <div class="form-group">
                <label class="form-label" for="patientAge">Age (Optional)</label>
                <input type="number" id="patientAge" class="form-control" placeholder="e.g. 28" min="1" max="120">
              </div>
            </div>

            <div class="form-group">
              <label class="form-label" for="patientEmail">Email Address (Optional)</label>
              <input type="email" id="patientEmail" class="form-control" placeholder="name@example.com">
            </div>

            <div class="form-group">
              <label class="form-label" for="patientNotes">Notes or Symptoms (Optional)</label>
              <textarea id="patientNotes" class="form-control" rows="2" maxlength="500" placeholder="Describe any dental pain, previous treatments, or special requests..."></textarea>
            </div>

            <div class="form-group" style="margin-top:1rem;">
              <label style="display:flex; align-items:flex-start; gap:0.6rem; cursor:pointer; font-size:0.95rem;">
                <input type="checkbox" id="consentCheckbox" style="margin-top:0.3rem;" required>
                <span>I consent to booking this dental appointment and allow clinic staff to contact me regarding my scheduling. *</span>
              </label>
            </div>

            <div style="display:flex; justify-content:space-between; margin-top:2rem;">
              <button class="clay-btn secondary" onclick="goToStep(3)">← Back</button>
              <button class="clay-btn mint" id="btnSubmitBooking" onclick="submitBooking()" style="font-size:1.2rem; padding:0.85rem 2.2rem;">
                Confirm & Book Appointment
              </button>
            </div>
          </div>

          <!-- Confirmation Screen -->
          <div id="stepConfirmation" style="display:none; text-align:center; padding:1.5rem 0;">
            <div style="width:80px; height:80px; border-radius:50%; background:linear-gradient(135deg, var(--mint), #70E000); color:white; display:flex; align-items:center; justify-content:center; font-size:2.8rem; margin:0 auto 1.25rem auto; box-shadow:var(--clay-btn);">
              ✓
            </div>
            <h3 style="font-size:2rem; margin-bottom:0.5rem;">Appointment Scheduled!</h3>
            <p style="color:#556270; max-width:480px; margin:0 auto 1.5rem auto;">
              Thank you for choosing Dhuliyan Diagnostic & Health Care. Your appointment reference code is:
            </p>
            <div style="display:inline-block; background:linear-gradient(135deg, var(--butter), var(--peach)); padding:0.85rem 2rem; border-radius:22px; font-family:'Baloo 2', cursive; font-size:2rem; font-weight:800; letter-spacing:2px; box-shadow:var(--clay-btn); margin-bottom:1.5rem;" id="confirmedReference">
              DDH-XXXXXX
            </div>
            <p style="color:#556270; font-size:0.95rem; margin-bottom:2rem;">
              Please show this reference code at reception upon arrival. For rescheduling or cancellations, please call reception.
            </p>
            <button class="clay-btn primary" onclick="resetBookingWizard()">Book Another Appointment</button>
          </div>

        </div>
      </div>
    </section>

    <!-- 7. Why Book With Us Section -->
    <section class="section-wrap">
      <div class="section-header reveal">
        <h2 class="section-title">Why Book With Us</h2>
        <p class="section-subtitle">A straightforward dental appointment experience designed around your convenience.</p>
      </div>

      <div class="features-grid">
        <div class="clay-card interactive feature-tile reveal">
          <div style="font-size:2.5rem; margin-bottom:1rem;">⚡</div>
          <h3 style="font-size:1.4rem; margin-bottom:0.5rem;">Book in under a minute</h3>
          <p style="color:#556270; font-size:0.98rem;">
            Clean, mobile-first online scheduling that lets you reserve your exact dental slot quickly without waiting on hold.
          </p>
        </div>

        <div class="clay-card interactive feature-tile reveal" style="transition-delay:80ms;">
          <div style="font-size:2.5rem; margin-bottom:1rem;">🩺</div>
          <h3 style="font-size:1.4rem; margin-bottom:0.5rem;">Choose your dentist</h3>
          <p style="color:#556270; font-size:0.98rem;">
            Browse our roster of dental surgeons, view available days, and pick the specialist that fits your schedule.
          </p>
        </div>

        <div class="clay-card interactive feature-tile reveal" style="transition-delay:160ms;">
          <div style="font-size:2.5rem; margin-bottom:1rem;">🎟️</div>
          <h3 style="font-size:1.4rem; margin-bottom:0.5rem;">Get a reference code instantly</h3>
          <p style="color:#556270; font-size:0.98rem;">
            Receive a verified unique reference code immediately upon booking for effortless check-in at our clinic desk.
          </p>
        </div>
      </div>
    </section>

    <!-- 8. FAQ Accordion Section -->
    <section class="section-wrap" id="faq">
      <div class="section-header reveal">
        <h2 class="section-title">Frequently Asked Questions</h2>
        <p class="section-subtitle">Common queries about dental bookings and visits at DDH.</p>
      </div>

      <div class="faq-list">
        <div class="faq-item reveal">
          <button class="faq-trigger" onclick="toggleFaq(this)">
            <span>How do I book an appointment?</span>
            <span class="icon">+</span>
          </button>
          <div class="faq-body">
            You can book directly using our online booking wizard above. Simply select your service, choose an available date and slot, enter your name and phone number, and you will receive an instant appointment reference code.
          </div>
        </div>

        <div class="faq-item reveal">
          <button class="faq-trigger" onclick="toggleFaq(this)">
            <span>How can I cancel or reschedule my appointment?</span>
            <span class="icon">+</span>
          </button>
          <div class="faq-body">
            To cancel or reschedule, please call our reception desk directly at <a href="tel:${escapeHtml(cleanPhoneDigits)}" style="color:inherit; font-weight:700;">${escapeHtml(clinicPhone)}</a> with your booking reference code, and staff will assist you.
          </div>
        </div>

        <div class="faq-item reveal">
          <button class="faq-trigger" onclick="toggleFaq(this)">
            <span>What payment methods and insurance are accepted?</span>
            <span class="icon">+</span>
          </button>
          <div class="faq-body">
            Payment policies and accepted insurance plans vary by service. Please call our reception team in advance to verify your payment options and coverage details.
          </div>
        </div>

        <div class="faq-item reveal">
          <button class="faq-trigger" onclick="toggleFaq(this)">
            <span>What should I bring to my appointment?</span>
            <span class="icon">+</span>
          </button>
          <div class="faq-body">
            Please bring a government photo ID, your DDH booking reference code, and any prior dental x-rays or medical records relevant to your visit.
          </div>
        </div>
      </div>
    </section>

    <!-- 9. Visit Us Section -->
    <section class="section-wrap" id="visit">
      <div class="section-header reveal">
        <h2 class="section-title">Visit Our Clinic</h2>
        <p class="section-subtitle">Conveniently located at Old Dakbanglow in Dhuliyan, West Bengal.</p>
      </div>

      <div class="visit-grid">
        <div class="clay-card reveal">
          <h3 style="font-size:1.6rem; margin-bottom:1rem;">Location & Contact</h3>

          <div style="margin-bottom:1.25rem;">
            <div style="font-weight:700; color:#556270; font-size:0.85rem; text-transform:uppercase;">Address</div>
            <p style="font-size:1rem; margin-top:0.25rem;">
              ${escapeHtml(settings.address)}
            </p>
          </div>

          <div style="margin-bottom:1.25rem;">
            <div style="font-weight:700; color:#556270; font-size:0.85rem; text-transform:uppercase;">Telephone</div>
            <p style="font-size:1.15rem; font-weight:800; margin-top:0.25rem;">
              <a href="tel:${escapeHtml(cleanPhoneDigits)}" style="color:#5B45BA; text-decoration:none;">${escapeHtml(clinicPhone)}</a>
            </p>
          </div>

          ${
            settings.email
              ? `
            <div style="margin-bottom:1.25rem;">
              <div style="font-weight:700; color:#556270; font-size:0.85rem; text-transform:uppercase;">Email</div>
              <p style="font-size:1rem; margin-top:0.25rem;">
                <a href="mailto:${escapeHtml(settings.email)}" style="color:inherit;">${escapeHtml(settings.email)}</a>
              </p>
            </div>
          `
              : ''
          }

          <div style="margin-bottom:1.5rem;">
            <div style="font-weight:700; color:#556270; font-size:0.85rem; text-transform:uppercase; margin-bottom:0.4rem;">Weekly Hours (Provisional)</div>
            <table style="width:100%; font-size:0.9rem; border-collapse:collapse;">
              <tbody>
                ${(settings.hours || [])
                  .map(
                    (h) => `
                  <tr>
                    <td style="padding:0.25rem 0; font-weight:700;">${escapeHtml(h.dayName)}</td>
                    <td style="padding:0.25rem 0; text-align:right; color:${h.isClosed ? '#DC2626' : 'inherit'};">
                      ${h.isClosed ? 'Closed' : `${escapeHtml(h.open)} – ${escapeHtml(h.close)}`}
                    </td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>

          <a href="${escapeHtml(settings.mapsLink || 'https://www.google.com/maps/dir/?api=1&destination=24.660543%2C87.947218')}"
             target="_blank" rel="noopener noreferrer" class="clay-btn primary" style="width:100%;">
            Get directions
          </a>
        </div>

        <div class="map-frame reveal">
          <iframe
            title="Dhuliyan Diagnostic & Health Care Location Map"
            width="100%"
            height="100%"
            style="border:0;"
            loading="lazy"
            allowfullscreen
            referrerpolicy="no-referrer-when-downgrade"
            src="https://maps.google.com/maps?q=${settings.latitude || 24.660543},${settings.longitude || 87.947218}&hl=en&z=15&output=embed">
          </iframe>
        </div>
      </div>
    </section>
  </main>

  <!-- 10. Footer -->
  <footer class="site-footer">
    <div class="footer-inner">
      <div>
        <div style="font-family:'Baloo 2', cursive; font-size:1.25rem; font-weight:800; color:var(--text);">
          ${escapeHtml(settings.clinicName)}
        </div>
        <div class="legal-text" style="margin-top:0.25rem;">
          ${escapeHtml(settings.legalName)}
        </div>
        <div class="legal-text" style="margin-top:0.25rem;">
          ${escapeHtml(settings.address)} | Tel: ${escapeHtml(clinicPhone)}
        </div>
      </div>

      <div style="text-align:right;">
        <div class="legal-text">
          &copy; ${currentYear} ${escapeHtml(settings.legalName)}. All rights reserved.
        </div>
        <div style="margin-top:0.5rem;">
          <a href="/admin/login" style="font-size:0.85rem; color:#6B7280; text-decoration:none;">Staff login</a>
        </div>
      </div>
    </div>
  </footer>

  <!-- Client-Side Booking and Interaction Logic -->
  <script>
    // Animate hero headline words if reduced motion is not preferred
    const h1 = document.getElementById('heroHeadline');
    if (h1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const words = h1.textContent.trim().split(' ');
      h1.innerHTML = words.map((w, idx) => '<span class="word" style="animation-delay:' + ((idx + 1) * 80) + 'ms;">' + w + '</span>').join(' ');
    }
    // State
    let currentStep = 1;
    let selectedSlot = '';

    // Scroll reveal with IntersectionObserver
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('active');
        }
      });
    }, { threshold: 0.1 });

    document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));

    // Navbar scroll shadow
    window.addEventListener('scroll', () => {
      const navbar = document.getElementById('navbar');
      if (window.scrollY > 20) {
        navbar.classList.add('scrolled');
      } else {
        navbar.classList.remove('scrolled');
      }
    });

    // Toast helper
    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.innerHTML = '<span>' + (type === 'error' ? '⚠️' : '✓') + '</span><span>' + message + '</span>';
      container.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    // FAQ toggle
    function toggleFaq(btn) {
      const item = btn.parentElement;
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item').forEach((i) => i.classList.remove('open'));
      if (!isOpen) {
        item.classList.add('open');
      }
    }

    // Quick Select from Services section
    function selectServiceAndScroll(serviceId) {
      const select = document.getElementById('bookingService');
      select.value = serviceId;
      goToStep(2);
      document.getElementById('book').scrollIntoView({ behavior: 'smooth' });
    }

    // Quick Select from Dentists section
    function selectDentistAndScroll(dentistId) {
      const select = document.getElementById('bookingDentist');
      select.value = dentistId;
      goToStep(3);
      document.getElementById('book').scrollIntoView({ behavior: 'smooth' });
    }

    function onServiceChanged() {
      if (document.getElementById('bookingDate').value) {
        fetchAvailableSlots();
      }
    }

    function onDentistChanged() {
      if (document.getElementById('bookingDate').value) {
        fetchAvailableSlots();
      }
    }

    // Wizard Step Navigation
    function goToStep(step) {
      if (step === 2) {
        const s = document.getElementById('bookingService').value;
        if (!s) {
          showToast('Please select a dental service to continue.', 'error');
          return;
        }
      } else if (step === 3) {
        const d = document.getElementById('bookingDentist').value;
        if (!d) {
          showToast('Please select a dentist to continue.', 'error');
          return;
        }
        // Set date minimum to today in India
        const today = new Date().toISOString().split('T')[0];
        const dateInput = document.getElementById('bookingDate');
        if (!dateInput.min) {
          dateInput.min = today;
          if (!dateInput.value) {
            dateInput.value = today;
            fetchAvailableSlots();
          }
        }
      } else if (step === 4) {
        const date = document.getElementById('bookingDate').value;
        if (!date) {
          showToast('Please choose an appointment date.', 'error');
          return;
        }
        if (!selectedSlot) {
          showToast('Please select an available time slot.', 'error');
          return;
        }
      }

      currentStep = step;

      // Update forms
      document.getElementById('step1').style.display = step === 1 ? 'block' : 'none';
      document.getElementById('step2').style.display = step === 2 ? 'block' : 'none';
      document.getElementById('step3').style.display = step === 3 ? 'block' : 'none';
      document.getElementById('step4').style.display = step === 4 ? 'block' : 'none';
      document.getElementById('stepConfirmation').style.display = 'none';

      // Update pills & progress
      const progressFill = document.getElementById('progressFill');
      progressFill.style.width = (step * 25) + '%';

      for (let i = 1; i <= 4; i++) {
        const pill = document.getElementById('pill' + i);
        if (i <= step) {
          pill.classList.add('active');
        } else {
          pill.classList.remove('active');
        }
      }
    }

    // Fetch slot availability from /api/availability
    async function fetchAvailableSlots() {
      const date = document.getElementById('bookingDate').value;
      const dentistId = document.getElementById('bookingDentist').value;
      const serviceId = document.getElementById('bookingService').value;

      if (!date || !dentistId || !serviceId) return;

      const container = document.getElementById('slotsContainer');
      const loader = document.getElementById('slotsLoading');
      const msg = document.getElementById('slotsMessage');

      selectedSlot = '';
      document.getElementById('selectedStartTime').value = '';
      container.innerHTML = '';
      msg.textContent = '';
      loader.style.display = 'block';

      try {
        const res = await fetch('/api/availability?date=' + encodeURIComponent(date) + '&dentistId=' + encodeURIComponent(dentistId) + '&serviceId=' + encodeURIComponent(serviceId));
        const data = await res.json();
        loader.style.display = 'none';

        if (data.error && (!data.slots || data.slots.length === 0)) {
          msg.textContent = data.error;
          return;
        }

        if (!data.slots || data.slots.length === 0) {
          msg.textContent = 'No slots available for this date. Please choose another date or practitioner.';
          return;
        }

        msg.textContent = 'Select one of the ' + data.slots.length + ' available time slots:';

        data.slots.forEach((timeStr) => {
          const chip = document.createElement('div');
          chip.className = 'slot-chip';
          chip.textContent = timeStr;
          chip.onclick = function() {
            document.querySelectorAll('.slot-chip').forEach((c) => c.classList.remove('selected'));
            chip.classList.add('selected');
            selectedSlot = timeStr;
            document.getElementById('selectedStartTime').value = timeStr;
          };
          container.appendChild(chip);
        });
      } catch (err) {
        loader.style.display = 'none';
        msg.textContent = 'Failed to load availability. Please try again.';
      }
    }

    // Submit Booking
    async function submitBooking() {
      const patientName = document.getElementById('patientName').value.trim();
      const phone = document.getElementById('patientPhone').value.trim();
      const age = document.getElementById('patientAge').value;
      const email = document.getElementById('patientEmail').value.trim();
      const notes = document.getElementById('patientNotes').value.trim();
      const consentGiven = document.getElementById('consentCheckbox').checked;
      const website = document.getElementById('hpWebsite').value; // Honeypot
      const serviceId = document.getElementById('bookingService').value;
      const dentistId = document.getElementById('bookingDentist').value;
      const date = document.getElementById('bookingDate').value;
      const startTime = selectedSlot;

      if (!patientName || patientName.length < 2) {
        showToast('Please enter a valid patient name (min 2 characters).', 'error');
        return;
      }
      if (!phone) {
        showToast('Please enter your mobile phone number.', 'error');
        return;
      }
      if (!consentGiven) {
        showToast('You must consent to scheduling to complete booking.', 'error');
        return;
      }
      if (!startTime) {
        showToast('Please select a time slot.', 'error');
        return;
      }

      const btn = document.getElementById('btnSubmitBooking');
      btn.disabled = true;
      btn.textContent = 'Scheduling...';

      try {
        const response = await fetch('/api/appointments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            patientName,
            phone,
            age: age ? Number(age) : null,
            email,
            notes,
            consentGiven,
            website,
            serviceId,
            dentistId,
            date,
            startTime,
          }),
        });

        const data = await response.json();
        btn.disabled = false;
        btn.textContent = 'Confirm & Book Appointment';

        if (response.status === 201 && data.success) {
          // Show confirmation screen
          document.getElementById('step4').style.display = 'none';
          document.getElementById('stepConfirmation').style.display = 'block';
          document.getElementById('confirmedReference').textContent = data.reference;
          document.getElementById('progressFill').style.width = '100%';
          showToast('Appointment confirmed! Reference: ' + data.reference, 'success');
        } else if (response.status === 409) {
          showToast(data.message || 'Slot was just taken. Please pick another time.', 'error');
          goToStep(3);
          fetchAvailableSlots();
        } else {
          showToast(data.error || data.message || 'Failed to book appointment.', 'error');
        }
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Confirm & Book Appointment';
        showToast('Network error while booking. Please check connection and retry.', 'error');
      }
    }

    function resetBookingWizard() {
      document.getElementById('patientName').value = '';
      document.getElementById('patientPhone').value = '';
      document.getElementById('patientAge').value = '';
      document.getElementById('patientEmail').value = '';
      document.getElementById('patientNotes').value = '';
      document.getElementById('consentCheckbox').checked = false;
      document.getElementById('selectedStartTime').value = '';
      selectedSlot = '';
      goToStep(1);
    }
  </script>
</body>
</html>`;

    res.send(html);
  } catch (err) {
    res.status(500).send(`Server Error: ${escapeHtml(err.message)}`);
  }
});

// Export app and listen locally when run directly
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`DDH Dental Booking server listening on port ${PORT}`);
  });
}
