#!/bin/bash

# Color codes
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}   🔍  PEMINDAI PRINTER USB LINUX      ${NC}"
echo -e "${BOLD}========================================${NC}"
echo ""

# Function to display printer info
print_printer_info() {
    local vid="$1"
    local pid="$2"
    local name="$3"
    
    echo -e "${GREEN}✓ PRINTER DITEMUKAN${NC}"
    echo -e "  Vendor ID (VID): ${BOLD}${vid}${NC}"
    echo -e "  Product ID (PID): ${BOLD}${pid}${NC}"
    echo -e "  Nama: ${BLUE}${name}${NC}"
    echo ""
}

# 1. Cek dengan lsusb dan parsing VID:PID
echo -e "${BOLD}[1] Scanning USB devices with lsusb...${NC}"
echo ""

found_count=0

# Grep untuk printer umum dan extract VID:PID
lsusb | while read -r line; do
    # Check if line contains common printer keywords
    if echo "$line" | grep -iqE "print|pos|thermal|receipt|epson|star|zebra|vpos|esc|0416|04b8|0fe6"; then
        # Extract Bus and Device number
        bus=$(echo "$line" | awk '{print $2}')
        dev=$(echo "$line" | awk '{print $4}' | tr -d ':')
        
        # Extract VID:PID
        vidpid=$(echo "$line" | grep -oP '\d{4}:\d{4}' | head -1)
        vid=$(echo "$vidpid" | cut -d: -f1)
        pid=$(echo "$vidpid" | cut -d: -f2)
        
        # Extract device name (everything after the VID:PID)
        name=$(echo "$line" | sed 's/.*[0-9a-fA-F]\{4\}:[0-9a-fA-F]\{4\}//' | xargs)
        
        echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        print_printer_info "$vid" "$pid" "$name"
        found_count=$((found_count + 1))
    fi
done

echo ""

# 2. Jika tidak ada yang ditemukan dengan keyword, tampilkan semua USB devices
if [ $found_count -eq 0 ]; then
    echo -e "${YELLOW}⚠️  Tidak ada printer dengan nama umum yang terdeteksi.${NC}"
    echo -e "${BOLD}[2] Menampilkan SEMUA USB devices (mungkin printer Anda ada di sini):${NC}"
    echo ""
    
    lsusb | awk -F'[: ]' '{
        for (i = 1; i <= NF; i++) {
            if ($i ~ /^[0-9a-fA-F]{4}$/ && $(i+1) ~ /^[0-9a-fA-F]{4}$/) {
                vid = $i
                pid = $(i+1)
                # Get device name (everything after VID:PID)
                name_start = index($0, vid ":" pid) + 9
                name = substr($0, name_start)
                
                # Get bus and device
                bus = $(NF-1)
                device = $NF
                
                printf "  Bus %s Device %s: VID=%s PID=%s | %s\n", bus, device, vid, pid, name
                break
            }
        }
    }'
else
    echo -e "${BOLD}[2] Informasi Konfigurasi untuk ${BLUE}Thermal Bridge${NC}:${NC}"
    echo ""
fi

echo ""

# 3. Display lsusb output in table format for reference
echo -e "${BOLD}[3] Raw lsusb output (untuk referensi):${NC}"
echo ""
lsusb | nl
echo ""

# 4. Check if any printer devices are currently connected
echo -e "${BOLD}[4] Checking printer devices...${NC}"
echo ""

if [ -d "/dev/bus/usb" ]; then
    printer_devices=$(find /dev/bus/usb -name "*" -type c 2>/dev/null | wc -l)
    echo -e "  Total USB devices found: ${BOLD}${printer_devices}${NC}"
fi

if command -v lpstat &> /dev/null; then
    echo -e "${BOLD}  CUPS Printers:${NC}"
    lpstat -p -d 2>/dev/null || echo "    (None configured)"
fi

echo ""
echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}Tips untuk thermal bridge config:${NC}"
echo -e "  • Ganti PRINTER_USB_VENDOR_ID dengan VID${NC}"
echo -e "  • Ganti PRINTER_USB_PRODUCT_ID dengan PID${NC}"
echo -e "  • Export ke .env atau simpan di config.json${NC}"
echo -e "${BOLD}========================================${NC}"
