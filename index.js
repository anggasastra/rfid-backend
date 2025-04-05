// index.js - Versi Penyempurnaan

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const admin = require("firebase-admin");
const dotenv = require("dotenv");
const fs = require("fs");

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Ambil dan decode FIREBASE_KEY_BASE64 dari .env
const firebaseKeyBase64 = process.env.FIREBASE_KEY_BASE64;
const firebaseKeyJSON = JSON.parse(Buffer.from(firebaseKeyBase64, 'base64').toString('utf8'));

admin.initializeApp({
  credential: admin.credential.cert(firebaseKeyJSON),
  databaseURL: process.env.FIREBASE_DB_URL
});

const db = admin.database();
const scansRef = db.ref("rfid_scans");

// MySQL Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

app.use(cors());
app.use(express.json());


// Listen to Firebase changes
scansRef.on("child_added", async (snapshot) => {
  const scan = snapshot.val();
  const ref = snapshot.ref;

  try {
    // Validasi input
    if (!scan || !scan.tag || !scan.device_id) {
      await ref.update({ status: "rejected", response: "Data scan tidak lengkap" });
      return;
    }

    // Ambil mahasiswa berdasarkan tag
    const [mahasiswa] = await pool.query("SELECT * FROM mahasiswa WHERE rfid_tag = ?", [scan.tag]);
    if (mahasiswa.length === 0) {
      await ref.update({ status: "rejected", response: "RFID tidak terdaftar" });
      return;
    }

    const mhs = mahasiswa[0];

    // Cek ruangan dari alat
    const [ruangan] = await pool.query("SELECT * FROM ruangan WHERE alat_rfid_tag = ?", [scan.device_id]);
    if (ruangan.length === 0) {
      await ref.update({ status: "rejected", response: "Alat RFID tidak dikenali" });
      return;
    }

    const ruang = ruangan[0];

    // Cek jadwal sesuai mahasiswa dan ruangan
    const [jadwal] = await pool.query(
      `SELECT jk.id FROM jadwal_kelas jk 
       WHERE jk.prodi_id = ? AND jk.semester_id = ? AND jk.ruangan_id = ? 
       AND jk.hari = DAYNAME(CURDATE())`,
      [mhs.prodi_id, mhs.semester_id, ruang.id]
    );

    if (jadwal.length === 0) {
      await ref.update({ status: "rejected", response: "Tidak ada jadwal aktif di ruangan ini" });
      return;
    }

    // Cek absensi duplikat
    const [cekAbsensi] = await pool.query(
      `SELECT id FROM absensi WHERE mahasiswa_id = ? AND jadwal_id = ? AND DATE(waktu_absen) = CURDATE()`,
      [mhs.id, jadwal[0].id]
    );

    if (cekAbsensi.length > 0) {
      await ref.update({ status: "processed", response: "Absensi sudah tercatat hari ini" });
      return;
    }

    // Simpan absensi
    await pool.query(
      `INSERT INTO absensi (mahasiswa_id, jadwal_id, ruangan_id, waktu_absen, status) 
       VALUES (?, ?, ?, NOW(), ?)`,
      [mhs.id, jadwal[0].id, ruang.id, "Hadir"]
    );

    // Simpan log
    await pool.query(
      `INSERT INTO log_event (event, detail) VALUES (?, ?)`,
      ["RFID Scan", JSON.stringify(scan)]
    );

    await ref.update({ status: "processed", response: "Absensi tersimpan" });

  } catch (error) {
    console.error("[ERROR]", error);
    await snapshot.ref.update({ status: "rejected", response: "Terjadi kesalahan server" });
  }
});

// API: Get all absensi
app.get("/api/absensi", async (req, res) => {
  try {
    const [data] = await pool.query(`SELECT * FROM absensi`);
    res.json(data);
  } catch (err) {
    res.status(500).json({ message: "Gagal mengambil data absensi", error: err });
  }
});

// API: Get latest RFID scan from Firebase
app.get("/api/latest-rfid-scan", async (req, res) => {
  try {
    const latestRef = db.ref("rfid_scans/latest");
    const snapshot = await latestRef.once("value");

    if (!snapshot.exists()) {
      return res.status(404).json({ message: "Belum ada data RFID terbaru" });
    }

    const data = snapshot.val();
    res.json(data);
  } catch (error) {
    console.error("[ERROR] /api/latest-rfid-scan:", error);
    res.status(500).json({ message: "Gagal mengambil data RFID terbaru", error });
  }
});

// Start Server
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});