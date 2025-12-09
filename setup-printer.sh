#!/bin/bash

# Thermal Printer Setup Script
# Interactive tool untuk konfigurasi printer dan udev rules

# Color codes
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Global variables
SELECTED_VID=""
SELECTED_PID=""
SELECTED_NAME=""
SELECTED_BUS=""
SELECTED_DEVICE=""
UDEV_RULE_FILE="/etc/udev/rules.d/99-thermal-printer.rules"
CONFIG_FILE="${HOME}/.hade/thermal-printer-config.sh"

# ============================================================================
# Helper Functions
# ============================================================================

log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1"
}

print_header() {
    echo ""
    echo -e "${BOLD}${CYAN}========================================${NC}"
    echo -e "${BOLD}${CYAN}  🖨️  THERMAL PRINTER SETUP WIZARD      ${NC}"
    echo -e "${BOLD}${CYAN}========================================${NC}"
    echo ""
}

print_section() {
    echo ""
    echo -e "${BOLD}[*] $1${NC}"
    echo -e "${BOLD}────────────────────────────────────────${NC}"
}

# Check if running as root
check_root() {
    if [ "$EUID" -ne 0 ]; then
        log_error "Skripnya harus dijalankan dengan sudo"
        echo "Gunakan: sudo ./setup-printer.sh"
        exit 1
    fi
}

# ============================================================================
# Step 1: Detect Available Printers
# ============================================================================

detect_printers() {
    print_section "Scanning USB Devices"
    
    log_info "Mencari printer yang terhubung..."
    echo ""
    
    local printers=()
    local index=0
    
    # Scan lsusb dengan keyword printer
    while IFS= read -r line; do
        if echo "$line" | grep -iqE "print|pos|thermal|receipt|epson|star|zebra|vpos|esc|0416|04b8|0fe6"; then
            # Extract info
            local bus=$(echo "$line" | awk '{print $2}')
            local device=$(echo "$line" | awk '{print $4}' | tr -d ':')
            local vidpid=$(echo "$line" | grep -oP '\d{4}:\d{4}' | head -1)
            local vid=$(echo "$vidpid" | cut -d: -f1)
            local pid=$(echo "$vidpid" | cut -d: -f2)
            local name=$(echo "$line" | sed 's/.*[0-9a-fA-F]\{4\}:[0-9a-fA-F]\{4\}//' | xargs)
            
            printers+=("$vid:$pid|$name|$bus|$device")
            
            echo -e "  ${GREEN}[$((index + 1))${NC}] VID: ${BOLD}${vid}${NC} PID: ${BOLD}${pid}${NC}"
            echo -e "      Nama: ${BLUE}${name}${NC}"
            echo -e "      Bus: ${BOLD}${bus}${NC} Device: ${BOLD}${device}${NC}"
            echo ""
            
            index=$((index + 1))
        fi
    done < <(lsusb)
    
    if [ ${#printers[@]} -eq 0 ]; then
        log_warning "Tidak ada printer terdeteksi otomatis"
        echo ""
        log_info "Menampilkan SEMUA USB devices:"
        echo ""
        lsusb | nl
        echo ""
        
        # Ask user to manually input
        ask_manual_input
        return 1
    fi
    
    # Store for later use
    declare -g DETECTED_PRINTERS=("${printers[@]}")
    return 0
}

# ============================================================================
# Step 2: Let User Select Printer
# ============================================================================

select_printer() {
    if [ ${#DETECTED_PRINTERS[@]} -eq 0 ]; then
        return 1
    fi
    
    print_section "Pilih Printer"
    
    local choice
    while true; do
        echo "Masukkan nomor printer yang digunakan (1-${#DETECTED_PRINTERS[@]}):"
        echo "(atau 'manual' untuk input manual VID:PID)"
        echo ""
        read -p "Pilihan: " choice
        
        if [ "$choice" = "manual" ]; then
            ask_manual_input
            return 0
        fi
        
        # Validate input
        if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le ${#DETECTED_PRINTERS[@]} ]; then
            local selected_index=$((choice - 1))
            local printer_data="${DETECTED_PRINTERS[$selected_index]}"
            
            # Parse printer data (format: VID:PID|name|bus|device)
            IFS='|' read -r vidpid SELECTED_NAME SELECTED_BUS SELECTED_DEVICE <<< "$printer_data"
            SELECTED_VID=$(echo "$vidpid" | cut -d: -f1)
            SELECTED_PID=$(echo "$vidpid" | cut -d: -f2)
            
            echo ""
            log_success "Printer dipilih:"
            echo "  VID: ${BOLD}${SELECTED_VID}${NC}"
            echo "  PID: ${BOLD}${SELECTED_PID}${NC}"
            echo "  Nama: ${BLUE}${SELECTED_NAME}${NC}"
            echo ""
            return 0
        fi
        
        log_error "Input tidak valid"
        echo ""
    done
}

# ============================================================================
# Manual Input for VID/PID
# ============================================================================

ask_manual_input() {
    print_section "Input VID & PID Manual"
    
    while true; do
        read -p "Masukkan Vendor ID (VID) [4 hex chars]: " SELECTED_VID
        if [[ "$SELECTED_VID" =~ ^[0-9a-fA-F]{4}$ ]]; then
            break
        fi
        log_error "Format VID tidak valid (gunakan 4 karakter hexadecimal)"
    done
    
    while true; do
        read -p "Masukkan Product ID (PID) [4 hex chars]: " SELECTED_PID
        if [[ "$SELECTED_PID" =~ ^[0-9a-fA-F]{4}$ ]]; then
            break
        fi
        log_error "Format PID tidak valid (gunakan 4 karakter hexadecimal)"
    done
    
    read -p "Nama printer (optional): " SELECTED_NAME
    SELECTED_NAME="${SELECTED_NAME:-Unknown Printer}"
    
    echo ""
    log_success "Input manual diterima:"
    echo "  VID: ${BOLD}${SELECTED_VID}${NC}"
    echo "  PID: ${BOLD}${SELECTED_PID}${NC}"
    echo "  Nama: ${BLUE}${SELECTED_NAME}${NC}"
    echo ""
}

# ============================================================================
# Step 3: Generate and Apply udev Rules
# ============================================================================

generate_udev_rule() {
    print_section "Konfigurasi udev Rules"
    
    # Convert to lowercase for display
    local vid_lower=$(echo "$SELECTED_VID" | tr '[:upper:]' '[:lower:]')
    local pid_lower=$(echo "$SELECTED_PID" | tr '[:upper:]' '[:lower:]')
    
    log_info "Membuat udev rule untuk printer..."
    echo ""
    
    # Create udev rule content
    local udev_content="# Thermal Printer - ${SELECTED_NAME}
# Generated by setup-printer.sh
# VID: ${SELECTED_VID} PID: ${SELECTED_PID}

# Rule 1: Direct device access (lp group)
SUBSYSTEMS==\"usb\", ATTRS{idVendor}==\"${vid_lower}\", ATTRS{idProduct}==\"${pid_lower}\", \
    MODE=\"0666\", GROUP=\"lp\", SYMLINK+=\"thermal-printer-%n\"

# Rule 2: Thermal printer interface
SUBSYSTEMS==\"usb\", ATTRS{idVendor}==\"${vid_lower}\", ATTRS{idProduct}==\"${pid_lower}\", \
    KERNEL==\"lp*\", NAME=\"thermal-printer\", MODE=\"0666\"

# Rule 3: Generic usblp device
SUBSYSTEMS==\"usb\", ATTRS{idVendor}==\"${vid_lower}\", ATTRS{idProduct}==\"${pid_lower}\", \
    KERNEL==\"usb*\", MODE=\"0666\", GROUP=\"plugdev\"
"
    
    echo -e "${CYAN}${udev_content}${NC}"
    echo ""
}

apply_udev_rule() {
    print_section "Apply udev Rules"
    
    # Convert to lowercase
    local vid_lower=$(echo "$SELECTED_VID" | tr '[:upper:]' '[:lower:]')
    local pid_lower=$(echo "$SELECTED_PID" | tr '[:upper:]' '[:lower:]')
    
    # Create the udev rule file
    cat > "$UDEV_RULE_FILE" << EOF
# Thermal Printer - ${SELECTED_NAME}
# Generated by setup-printer.sh
# VID: ${SELECTED_VID} PID: ${SELECTED_PID}

# Rule 1: Direct device access (lp group)
SUBSYSTEMS=="usb", ATTRS{idVendor}=="${vid_lower}", ATTRS{idProduct}=="${pid_lower}", \\
    MODE="0666", GROUP="lp", SYMLINK+="thermal-printer-%n"

# Rule 2: Thermal printer interface
SUBSYSTEMS=="usb", ATTRS{idVendor}=="${vid_lower}", ATTRS{idProduct}=="${pid_lower}", \\
    KERNEL=="lp*", NAME="thermal-printer", MODE="0666"

# Rule 3: Generic usblp device
SUBSYSTEMS=="usb", ATTRS{idVendor}=="${vid_lower}", ATTRS{idProduct}=="${pid_lower}", \\
    KERNEL=="usb*", MODE="0666", GROUP="plugdev"
EOF
    
    if [ $? -eq 0 ]; then
        log_success "udev rule file dibuat: ${UDEV_RULE_FILE}"
    else
        log_error "Gagal membuat udev rule file"
        return 1
    fi
    
    # Reload udev rules
    log_info "Reload udev rules..."
    udevadm control --reload-rules
    udevadm trigger --subsystem-match=usb
    
    if [ $? -eq 0 ]; then
        log_success "udev rules berhasil di-reload"
    else
        log_error "Gagal reload udev rules"
        return 1
    fi
    
    echo ""
    log_info "Menunggu device ditemukan kembali (5 detik)..."
    sleep 5
    
    # Check if device is accessible
    echo ""
    log_info "Verifikasi akses device..."
    verify_printer_access
}

verify_printer_access() {
    # Check using lsusb
    local vid_lower=$(echo "$SELECTED_VID" | tr '[:upper:]' '[:lower:]')
    local pid_lower=$(echo "$SELECTED_PID" | tr '[:upper:]' '[:lower:]')
    
    if lsusb | grep -q "${SELECTED_VID}:${SELECTED_PID}\|${vid_lower}:${pid_lower}"; then
        log_success "Device terdeteksi di USB: ${SELECTED_VID}:${SELECTED_PID}"
        
        # Check thermal-printer symlink
        if [ -L "/dev/thermal-printer" ]; then
            local target=$(readlink -f /dev/thermal-printer)
            log_success "Symlink device: /dev/thermal-printer -> ${target}"
        fi
        
        # Check device permissions
        if [ -c "/dev/thermal-printer" ] 2>/dev/null; then
            local perms=$(ls -l /dev/thermal-printer | awk '{print $1}')
            log_success "Device permissions: ${perms}"
        fi
    else
        log_warning "Device belum terdeteksi, coba cabut dan pasang kembali printer"
    fi
}

# ============================================================================
# Step 4: Save Configuration
# ============================================================================

save_configuration() {
    print_section "Simpan Konfigurasi"
    
    # Create config directory if not exists
    mkdir -p "$(dirname "$CONFIG_FILE")"
    
    # Save configuration
    cat > "$CONFIG_FILE" << EOF
#!/bin/bash
# Thermal Printer Configuration
# Auto-generated by setup-printer.sh

export PRINTER_VID="${SELECTED_VID}"
export PRINTER_PID="${SELECTED_PID}"
export PRINTER_NAME="${SELECTED_NAME}"
export PRINTER_DEVICE="/dev/thermal-printer"
export UDEV_RULE_FILE="${UDEV_RULE_FILE}"

# For config.json in thermal bridge
export PRINTER_USB_VENDOR_ID="${SELECTED_VID}"
export PRINTER_USB_PRODUCT_ID="${SELECTED_PID}"
EOF
    
    if [ $? -eq 0 ]; then
        log_success "Konfigurasi disimpan: ${CONFIG_FILE}"
        echo ""
        log_info "Untuk menggunakan konfigurasi ini di shell:"
        echo "  source ${CONFIG_FILE}"
        echo ""
    fi
}

# ============================================================================
# Update config.json
# ============================================================================

update_config_json() {
    print_section "Update config.json"
    
    # Find thermal bridge directory
    local bridge_dir="${HOME}/thermal-printer-bridge"
    local config_json="${bridge_dir}/config.json"
    
    if [ ! -d "$bridge_dir" ]; then
        log_warning "Thermal bridge directory tidak ditemukan: ${bridge_dir}"
        log_info "Jika thermal bridge belum diinstall, config.json akan di-skip"
        return 0
    fi
    
    # Create config.json if not exists
    if [ ! -f "$config_json" ]; then
        if [ -f "${bridge_dir}/config.example.json" ]; then
            log_info "Membuat config.json dari config.example.json..."
            cp "${bridge_dir}/config.example.json" "$config_json"
        else
            log_warning "config.example.json tidak ditemukan, membuat config.json baru..."
            cat > "$config_json" << 'EOF'
{
  "printer": {
    "type": "usb",
    "vid": "",
    "pid": ""
  }
}
EOF
        fi
    fi
    
    # Update VID & PID in config.json using jq if available, otherwise use sed
    if command -v jq &> /dev/null; then
        log_info "Updating config.json dengan jq..."
        local temp_json=$(mktemp)
        jq --arg vid "$SELECTED_VID" --arg pid "$SELECTED_PID" \
           '.printer.type = "usb" | .printer.vid = $vid | .printer.pid = $pid' \
           "$config_json" > "$temp_json"
        
        if [ $? -eq 0 ]; then
            mv "$temp_json" "$config_json"
            log_success "config.json berhasil diupdate dengan VID/PID"
        else
            rm -f "$temp_json"
            log_error "Gagal update config.json dengan jq"
            return 1
        fi
    else
        log_info "jq tidak tersedia, menggunakan sed..."
        # Backup original
        cp "$config_json" "${config_json}.backup"
        
        # Update using sed (basic JSON manipulation)
        sed -i "s/\"vid\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"vid\": \"${SELECTED_VID}\"/" "$config_json"
        sed -i "s/\"pid\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"pid\": \"${SELECTED_PID}\"/" "$config_json"
        sed -i "s/\"type\"[[:space:]]*:[[:space:]]*\"[^\"]*\"/\"type\": \"usb\"/" "$config_json"
        
        log_success "config.json berhasil diupdate (backup: ${config_json}.backup)"
    fi
    
    # Show updated config
    echo ""
    log_info "Isi config.json saat ini:"
    echo ""
    if command -v jq &> /dev/null; then
        jq '.printer' "$config_json" 2>/dev/null || cat "$config_json"
    else
        grep -A 5 '"printer"' "$config_json" || cat "$config_json"
    fi
    echo ""
    
    # Restart thermal bridge service if running
    if command -v pm2 &> /dev/null; then
        if pm2 list | grep -q "hale-thermal-bridge"; then
            log_info "Restarting thermal bridge service..."
            pm2 restart hale-thermal-bridge 2>/dev/null
            if [ $? -eq 0 ]; then
                log_success "Thermal bridge service restarted"
            else
                log_warning "Gagal restart service, silahkan restart manual: pm2 restart hale-thermal-bridge"
            fi
        fi
    fi
}

# ============================================================================
# Step 5: Show Next Steps
# ============================================================================

show_next_steps() {
    print_section "Langkah Selanjutnya"
    
    echo ""
    log_info "Konfigurasi printer selesai!"
    echo ""
    
    echo -e "${BOLD}Untuk Thermal Bridge (Node.js):${NC}"
    echo "  ✓ config.json sudah otomatis diupdate dengan VID/PID"
    echo "  ✓ Thermal bridge service sudah direstart (jika sedang berjalan)"
    echo ""
    
    echo -e "${BOLD}Atau gunakan environment variables:${NC}"
    echo "  export PRINTER_USB_VENDOR_ID=${SELECTED_VID}"
    echo "  export PRINTER_USB_PRODUCT_ID=${SELECTED_PID}"
    echo ""
    
    echo -e "${BOLD}Atau source konfigurasi:${NC}"
    echo "  source ${CONFIG_FILE}"
    echo ""
    
    echo -e "${BOLD}Untuk Verify Access:${NC}"
    echo "  lsusb | grep ${SELECTED_VID}:${SELECTED_PID}"
    echo "  ls -la /dev/thermal-printer"
    echo ""
    
    echo -e "${BOLD}Troubleshooting:${NC}"
    echo "  • Jika masih error permission, jalankan:"
    echo "    sudo usermod -a -G lp \$USER"
    echo "    sudo usermod -a -G plugdev \$USER"
    echo "  • Logout dan login ulang"
    echo ""
}

# ============================================================================
# Main Flow
# ============================================================================

main() {
    print_header
    
    check_root
    
    # Step 1: Detect printers
    if ! detect_printers; then
        log_warning "Deteksi otomatis gagal, menggunakan input manual"
    fi
    
    # Step 2: Select printer
    if ! select_printer; then
        log_error "Gagal memilih printer"
        exit 1
    fi
    
    # Step 3: Show udev rules
    generate_udev_rule
    
    # Ask confirmation
    read -p "Lanjutkan apply udev rules? (y/n): " confirm
    if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        log_warning "Setup dibatalkan"
        exit 0
    fi
    
    echo ""
    
    # Apply rules
    if ! apply_udev_rule; then
        log_error "Gagal apply udev rules"
        exit 1
    fi
    
    # Step 4: Save config
    save_configuration
    
    # Step 5: Update config.json
    update_config_json
    
    # Step 6: Show next steps
    show_next_steps
    
    log_success "Setup printer berhasil diselesaikan!"
    echo ""
}

# ============================================================================
# Script Entry Point
# ============================================================================

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    main "$@"
fi
