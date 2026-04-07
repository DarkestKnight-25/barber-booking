require("dotenv").config();

const express = require("express");
const Database = require("better-sqlite3");
const twilio = require("twilio");
const cron = require("node-cron");
const dayjs = require("dayjs");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const rateLimit = require("express-rate-limit");

const app = express();
app.use(express.json());

// Security
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

// Database
const db = new Database("bookings.db");

db.exec(`
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  phone TEXT,
  service TEXT,
  date TEXT,
  time TEXT,
  reminded INTEGER DEFAULT 0,
  created TEXT DEFAULT (datetime('now'))
)
`);

// Twilio
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendSMS(to, message) {
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to
    });
  } catch (err) {
    console.error("SMS failed:", err.message);
  }
}

// Reminder system
cron.schedule("* * * * *", async () => {
  const now = dayjs();
  const target = now.add(24, "hour");

  const bookings = db.prepare(
    "SELECT * FROM bookings WHERE reminded = 0"
  ).all();

  for (const b of bookings) {
    const bookingTime = dayjs(`${b.date} ${b.time}`);

    if (Math.abs(bookingTime.diff(target, "minute")) <= 5) {
      await sendSMS(
        b.phone,
        `Reminder: Appointment tomorrow at ${b.time} 💈`
      );

      db.prepare("UPDATE bookings SET reminded = 1 WHERE id = ?")
        .run(b.id);
    }
  }
});

// Validate input
function isValidInput({ name, phone, service, date, time }) {
  if (!name || !phone || !service || !date || !time) return false;
  if (name.length > 50) return false;
  if (service.length > 100) return false;
  return true;
}

// Homepage
app.get("/", (req, res) => {
  res.send(`
  <html>
  <body style="font-family:sans-serif;max-width:400px;margin:40px auto;">
    <h2>Book Appointment</h2>

    <input id="name" placeholder="Name"><br>
    <input id="phone" placeholder="Phone"><br>

    <select id="service">
      <option value="">Service</option>
      <option value="Haircut">$20 Haircut</option>
      <option value="Fade">$25 Fade</option>
    </select><br>

    <input type="date" id="date"><br>

    <select id="time">
      <option value="">Time</option>
      <option>10:00 AM</option>
      <option>11:00 AM</option>
      <option>1:00 PM</option>
    </select><br>

    <button onclick="book()">Book</button>
    <button onclick="pay()">Pay $5 Deposit</button>

    <p id="msg"></p>

    <script>
    async function book() {
      const data = {
        name: name.value,
        phone: phone.value,
        service: service.value,
        date: date.value,
        time: time.value
      };

      const res = await fetch("/book", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(data)
      });

      const r = await res.json();
      msg.innerText = r.success ? "Booked!" : r.error;
    }

    async function pay() {
      const res = await fetch("/create-checkout", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({ service: service.value })
      });

      const data = await res.json();
      window.location = data.url;
    }
    </script>
  </body>
  </html>
  `);
});

// Booking route
app.post("/book", async (req, res) => {
  const { name, phone, service, date, time } = req.body;

  if (!isValidInput(req.body)) {
    return res.json({ success: false, error: "Invalid input" });
  }

  const digits = phone.replace(/\\D/g, "");
  const e164 = digits.startsWith("1") ? `+${digits}` : `+1${digits}`;

  if (!/^\\+1\\d{10}$/.test(e164)) {
    return res.json({ success: false, error: "Invalid phone" });
  }

  try {
    const exists = db.prepare(
      "SELECT 1 FROM bookings WHERE date = ? AND time = ?"
    ).get(date, time);

    if (exists) {
      return res.json({ success: false, error: "Time taken" });
    }

    db.prepare(
      "INSERT INTO bookings (name, phone, service, date, time) VALUES (?, ?, ?, ?, ?)"
    ).run(name, e164, service, date, time);

    await sendSMS(e164, "Booking confirmed 💈");

    res.json({ success: true });

  } catch (err) {
    console.error(err);
    res.json({ success: false, error: "Server error" });
  }
});

// Stripe
app.post("/create-checkout", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: { name: "Deposit" },
          unit_amount: 500
        },
        quantity: 1
      }],
      success_url: process.env.BASE_URL,
      cancel_url: process.env.BASE_URL
    });

    res.json({ url: session.url });
  } catch (err) {
    res.json({ error: "Payment error" });
  }
});

// Admin
app.get("/bookings", (req, res) => {
  if (req.query.key !== process.env.ADMIN_KEY) {
    return res.status(403).send("Forbidden");
  }

  const rows = db.prepare("SELECT * FROM bookings").all();

  res.send(`
    <h2>Bookings</h2>
    <table border="1">
      ${rows.map(r => `
        <tr>
          <td>${r.name}</td>
          <td>${r.service}</td>
          <td>${r.date}</td>
          <td>${r.time}</td>
        </tr>
      `).join("")}
    </table>
  `);
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Running on port", PORT);
});
