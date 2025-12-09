# HaDe Printer Bridge (Node + WebSocket)

Bridge ringan untuk mencetak struk POS melalui WebSocket di sisi client/outlet. Menggunakan `node-escpos` dan dapat dipakai untuk printer USB atau jaringan.

## Fitur

-   WebSocket server lokal (default `ws://127.0.0.1:1818`).
-   Antrian cetak berbasis SQLite (`queue.db`) dengan retry (3x) dan status pending/done/failed.
-   Format struk sederhana: header toko, daftar item, subtotal/total, bayar/kembali.
-   Mendukung driver `network` (TCP), `usb` (vendorId/productId), dan **opsional** `bluetooth` (pasang `escpos-bluetooth`, memerlukan dependency OS).
-   Web panel bertema merah (Ferrari) di `http://127.0.0.1:3008` untuk melihat status queue, mengelola konfigurasi/ENV, dan memindai perangkat Bluetooth (butuh akses `bluetoothctl`).
-   Scan USB via panel (panggil `lsusb`) untuk memilih VendorID:ProductID tanpa mengetik manual.

## Persiapan

1. Install Node 18+ di mesin kasir.
2. Salin berkas ini ke mesin kasir (atau `git clone`).
3. Install dependensi:
    ```bash
    npm install
    ```

### Setup Printer dengan Interactive Wizard

Gunakan script `setup-printer.sh` untuk konfigurasi printer otomatis:

```bash
sudo ./setup-printer.sh
```

Script ini akan:
- **Scan** USB devices dan deteksi printer otomatis
- **Pilih** printer dari daftar yang terdeteksi
- **Generate** udev rules yang tepat untuk device Anda
- **Apply** udev rules dan verifikasi akses
- **Simpan** konfigurasi ke `~/.hade/thermal-printer-config.sh`

Fitur:
- Deteksi otomatis printer berdasarkan keyword (thermal, pos, printer, epson, star, dll)
- Pilihan input manual jika printer tidak terdeteksi
- Generate dan apply udev rules secara otomatis (cukup `sudo`)
- Verifikasi akses device setelah konfigurasi
- Simpan config environment untuk reuse

Setelah setup selesai, konfigurasi sudah tersimpan dan siap digunakan oleh thermal bridge.

### Konfigurasi Manual

Jika tidak menggunakan wizard, salin `config.example.json` menjadi `config.json` dan sesuaikan, atau pakai ENV:

```
BRIDGE_PORT=1818
PANEL_PORT=3008
PRINTER_DRIVER=network
PRINTER_ADDRESS=192.168.18.50
PRINTER_USB_VENDOR_ID=04b8
PRINTER_USB_PRODUCT_ID=0e03
PRINTER_BT_ADDRESS=01:23:45:67:89:AB
PRINTER_ENCODING=GB18030
```

5. Jika butuh Bluetooth, pastikan dependency OS terpasang (libbluetooth-dev, python3-distutils, build-essential). Install opsional: `npm install escpos-bluetooth`.
6. Web panel menyediakan tombol **Scan** Bluetooth (`bluetoothctl --timeout 6 scan on && bluetoothctl devices`) dan **Scan** USB (`lsusb`) untuk mengisi dropdown perangkat; pilih untuk otomatis mengisi MAC (BT) atau VID/PID (USB).

## Menjalankan

```
npm start
```

Jika sukses, akan muncul log:

-   `WebSocket server running on ws://0.0.0.0:1818`
-   `Web panel running on http://0.0.0.0:3008`

## Protokol WebSocket

Kirim JSON:

```json
{
    "type": "print-receipt",
    "payload": {
        "header": {
            "title": "Outlet Cibiru",
            "address": "Jl. Raya",
            "phone": "0812"
        },
        "meta": {
            "invoice": "POS-123",
            "date": "30/11/24 09:20",
            "cashier": "Siti",
            "payment_method": "cash"
        },
        "items": [
            {
                "name": "Dada Ayam",
                "qty": "1.20 Kg",
                "price": "Rp 50.000",
                "subtotal": "Rp 60.000"
            }
        ],
        "totals": {
            "subtotal": "Rp 60.000",
            "discount": "Rp 0",
            "total": "Rp 60.000",
            "paid": "Rp 60.000",
            "change": "Rp 0"
        },
        "footer": { "thanks": "Terima kasih!", "note": "Barang sudah dicek" }
    }
}
```

Balasan:

-   `{"type":"hello"}` saat konek.
-   `{"type":"queued","jobId":"job_..."}`
-   `{"type":"error","message":"..."}` jika gagal enqueue.
-   `ping` ➜ `pong` untuk health check.

## Catatan

-   Queue disimpan di SQLite (`queue.db`). Failed akan dicoba ulang sampai 3x lalu berstatus `failed`.
-   Untuk USB di Linux, pastikan user punya akses ke device (bisa butuh aturan udev). Jika mengalami error `LIBUSB_ERROR_ACCESS`, ikuti langkah berikut untuk memperbaiki masalah udev:
    1. Salin aturan udev yang disediakan (`99-thermal-printer.rules`) ke `/etc/udev/rules.d/`:
        ```bash
        sudo cp 99-thermal-printer.rules /etc/udev/rules.d/
        ```
    2. Reload aturan udev dan trigger perubahan:
        ```bash
        sudo udevadm control --reload-rules && sudo udevadm trigger
        ```
    3. Tambahkan user ke grup `dialout` untuk akses serial/USB:
        ```bash
        sudo usermod -a -G dialout $USER
        ```
    4. Restart layanan udev:
        ```bash
        sudo systemctl restart udev
        ```
    5. Jika masih bermasalah, ubah permission device secara manual (ganti `003/053` dengan bus/device ID printer Anda):
        ```bash
        sudo chmod 666 /dev/bus/usb/003/053
        ```
    6. Logout dan login kembali atau restart sistem untuk menerapkan perubahan grup user.
-   Untuk Bluetooth, pastikan paket OS pendukung terpasang (libbluetooth-dev, python3-dev, build-essential) sebelum memasang `escpos-bluetooth`. Web panel memerlukan `bluetoothctl` yang bisa diakses user.
-   Scan USB memakai `lsusb`; pastikan utilitas ini ada di sistem. Untuk jaringan, pastikan port printer (default 9100) dapat dijangkau.
