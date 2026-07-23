const express = require("express");
const path = require("path");
const tesseract = require("node-tesseract-ocr");

const app = express();
app.use(express.json());

// Serve the static frontend page (public/)
app.use(express.static(path.join(__dirname, "public")));

app.get("/healthz", (req, res) => res.json({ status: "ok" }));

// Mock product catalog for the demo (unrelated to the vulnerability)
const PRODUCTS = [
  { id: 1, name: "Aurora X Wireless Headphones", price: 1290000, category: "Audio", rating: 4.8, emoji: "🎧", badge: "Hot" },
  { id: 2, name: "TypeMaster RGB Mechanical Keyboard", price: 990000, category: "Accessories", rating: 4.6, emoji: "⌨️", badge: "-15%" },
  { id: 3, name: "NovaClick Pro Gaming Mouse", price: 650000, category: "Accessories", rating: 4.7, emoji: "🖱️", badge: null },
  { id: 4, name: "BoomBox Mini Bluetooth Speaker", price: 790000, category: "Audio", rating: 4.5, emoji: "🔊", badge: "New" },
  { id: 5, name: "RoadEye 4K Dash Cam", price: 2190000, category: "Devices", rating: 4.9, emoji: "📷", badge: "Hot" },
  { id: 6, name: "PowerCube 65W Fast Charger", price: 450000, category: "Accessories", rating: 4.4, emoji: "🔌", badge: null },
  { id: 7, name: "PulseFit 2 Smartwatch", price: 1590000, category: "Devices", rating: 4.6, emoji: "⌚", badge: "-10%" },
  { id: 8, name: "StreamCam 1080p Webcam", price: 720000, category: "Devices", rating: 4.3, emoji: "🎥", badge: null }
];

app.get("/api/products", (req, res) => res.json({ products: PRODUCTS }));

// Feature: seller uploads a product label image -> OCR automatically reads the text to fill the form
// VULNERABLE: CVE-2026-26832 - node-tesseract-ocr <=2.2.1 does not sanitize imagePath
// before concatenating it into the shell command string and passing it to child_process.exec()
app.post("/api/products/scan-label", async (req, res) => {
  const imagePath = req.body.imagePath || "";
  const config = { lang: "eng", oem: 1, psm: 3 };
  try {
    const text = await tesseract.recognize(imagePath, config);
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(8080, "0.0.0.0", () => console.log("shop-app listening on :8080"));
