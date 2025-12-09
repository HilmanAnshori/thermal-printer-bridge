const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { exec, execSync } = require("child_process");
const express = require("express");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const sqlite3 = require("sqlite3").verbose();
const escpos = require("escpos");
const SerialPortLib = require("serialport");
escpos.Network = require("escpos-network");
escpos.USB = require("escpos-usb");

class RfcommSerial {
  constructor(port, options = { baudRate: 9600, autoOpen: false }) {
    const SerialCtor = SerialPortLib.SerialPort || SerialPortLib;
    const opts = {
      path: port,
      lock: false,
      ...options,
    };
    this.device = new SerialCtor(opts);
  }

  open(callback) {
    this.device.open(callback);
  }

  write(data, callback) {
    this.device.write(data, callback);
  }

  close(callback) {
    if (!this.device) {
      callback?.();
      return;
    }
    this.device.drain(() => {
      this.device.close(callback);
    });
  }
}

escpos.Serial = RfcommSerial;

dotenv.config();

const CONFIG_PATH = path.join(__dirname, "config.json");
const ENV_PATH = path.join(__dirname, ".env");
const DB_PATH = path.join(__dirname, "queue.db");

// --- Config helpers ---

const loadJsonConfig = () => {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) || {};
    } catch (error) {
      console.error("[Bridge] Gagal parse config.json", error.message);
    }
  }
  return {};
};

const envVal = (key, fallback = undefined) => process.env[key] ?? fallback;

const loadConfig = () => {
  const fileConfig = loadJsonConfig();
  return {
    wsPort: parseInt(envVal("BRIDGE_PORT", fileConfig.wsPort || 1818), 10),
    panelPort: parseInt(envVal("PANEL_PORT", fileConfig.panelPort || 3008), 10),
    printer: {
      driver: (
        envVal("PRINTER_DRIVER", fileConfig.printer?.driver || "network") || ""
      )
        .toLowerCase()
        .replace("rfcomm", "bluetooth"),
      address: envVal(
        "PRINTER_ADDRESS",
        fileConfig.printer?.address || "127.0.0.1"
      ),
      bluetoothChannel: parseInt(
        envVal("PRINTER_BT_CHANNEL", fileConfig.printer?.bluetoothChannel || 1),
        10
      ),
      usb: {
        vendorId: envVal(
          "PRINTER_USB_VENDOR_ID",
          fileConfig.printer?.usb?.vendorId || ""
        ),
        productId: envVal(
          "PRINTER_USB_PRODUCT_ID",
          fileConfig.printer?.usb?.productId || ""
        ),
      },
      bluetoothAddress: envVal(
        "PRINTER_BT_ADDRESS",
        fileConfig.printer?.bluetoothAddress || ""
      ),
      encoding: envVal(
        "PRINTER_ENCODING",
        fileConfig.printer?.encoding || "GB18030"
      ),
    },
  };
};

let config = loadConfig();

const normalizeHex = (value) => {
  if (!value) return "";
  return String(value).trim().replace(/^0x/i, "").toLowerCase();
};

const buildNextConfig = (payload = {}) => {
  const printerPayload = payload.printer || payload;
  const usbPayload = printerPayload.usb || {};

  const nextDriver = (
    printerPayload.driver ??
    config.printer.driver ??
    "network"
  )
    .toLowerCase()
    .replace("rfcomm", "bluetooth");

  return {
    ...config,
    wsPort: Number(payload.wsPort) || config.wsPort,
    printer: {
      ...config.printer,
      driver: nextDriver,
      encoding: printerPayload.encoding ?? config.printer.encoding,
      address: printerPayload.address ?? config.printer.address,
      bluetoothChannel:
        parseInt(
          printerPayload.bluetoothChannel ??
            printerPayload.btChannel ??
            config.printer.bluetoothChannel ??
            1,
          10
        ) || 1,
      usb: {
        vendorId:
          normalizeHex(
            usbPayload.vendorId ??
              printerPayload.usbVendorId ??
              config.printer.usb.vendorId
          ) || config.printer.usb.vendorId,
        productId:
          normalizeHex(
            usbPayload.productId ??
              printerPayload.usbProductId ??
              config.printer.usb.productId
          ) || config.printer.usb.productId,
      },
      bluetoothAddress:
        printerPayload.bluetoothAddress ?? config.printer.bluetoothAddress,
    },
  };
};

const scheduleRestart = () => {
  console.info("[Bridge] Menyimpan konfigurasi baru, bridge akan restart.");
  setTimeout(() => {
    process.exit(0);
  }, 800);
};

const persistConfig = (nextConfig) => {
  config = nextConfig;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  const envTemplate = {
    BRIDGE_PORT: String(config.wsPort),
    PRINTER_DRIVER: config.printer.driver,
    PRINTER_ADDRESS: config.printer.address,
    PRINTER_USB_VENDOR_ID: config.printer.usb.vendorId,
    PRINTER_USB_PRODUCT_ID: config.printer.usb.productId,
    PRINTER_BT_ADDRESS: config.printer.bluetoothAddress,
    PRINTER_BT_CHANNEL: config.printer.bluetoothChannel || 1,
    PRINTER_ENCODING: config.printer.encoding,
  };
  const envLines = Object.entries(envTemplate).map(
    ([k, v]) => `${k}=${v ?? ""}`
  );
  fs.writeFileSync(ENV_PATH, envLines.join("\n"));
};

// --- Queue (SQLite) ---
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

const genId = () =>
  `job_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
let processing = false;
const pendingPrintResponses = new Map();

const enqueueJob = (payload, requestId, ws) => {
  return new Promise((resolve, reject) => {
    const id = genId();
    const stmt = db.prepare(
      "INSERT INTO jobs (id, payload, status, attempts) VALUES (?, ?, ?, 0)"
    );
    stmt.run(id, JSON.stringify(payload), "pending", (err) => {
      if (err) {
        return reject(err);
      }
      stmt.finalize();
      pendingPrintResponses.set(id, { ws, requestId });
      processQueue();
      resolve(id);
    });
  });
};

const updateJob = (id, fields) => {
  const setParts = [];
  const values = [];
  Object.entries(fields).forEach(([key, val]) => {
    setParts.push(`${key} = ?`);
    values.push(val);
  });
  values.push(id);
  db.run(
    `UPDATE jobs SET ${setParts.join(
      ", "
    )}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    values
  );
};

const fetchNextJob = () =>
  new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM jobs WHERE status = "pending" ORDER BY created_at ASC LIMIT 1',
      (err, row) => {
        if (err) return reject(err);
        resolve(row);
      }
    );
  });

const processQueue = async () => {
  if (processing) return;
  processing = true;
  console.log("[Bridge] Queue processor woke up, processing flag:", processing);
  try {
    const job = await fetchNextJob();
    console.log("[Bridge] Next job:", job?.id ?? "none");
    if (!job) {
      processing = false;
      return;
    }
    const payload = JSON.parse(job.payload || "{}");
    try {
      await printPayload(payload);
      updateJob(job.id, { status: "done", error: null });
      console.info("[Bridge] Job selesai", job.id);
      sendPrintResult(job.id, "done", "Struk berhasil dikirim.");
    } catch (error) {
      const attempts = (job.attempts || 0) + 1;
      const status = attempts >= 3 ? "failed" : "pending";
      updateJob(job.id, { status, attempts, error: error.message });
      console.error("[Bridge] Job gagal", job.id, error.message);
      sendPrintResult(job.id, "error", error.message);
    }
  } catch (error) {
    console.error("[Bridge] Gagal memproses queue", error.message);
  }
  processing = false;
  setTimeout(processQueue, 200);
};

const sendPrintResult = (jobId, status, message) => {
  const entry = pendingPrintResponses.get(jobId);
  if (!entry) {
    return;
  }
  sendWs(entry.ws, {
    type: "print-result",
    jobId,
    requestId: entry.requestId,
    status,
    message,
  });
  pendingPrintResponses.delete(jobId);
};

const getJobStats = () =>
  new Promise((resolve) => {
    db.all(
      "SELECT status, COUNT(*) as total FROM jobs GROUP BY status",
      (err, rows) => {
        if (err) {
          resolve({ pending: 0, failed: 0, done: 0 });
          return;
        }
        const base = { pending: 0, failed: 0, done: 0 };
        rows.forEach((row) => {
          base[row.status] = row.total;
        });
        resolve(base);
      }
    );
  });

const checkPrinterConnection = () =>
  new Promise((resolve) => {
    let device;
    try {
      device = createDevice();
    } catch (error) {
      resolve({ connected: false, message: error.message });
      return;
    }

    device.open((error) => {
      if (error) {
        resolve({ connected: false, message: error.message });
        return;
      }

      device.close(() => resolve({ connected: true, message: "Printer siap" }));
    });
  });

const parseBtScan = (raw) => {
  const lines = raw.split("\n");
  const devices = [];
  lines.forEach((line) => {
    const match = line.match(/Device ([0-9A-F:]{17}) (.+)$/);
    if (match) {
      devices.push({ address: match[1], name: match[2] });
    }
  });
  return devices;
};

const parseUsbScan = (raw) => {
  const lines = raw.split("\n");
  const devices = [];
  lines.forEach((line) => {
    const match = line.match(/ID ([0-9a-fA-F]{4}):([0-9a-fA-F]{4})\s*(.*)$/);
    if (match) {
      devices.push({
        vendorId: match[1].toLowerCase(),
        productId: match[2].toLowerCase(),
        name: (match[3] || "").trim(),
      });
    }
  });
  return devices;
};

const bindRfcommDevice = (address, channel = 1) => {
  if (!address) {
    throw new Error("Alamat bluetooth belum diset.");
  }
  const ch = Number(channel || 1);
  execSync("rfcomm release 0 || true");
  execSync(`rfcomm bind 0 ${address} ${ch}`);
  return { address, channel: ch, device: "/dev/rfcomm0" };
};

// --- Printer helpers ---
const createDevice = () => {
  const driver = (config.printer.driver || "").toLowerCase();
  console.log("[Bridge] createDevice -> driver selected:", driver);
  if (driver === "usb") {
    const vid = config.printer.usb.vendorId;
    const pid = config.printer.usb.productId;
    console.log(`[Bridge] Using VID: ${vid}, PID: ${pid}`);
    if (!vid || !pid) {
      throw new Error("VendorID/ProductID USB belum diset.");
    }
    const vidInt = parseInt(vid, 16);
    const pidInt = parseInt(pid, 16);
    if (isNaN(vidInt) || isNaN(pidInt)) {
      throw new Error(`VendorID/ProductID USB tidak valid: ${vid}/${pid}`);
    }
    console.log("[Bridge] USB device created");
    return new escpos.USB(vidInt, pidInt);
  }

  if (driver === "bluetooth") {
    const addr = config.printer.bluetoothAddress;
    if (!addr) {
      throw new Error("Alamat bluetooth belum diset.");
    }
    const channel = Number(config.printer.bluetoothChannel || 1);
    try {
      const info = bindRfcommDevice(addr, channel);
      console.log(
        "[Bridge] RFCOMM bound to",
        info.device,
        "for",
        info.address,
        "channel",
        info.channel
      );
    } catch (error) {
      console.error(
        "[Bridge] Gagal binding RFCOMM, pastikan rfcomm tersedia:",
        error.message
      );
    }
    if (!fs.existsSync("/dev/rfcomm0")) {
      throw new Error(
        "RFCOMM belum tersedia. Jalankan: sudo rfcomm bind 0 " +
          addr +
          " " +
          channel
      );
    }
    console.log("[Bridge] Using serial /dev/rfcomm0 (RFCOMM)");
    return new escpos.Serial("/dev/rfcomm0", {
      autoOpen: false,
      lock: false,
      baudRate: 9600,
    });
  }

  if (driver === "network") {
    if (!config.printer.address) {
      throw new Error("Alamat printer jaringan belum diset.");
    }
    console.log("[Bridge] Network device created for", config.printer.address);
    return new escpos.Network(config.printer.address);
  }

  throw new Error(`Driver tidak dikenal: ${driver}`);
};

const formatReceipt = (payload) => {
  const lines = [];
  const divider = "-".repeat(32);

  lines.push(payload.header?.title || "HADE STORE");
  if (payload.header?.address) lines.push(payload.header.address);
  if (payload.header?.phone) lines.push(`Telp: ${payload.header.phone}`);
  lines.push(divider);

  lines.push(`No: ${payload.meta?.invoice || "-"}`);
  lines.push(`Tgl: ${payload.meta?.date || "-"}`);
  lines.push(`Kasir: ${payload.meta?.cashier || "-"}`);
  lines.push(divider);

  (payload.items || []).forEach((item) => {
    lines.push(item.name);
    lines.push(`${item.qty} x ${item.price} = ${item.subtotal}`);
  });

  lines.push(divider);
  lines.push(`Subtotal : ${payload.totals?.subtotal || 0}`);
  if (payload.totals?.discount) {
    lines.push(`Diskon   : -${payload.totals.discount}`);
  }
  lines.push(`TOTAL    : ${payload.totals?.total || 0}`);
  lines.push(
    `Bayar (${payload.meta?.payment_method || "-"}) : ${
      payload.totals?.paid || 0
    }`
  );
  lines.push(`Kembali  : ${payload.totals?.change || 0}`);
  lines.push(divider);
  lines.push(payload.footer?.thanks || "Terima kasih!");
  if (payload.footer?.note) lines.push(payload.footer.note);

  return lines.join("\n");
};

const makeTestPayload = () => ({
  header: {
    title: "HaDe Test Printer",
    address: "Bandung",
    phone: "0896-000-PRINT",
  },
  meta: {
    invoice: `TEST-${Date.now()}`,
    date: new Date().toLocaleString(),
    cashier: "Kasir",
    payment_method: "test",
  },
  items: [
    {
      name: "Produk Uji",
      qty: "1 pcs",
      price: "Rp 0",
      subtotal: "Rp 0",
    },
  ],
  totals: {
    subtotal: "Rp 0",
    total: "Rp 0",
    paid: "Rp 0",
    change: "Rp 0",
  },
  footer: {
    thanks: "Tes cetak via bridge WS.",
  },
});

const printPayload = (payload) => {
  return new Promise((resolve, reject) => {
    const device = createDevice();
    const printer = new escpos.Printer(device, {
      encoding: config.printer.encoding,
    });
    const text = formatReceipt(payload);
    const logoPath = path.join(__dirname, "logo.jpg");

    device.open((deviceError) => {
      if (deviceError) {
        return reject(deviceError);
      }

      const printLogic = (logo) => {
        try {
          printer.align("ct");

          if (logo) {
            console.log("[Bridge] Mencetak logo...");
            printer.image(logo, "d24");
          } else {
            console.log(
              "[Bridge] logo.jpg tidak ditemukan, lanjut cetak teks."
            );
          }

          console.log("[Bridge] Mencetak struk...");
          // console.log("[Bridge] Receipt payload:", text.replace(/\n/g, " | "));
          printer
            .text(text)
            .cut()
            .close((closeErr) => {
              if (closeErr) return reject(closeErr);
              console.log("[Bridge] Perintah cetak terkirim, koneksi ditutup.");
              resolve();
            });
        } catch (printErr) {
          reject(printErr);
        }
      };

      if (fs.existsSync(logoPath)) {
        escpos.Image.load(logoPath, (image) => {
          printLogic(image);
        });
      } else {
        printLogic(null);
      }
    });
  });
};

const openCashDrawer = () => {
  return new Promise((resolve, reject) => {
    const device = createDevice();
    const printer = new escpos.Printer(device, {
      encoding: config.printer.encoding,
    });

    device.open((deviceError) => {
      if (deviceError) {
        return reject(deviceError);
      }

      try {
        printer.drawer().close((closeErr) => {
          if (closeErr) return reject(closeErr);
          console.log(
            "[Bridge] Perintah buka drawer terkirim, koneksi ditutup."
          );
          resolve();
        });
      } catch (drawerErr) {
        reject(drawerErr);
      }
    });
  });
};

// --- WebSocket server ---
const wss = new WebSocketServer({ port: config.wsPort });
console.info(
  `[Bridge] WebSocket server running on ws://0.0.0.0:${config.wsPort}`
);
console.info(`[Bridge] Printer driver: ${config.printer.driver}`);

const baseConsole = {
  log: console.log.bind(console),
  error: console.error.bind(console),
  warn: console.warn.bind(console),
};

const sendWs = (ws, data) => {
  if (!ws || typeof ws.send !== "function") {
    return;
  }
  try {
    ws.send(JSON.stringify(data));
  } catch (error) {
    console.error("[Bridge] Gagal kirim pesan ke client", error.message);
  }
};

const broadcastLog = (message) => {
  baseConsole.log("[Bridge] LOG:", message);
  if (!wss?.clients) {
    return;
  }
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: "log", message }));
    }
  });
};

console.log = (...args) => {
  baseConsole.log(...args);
  broadcastLog(args.join(" "));
};
console.error = (...args) => {
  baseConsole.error(...args);
  broadcastLog(args.join(" "));
};
console.warn = (...args) => {
  baseConsole.warn(...args);
  broadcastLog(args.join(" "));
};

wss.on("connection", (ws, req) => {
  console.info("[Bridge] Client connected", req?.socket?.remoteAddress);
  sendWs(ws, { type: "hello", message: "Printer bridge siap mencetak." });

  ws.on("message", async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (error) {
      console.error("[Bridge] Payload bukan JSON", error.message);
      sendWs(ws, { type: "error", message: "Payload harus JSON." });
      return;
    }

    if (data.type === "ping") {
      sendWs(ws, { type: "pong", ts: Date.now() });
      return;
    }

    if (data.type === "save-config") {
      try {
        const nextConfig = buildNextConfig(data.payload || {});
        persistConfig(nextConfig);
        sendWs(ws, {
          type: "save-config-result",
          success: true,
          message: "Konfigurasi tersimpan. Bridge akan restart.",
        });
        broadcastLog("Konfigurasi bridge diperbarui via WS panel.");
        scheduleRestart();
      } catch (error) {
        console.error("[Bridge] Gagal menyimpan konfigurasi", error.message);
        sendWs(ws, {
          type: "save-config-result",
          success: false,
          message: error.message,
        });
      }
      return;
    }

    if (data.type === "get-config") {
      sendWs(ws, {
        type: "config",
        config: {
          host: config.printer.address || "127.0.0.1",
          wsPort: config.wsPort,
          driver: config.printer.driver,
          encoding: config.printer.encoding,
          usb: config.printer.usb,
          bluetoothAddress: config.printer.bluetoothAddress,
          bluetoothChannel: config.printer.bluetoothChannel,
        },
      });
      return;
    }

    if (data.type === "status") {
      const stats = await getJobStats();
      const connection = await checkPrinterConnection();
      broadcastLog(
        `[Status] connected=${connection.connected} · pending=${
          stats.pending ?? 0
        }`
      );
      sendWs(ws, {
        type: "status",
        stats,
        connection,
      });
      return;
    }

    if (data.type === "scan-usb") {
      const lsusbCmd = process.env.LSUSB_CMD || "lsusb";
      exec(lsusbCmd, { timeout: 5000 }, (error, stdout) => {
        const devices = error ? [] : parseUsbScan(stdout);
        broadcastLog(`[Scan USB] ${devices.length} device(s) discovered.`);
        sendWs(ws, {
          type: "scan-usb-result",
          devices,
          error: error ? error.message : null,
        });
      });
      return;
    }

    if (data.type === "scan-bt") {
      exec(
        "bluetoothctl --timeout 6 scan on && bluetoothctl devices",
        { timeout: 10000 },
        (error, stdout) => {
          const devices = error ? [] : parseBtScan(stdout);
          sendWs(ws, {
            type: "scan-bt-result",
            devices,
            error: error ? error.message : null,
          });
          broadcastLog(`[Scan BT] ${devices.length} device(s) discovered.`);
        }
      );
      return;
    }

    if (data.type !== "print-receipt" && data.type !== "open-drawer") {
      sendWs(ws, { type: "error", message: "Tipe tidak dikenali." });
      return;
    }

    // Handle open-drawer command
    if (data.type === "open-drawer") {
      try {
        await openCashDrawer();
        sendWs(ws, {
          type: "drawer-result",
          status: "success",
          message: "Cash drawer terbuka.",
        });
        broadcastLog("[Drawer] Cash drawer dibuka.");
        console.log("[Bridge] Cash drawer command executed");
      } catch (error) {
        console.error("[Bridge] Gagal membuka drawer", error.message);
        sendWs(ws, {
          type: "drawer-result",
          status: "error",
          message: error.message,
        });
        broadcastLog(`[Drawer] Gagal: ${error.message}`);
      }
      return;
    }

    const requestId = data.requestId ?? genId();
    try {
      const jobId = await enqueueJob(data.payload || {}, requestId, ws);
      sendWs(ws, { type: "print-queued", jobId, requestId });
    } catch (error) {
      console.error("[Bridge] Cetak gagal", error.message);
      sendWs(ws, {
        type: "print-result",
        status: "error",
        message: error.message,
        requestId,
      });
    }
  });

  ws.on("close", () => {
    console.info("[Bridge] Client disconnected");
  });
});

processQueue();

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

app.get("/panel", (_req, res) => {
  res.send(renderPanelPage());
});

app.get("/panel/api/config", (_req, res) => {
  res.json({
    wsPort: config.wsPort,
    printer: config.printer,
  });
});

app.post("/panel/api/config", (req, res) => {
  try {
    const payload = req.body || {};
    const nextConfig = buildNextConfig({
      printer: payload.printer ?? payload,
    });
    persistConfig(nextConfig);
    res.json({
      success: true,
      message: "Konfigurasi disimpan. Bridge restart...",
    });
    scheduleRestart();
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/panel/api/status", async (_req, res) => {
  try {
    const stats = await getJobStats();
    const connection = await checkPrinterConnection();
    res.json({ stats, connection });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/panel/api/scan-usb", (_req, res) => {
  const lsusbCmd = process.env.LSUSB_CMD || "lsusb";
  exec(lsusbCmd, { timeout: 5000 }, (error, stdout) => {
    const devices = error ? [] : parseUsbScan(stdout);
    res.json({ devices, error: error ? error.message : null });
  });
});

app.get("/panel/api/scan-bt", (_req, res) => {
  exec(
    "bluetoothctl --timeout 6 scan on && bluetoothctl devices",
    { timeout: 10000 },
    (error, stdout) => {
      const devices = error ? [] : parseBtScan(stdout);
      res.json({ devices, error: error ? error.message : null });
    }
  );
});

app.post("/panel/api/print", async (_req, res) => {
  try {
    const jobId = await enqueueJob(makeTestPayload());
    res.json({ jobId, message: "Struk tes dikirim" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/panel/api/rfcomm-bind", (req, res) => {
  try {
    const info = bindRfcommDevice(
      req.body?.address || config.printer.bluetoothAddress,
      req.body?.channel || config.printer.bluetoothChannel || 1
    );
    broadcastLog(
      `[RFCOMM] Bound ${info.address} ch${info.channel} -> ${info.device}`
    );
    res.json({ success: true, ...info });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(config.panelPort, () => {
  console.info(
    `[Bridge] Web panel running on http://0.0.0.0:${config.panelPort}/panel`
  );
});

const renderPanelPage = () => `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="utf-8" />
    <title>Thermal Bridge Control</title>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>
        :root {
            font-family: "Inter", system-ui, sans-serif;
            background: #ff2800;
            color: #fff;
        }
        body {
            margin: 0;
            min-height: 100vh;
            background: linear-gradient(135deg, #ff2800, #b30000);
        }
        .panel {
            max-width: 900px;
            margin: 0 auto;
            padding: 32px;
        }
        .card {
            background: rgba(0, 0, 0, 0.35);
            border-radius: 16px;
            padding: 24px;
            margin-bottom: 24px;
            border: 1px solid rgba(255,255,255,0.2);
        }
        .card h2 {
            margin-top: 0;
            margin-bottom: 12px;
        }
        label {
            display: block;
            font-size: 0.85rem;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: rgba(255,255,255,0.8);
            margin-bottom: 6px;
        }
        input, select {
            width: 100%;
            padding: 10px 12px;
            border-radius: 10px;
            border: 1px solid rgba(255,255,255,0.4);
            background: rgba(0,0,0,0.4);
            color: #fff;
            font-size: 0.95rem;
            box-sizing: border-box;
        }
        button {
            background: #ffe600;
            color: #000;
            border: none;
            padding: 12px 18px;
            border-radius: 999px;
            font-weight: 600;
            cursor: pointer;
        }
        button.secondary {
            background: transparent;
            border: 1px solid rgba(255,255,255,0.6);
            color: #fff;
        }
        .row {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 16px;
        }
        .status {
            font-size: 0.9rem;
            margin-top: 12px;
            color: rgba(255,255,255,0.8);
        }
        .badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 6px 14px;
            border-radius: 999px;
            background: rgba(255,255,255,0.2);
        }
        .list {
            margin-top: 10px;
            font-size: 0.85rem;
        }
        .list button {
            width: 100%;
            margin-top: 6px;
            text-align: left;
            background: rgba(255,255,255,0.08);
            color: #fff;
            border: 1px solid rgba(255,255,255,0.1);
        }
    </style>
</head>
<body>
    <div class="panel">
        <div class="card">
            <h2>Konfigurasi Printer</h2>
            <div class="row">
                <div>
                    <label>Driver</label>
                    <select id="driver">
                        <option value="network">Network</option>
                        <option value="usb">USB</option>
                        <option value="bluetooth">Bluetooth (RFCOMM)</option>
                    </select>
                </div>
                <div>
                    <label>Encoding</label>
                    <input id="encoding" />
                </div>
            </div>
            <div class="row" style="margin-top:12px;">
                <div>
                    <label>Alamat / IP</label>
                    <input id="address" />
                </div>
                <div>
                    <label>USB Vendor ID</label>
                    <input id="usbVendor" />
                </div>
            </div>
            <div class="row" style="margin-top:12px;">
                <div>
                    <label>USB Product ID</label>
                    <input id="usbProduct" />
                </div>
                <div>
                    <label>Bluetooth Address</label>
                    <input id="btAddress" />
                </div>
            </div>
            <div class="row" style="margin-top:12px;">
                <div>
                    <label>Bluetooth RFCOMM Channel</label>
                    <input id="btChannel" type="number" min="1" max="30" />
                </div>
                <div></div>
            </div>
            <div class="row" style="margin-top:16px; align-items:center;">
                <button id="saveConfig">Simpan Konfigurasi</button>
                <span id="saveFeedback" class="status"></span>
            </div>
        </div>

        <div class="card">
            <h2>Status & Tes</h2>
            <p class="status">Hubungkan ke bridge via WebSocket dan pantau status koneksi/queue.</p>
            <div class="row">
                <div>
                    <label>Status Koneksi</label>
                    <div class="badge" id="statusBadge">Disconnected</div>
                </div>
                <div>
                    <label>Output</label>
                    <div class="status" id="statusText">-</div>
                </div>
            </div>
            <div class="row" style="margin-top:12px;">
                <div>
                    <label>Pendings</label>
                    <div id="statusStats">Pending: 0 · Failed: 0 · Done: 0</div>
                </div>
                <div style="display:flex; gap:12px; align-items:flex-end;">
                    <button class="secondary" id="refreshStatus">Refresh Status</button>
                    <button class="secondary" id="testPrint">Tes Cetak</button>
                    <button class="secondary" id="bindRfcomm">Bind RFCOMM</button>
                </div>
            </div>
        </div>

        <div class="card">
            <h2>Scan & Helper</h2>
            <div class="row">
                <button class="secondary" data-scan="usb">Scan USB</button>
                <button class="secondary" data-scan="bt">Scan Bluetooth</button>
            </div>
            <div class="row" style="margin-top:12px;">
                <div>
                    <label>Hasil USB</label>
                    <div class="list" id="usbResults">-</div>
                </div>
                <div>
                    <label>Hasil Bluetooth</label>
                    <div class="list" id="btResults">-</div>
                </div>
            </div>
        </div>
        <div class="card">
            <h2>Log Server</h2>
            <div class="list" id="logList">
                <div>-</div>
            </div>
        </div>
    </div>
    <script>
        (() => {
            const api = "/panel/api";
            const sel = (id) => document.getElementById(id);
            const logList = sel("logList");
            const elements = {
                driver: sel("driver"),
                encoding: sel("encoding"),
                address: sel("address"),
                usbVendor: sel("usbVendor"),
                usbProduct: sel("usbProduct"),
                btAddress: sel("btAddress"),
                btChannel: sel("btChannel"),
                bindRfcomm: sel("bindRfcomm"),
                saveFeedback: sel("saveFeedback"),
                statusBadge: sel("statusBadge"),
                statusText: sel("statusText"),
                statusStats: sel("statusStats"),
                saveButton: sel("saveConfig"),
                refreshStatus: sel("refreshStatus"),
                testPrint: sel("testPrint"),
                usbResults: sel("usbResults"),
                btResults: sel("btResults"),
            };

            const fillList = (container, devices, onSelect) => {
                if (!container) return;
                if (!devices.length) {
                    container.innerHTML = "<div>-</div>";
                    return;
                }
                container.innerHTML = "";
                devices.forEach((device) => {
                    const button = document.createElement("button");
                    button.type = "button";
                    button.className =
                        "w-full text-left rounded-lg border border-base-200 px-3 py-2 hover:bg-base-200";
                    button.innerHTML = device.name
                        ? device.name + " (" + (device.address || "") + ")"
                        : device.address || "Unknown";
                    button.addEventListener("click", () => {
                        onSelect?.(device);
                    });
                    container.appendChild(button);
                });
            };

            const fetchConfig = async () => {
                const response = await fetch(api + "/config");
                const payload = await response.json();
                const cfg = payload.printer;
                elements.driver.value = cfg.driver;
                elements.encoding.value = cfg.encoding;
                elements.address.value = cfg.address;
                elements.usbVendor.value = cfg.usb?.vendorId ?? "";
                elements.usbProduct.value = cfg.usb?.productId ?? "";
                elements.btAddress.value = cfg.bluetoothAddress ?? "";
                elements.btChannel.value = cfg.bluetoothChannel ?? 1;
            };

            const updateStatus = async () => {
                try {
                    const res = await fetch(api + "/status");
                    const { connection, stats } = await res.json();
                    const connected = (connection?.connected ?? false);
                    elements.statusBadge.textContent = connected ? "Connected" : "Disconnected";
                    elements.statusText.textContent = connection?.message ?? "Status diperbarui.";
                    elements.statusStats.textContent =
                        "Pending: " +
                        (stats.pending ?? 0) +
                        " · Failed: " +
                        (stats.failed ?? 0) +
                        " · Done: " +
                        (stats.done ?? 0);
                } catch (error) {
                    elements.statusText.textContent = error.message;
                }
            };

            const saveConfig = async () => {
                elements.saveFeedback.textContent = "Menyimpan...";
                try {
                    const payload = {
                        printer: {
                            driver: elements.driver.value,
                            encoding: elements.encoding.value,
                            address: elements.address.value,
                            usb: {
                                vendorId: elements.usbVendor.value,
                                productId: elements.usbProduct.value,
                            },
                        bluetoothAddress: elements.btAddress.value,
                        bluetoothChannel: Number(elements.btChannel.value) || 1,
                        },
                    };
                    const res = await fetch(api + "/config", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload),
                    });
                    const body = await res.json();
                    elements.saveFeedback.textContent = body.message;
                } catch (error) {
                    elements.saveFeedback.textContent = error.message;
                }
            };

            const runScan = async (type, container, onSelect) => {
                try {
                    const res = await fetch(api + "/scan-" + type);
                    const payload = await res.json();
                    fillList(container, payload.devices ?? [], onSelect);
                } catch (error) {
                    container.textContent = error.message;
                }
            };

            const appendLog = (message) => {
                if (!logList) return;
                const entry = document.createElement("div");
                entry.textContent = new Date().toLocaleTimeString() + " · " + message;
                logList.prepend(entry);
            };

            const logWsPort = ${config.wsPort};
            let logWs = null;
            const connectLogWs = () => {
                if (logWs && [0, 1].includes(logWs.readyState)) {
                    return;
                }
                if (logWs) {
                    logWs.close();
                }
                logWs = new WebSocket("ws://" + window.location.hostname + ":" + logWsPort);
                logWs.addEventListener("message", (event) => {
                    try {
                        const payload = JSON.parse(event.data);
                        if (payload.type === "log") {
                            appendLog(payload.message);
                        }
                    } catch (error) {
                        console.warn("Log parse error", error);
                    }
                });
                logWs.addEventListener("close", () => {
                    setTimeout(connectLogWs, 1000);
                });
            };

            connectLogWs();

            const bindRfcommAction = async () => {
                try {
                    const res = await fetch(api + "/rfcomm-bind", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            address: elements.btAddress.value,
                            channel: Number(elements.btChannel.value) || 1,
                        }),
                    });
                    const payload = await res.json();
                    if (payload.success === false) {
                        appendLog("Bind gagal: " + (payload.message || "unknown"));
                    } else {
                        appendLog(
                            "Bind RFCOMM OK " +
                                (payload.address || "") +
                                " ch" +
                                (payload.channel || "")
                        );
                    }
                } catch (error) {
                    appendLog("Bind error: " + error.message);
                }
            };

            elements.saveButton.addEventListener("click", saveConfig);
            elements.refreshStatus.addEventListener("click", updateStatus);
            elements.testPrint.addEventListener("click", () => {
                    fetch(api + "/print", { method: "POST", body: JSON.stringify({}) }).catch(() => {});
            });
            elements.bindRfcomm?.addEventListener("click", bindRfcommAction);
            document.querySelectorAll("[data-scan]").forEach((button) => {
                button.addEventListener("click", () => {
                    const type = button.getAttribute("data-scan");
                    const target = type === "usb" ? elements.usbResults : elements.btResults;
                    runScan(type, target, (device) => {
                        if (type === "usb") {
                            elements.usbVendor.value = device.vendorId ?? "";
                            elements.usbProduct.value = device.productId ?? "";
                        }
                        if (type === "bt") {
                            elements.btAddress.value = device.address ?? "";
                        }
                    });
                });
            });

            fetchConfig();
            updateStatus();
        })();
    </script>
</body>
</html>
`;
